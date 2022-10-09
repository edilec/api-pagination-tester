/**
 * api-pagination-tester -- text handling shared by every module.
 *
 * Nothing here touches the filesystem, the clock, the locale or the network.
 * Two properties carry the weight:
 *
 * 1. **Decoding is strict.** Bytes that are not UTF-8 are refused by the
 *    decoder rather than inferred from decoded text afterwards. Searching for
 *    U+FFFD cannot tell undecodable bytes apart from a file that legitimately
 *    contains a replacement character, and that confusion is how an unreadable
 *    input reports a pass.
 * 2. **Identifiers are sanitised, not only excerpts.** Record ids and cursors
 *    arrive from the scenario under test. A record id carrying U+0085 forges a
 *    whole line in a human report exactly as well as a message would, and
 *    U+202E reverses everything displayed after it. Sanitising happens on the
 *    way *out*; comparison and identity always use the raw value, so two ids
 *    that differ only in a stripped control character are still two ids.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Not `localeCompare`, and not `Intl.Collator`: both depend on ICU data that
 * differs between Node builds, so the same scenario produces a differently
 * ordered report on a different machine. `Z` (0x5A) precedes `a` (0x61) by code
 * unit while an English collator puts `a` first, and `-` (0x2D) precedes `_`
 * (0x5F) while a collator treats both as ignorable punctuation. Those
 * disagreements are pinned behaviourally in `test/determinism.test.mjs`.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Code point ranges removed from every untrusted string before it reaches
 * output. Inclusive on both ends.
 *
 * Written as numbers rather than as a regular expression of escapes, because a
 * literal control character inside a source file is a hazard of its own and an
 * escape sequence in a regex literal is one editing accident away from becoming
 * that literal character.
 *
 * - `0x00-0x1F` C0 and `0x7F` DEL -- a newline forges a report line and ESC
 *   opens a terminal escape sequence.
 * - `0x80-0x9F` C1 -- U+0085 NEL is a line break to a great many readers and
 *   U+009B is the 8-bit CSI, so it opens a control sequence with no ESC in
 *   sight.
 * - `0x2028`/`0x2029` -- the line and paragraph separators.
 * - `0x061C`, `0x200E`, `0x200F`, `0x202A-0x202E`, `0x2066-0x2069` -- all twelve
 *   characters Unicode gives the `Bidi_Control` property. U+202E RIGHT-TO-LEFT
 *   OVERRIDE reverses everything displayed after it, so a record id can be made
 *   to read as a different id entirely while the bytes say otherwise. U+061C
 *   ARABIC LETTER MARK is the quiet one of the twelve -- it only sets the
 *   direction of the neutral characters beside it -- but the claim made here,
 *   in the README and in `docs/pagination-rules.md` is the whole class, so the
 *   whole class is stripped.
 */
export const FORGEABLE_RANGES = Object.freeze([
  Object.freeze([0x0000, 0x001f]),
  Object.freeze([0x007f, 0x009f]),
  Object.freeze([0x061c, 0x061c]),
  Object.freeze([0x2028, 0x2029]),
  Object.freeze([0x200e, 0x200f]),
  Object.freeze([0x202a, 0x202e]),
  Object.freeze([0x2066, 0x2069]),
])

/** Whether a single code point is one this tool refuses to pass through. */
export function isForgeable(codePoint) {
  for (const [low, high] of FORGEABLE_RANGES) {
    if (codePoint >= low && codePoint <= high) return true
  }
  return false
}

/** Replace every forgeable character with a space. */
export function sanitize(value) {
  let out = ''
  for (const character of String(value)) {
    out += isForgeable(character.codePointAt(0)) ? ' ' : character
  }
  return out
}

export const EXCERPT_LIMIT = 160

/**
 * A bounded, single-line, sanitised excerpt.
 *
 * Used for every string that reaches output: messages, suggestions, evidence,
 * file labels, JSON pointers, cursors and record ids alike. The ellipsis is
 * three full stops rather than U+2026 so the result stays ASCII.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = sanitize(value).replace(/\s+/g, ' ').trim()
  const points = Array.from(flattened)
  if (points.length <= limit) return flattened
  return `${points.slice(0, limit).join('')}...`
}

/** How a cursor is shown to a human. The initial request carries no cursor. */
export function cursorLabel(cursor) {
  if (cursor === null) return '(initial)'
  if (cursor === '') return '(empty string)'
  return excerpt(cursor)
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point: a scenario whose bytes are not UTF-8 is
 * refused, never guessed at. `ignoreBOM: false` strips a leading byte order
 * mark, which `JSON.parse` would otherwise reject with a syntax error that
 * blames the wrong thing. Throws `TypeError` on undecodable input.
 */
export function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
}

/**
 * The part of a `JSON.parse` failure that may safely be shown.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A scenario
 * short enough to be only a credential is reproduced in full by its own error
 * message, and a longer one is reproduced ten characters at a time -- the
 * window appears as `"prefix"...`, `..."suffix"` or `..."middle"...` depending
 * on where the offending byte sits. Neither `sanitize` nor `excerpt` helps:
 * the quoted span is at the *front* of the message, so both leave it intact
 * and cut the position off the end instead.
 *
 * The quoted form carries no position, so nothing diagnostic is lost by
 * replacing it with the token alone. The other form is all position and no
 * input, and is kept verbatim. The quoted window never leaves this function.
 *
 * The quoted form is matched first on purpose: a scenario whose own bytes read
 * `at position 12` would otherwise be quoted back by the position branch.
 */
export function parseFailureDetail(error) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const token = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s.exec(message)
  if (token) {
    const where = token[2] === undefined ? ' near the start of the document' : ' in the document'
    return `unexpected token ${sanitize(token[1])}${where}`
  }
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  if (position) return message.slice(0, position.index + position[0].length)
  if (/^Unexpected end of JSON input$/.test(message)) return message
  return 'the document could not be parsed as JSON'
}
