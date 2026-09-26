import assert from 'node:assert/strict'
import test from 'node:test'

import { EXCERPT_LIMIT, byCodeUnit, cursorLabel, decodeUtf8, excerpt, isForgeable, sanitize } from '../src/text.mjs'

// Control characters are built from code points rather than written as escape
// sequences: an escape inside a source file is one editing accident away from
// becoming the literal character it names, and a literal control character in a
// test file is a hazard of its own.
const ch = (code) => String.fromCodePoint(code)

test('byCodeUnit orders by UTF-16 code unit and reports equality', () => {
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('', 'a'), -1)
})

test('sanitize replaces every forgeable class with a space', () => {
  assert.equal(sanitize(`a${ch(0x00)}b`), 'a b', 'C0 NUL')
  assert.equal(sanitize(`a${ch(0x0a)}b`), 'a b', 'C0 line feed')
  assert.equal(sanitize(`a${ch(0x1b)}b`), 'a b', 'C0 escape')
  assert.equal(sanitize(`a${ch(0x7f)}b`), 'a b', 'DEL')
  assert.equal(sanitize(`a${ch(0x85)}b`), 'a b', 'C1 NEL')
  assert.equal(sanitize(`a${ch(0x9b)}b`), 'a b', 'C1 CSI')
  assert.equal(sanitize(`a${ch(0x2028)}b`), 'a b', 'line separator')
  assert.equal(sanitize(`a${ch(0x2029)}b`), 'a b', 'paragraph separator')
  assert.equal(sanitize(`a${ch(0x061c)}b`), 'a b', 'arabic letter mark')
  assert.equal(sanitize(`a${ch(0x200e)}b`), 'a b', 'left-to-right mark')
  assert.equal(sanitize(`a${ch(0x200f)}b`), 'a b', 'right-to-left mark')
  assert.equal(sanitize(`a${ch(0x202e)}b`), 'a b', 'right-to-left override')
  assert.equal(sanitize(`a${ch(0x2066)}b`), 'a b', 'left-to-right isolate')
  assert.equal(sanitize(`a${ch(0x2069)}b`), 'a b', 'pop directional isolate')
})

test('sanitize leaves ordinary text, including the neighbour of every range, alone', () => {
  // The character immediately outside each range must survive, or the guard is
  // stripping content rather than controls. Both sides of every bound.
  for (const code of [0x20, 0x7e, 0xa0, 0x061b, 0x061d, 0x2027, 0x202f, 0x200d, 0x2010, 0x2065, 0x206a]) {
    assert.equal(sanitize(`a${ch(code)}b`), `a${ch(code)}b`, `the code point ${code} must survive sanitising`)
  }
  assert.equal(sanitize('ord-1'), 'ord-1')
  assert.equal(sanitize('after:ord-2'), 'after:ord-2')
  assert.equal(isForgeable(0x1f), true)
  assert.equal(isForgeable(0x20), false)
  assert.equal(isForgeable(0x7e), false)
  assert.equal(isForgeable(0x9f), true)
  assert.equal(isForgeable(0xa0), false)
  assert.equal(isForgeable(0x061b), false)
  assert.equal(isForgeable(0x061c), true)
  assert.equal(isForgeable(0x061d), false)
  assert.equal(isForgeable(0x2027), false)
  assert.equal(isForgeable(0x202f), false)
  assert.equal(isForgeable(0x2065), false)
  assert.equal(isForgeable(0x206a), false)
})

test('every Unicode Bidi_Control character is stripped, which is what the docs claim', () => {
  // The claim in `src/text.mjs`, in README.md and in docs/pagination-rules.md is
  // the bidirectional controls as a class, so the class is enumerated here
  // rather than sampled. U+061C is the one a sampled list forgets.
  const bidiControls = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
  assert.equal(bidiControls.length, 12, 'Unicode gives twelve characters the Bidi_Control property')
  for (const code of bidiControls) {
    assert.equal(isForgeable(code), true, `U+${code.toString(16).toUpperCase()} must be stripped`)
    assert.equal(sanitize(`a${ch(code)}b`), 'a b')
  }
})

test('excerpt collapses whitespace, trims and bounds by code point', () => {
  assert.equal(excerpt('  a   b  '), 'a b')
  assert.equal(excerpt('abcdef', 3), 'abc...')
  assert.equal(excerpt('abc', 3), 'abc', 'exactly the bound is not truncated')
  // Astral characters are one code point each, so the bound counts characters a
  // reader would count, not UTF-16 units.
  assert.equal(excerpt(`${ch(0x1f600)}${ch(0x1f600)}${ch(0x1f600)}`, 2), `${ch(0x1f600)}${ch(0x1f600)}...`)
  assert.equal(EXCERPT_LIMIT, 160)
})

test('cursorLabel tells the initial request from an empty-string cursor', () => {
  assert.equal(cursorLabel(null), '(initial)')
  assert.equal(cursorLabel(''), '(empty string)')
  assert.equal(cursorLabel('page:2'), 'page:2')
})

test('decodeUtf8 refuses bytes that are not UTF-8 instead of guessing', () => {
  assert.equal(decodeUtf8(new Uint8Array([0x61, 0x62])), 'ab')
  // 0xC3 opens a two-byte sequence that never arrives.
  assert.throws(() => decodeUtf8(new Uint8Array([0x61, 0xc3])), TypeError)
  // A lone continuation byte.
  assert.throws(() => decodeUtf8(new Uint8Array([0x80])), TypeError)
  // A file that legitimately contains U+FFFD decodes to U+FFFD and is not an
  // error: inferring "not UTF-8" from a replacement character in decoded text
  // cannot tell the two apart, which is how an unreadable input reports a pass.
  assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbf, 0xbd])), ch(0xfffd))
})

test('decodeUtf8 strips a byte order mark so JSON.parse does not blame the wrong thing', () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])
  assert.equal(decodeUtf8(withBom), '{}')
  assert.deepEqual(JSON.parse(decodeUtf8(withBom)), {})
})
