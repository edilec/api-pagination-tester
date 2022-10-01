/**
 * api-pagination-tester -- the scenario document and the in-memory mock API.
 *
 * A scenario describes an API that paginates: the complete set of record
 * identities the API is supposed to expose (`corpus`), and the exact pages it
 * serves keyed by the cursor that requests them (`pages`). The mock built from
 * it answers `fetchPage(cursor)` from a `Map`. It opens no socket, binds no
 * port and performs no I/O of any kind -- the whole point of a pagination test
 * is that the state machine is exercised, not the transport.
 *
 * Validation here is strict and total. An unknown key is refused rather than
 * ignored, because a one-character typo in `nextCursor` must not quietly turn a
 * broken pagination contract into a green run.
 */

import { excerpt, sanitize } from './text.mjs'

/**
 * The pagination styles this tool recognises, and the one it implements.
 *
 * A bounded subset, declared rather than implied. `cursor` is the style whose
 * state machine this tool models: the client sends an opaque cursor and the
 * response carries the next one. Every other style is recognised by name so the
 * report can say precisely what was not exercised -- an unsupported style makes
 * the run incomplete and is never treated as satisfied.
 */
export const SUPPORTED_STYLES = Object.freeze(['cursor'])

export const KNOWN_UNSUPPORTED_STYLES = Object.freeze({
  'link-header': 'RFC 8288 Link headers with rel="next" are not modelled; there is no transport here to carry them.',
  'offset': 'offset/limit paging is not modelled: its duplicate and skip behaviour depends on concurrent writes, which this tool does not simulate.',
  'page-number': 'page-number paging is not modelled: its duplicate and skip behaviour depends on concurrent writes, which this tool does not simulate.',
  'keyset': 'keyset (seek) paging is not modelled; its ordering key semantics are outside the bounded subset implemented here.',
})

const SCENARIO_KEYS = Object.freeze(['corpus', 'name', 'pageLimit', 'pages', 'style'])
const PAGE_KEYS = Object.freeze(['cursor', 'nextCursor', 'records'])

/**
 * A refusal to use a scenario at all.
 *
 * Carries the rule id so the caller does not have to guess which failure it
 * caught. Every one of these makes the run incomplete: the tool obtained no
 * evidence about the pagination contract, and no evidence is not a verdict.
 */
export class ScenarioError extends Error {
  constructor(ruleId, message, options = {}) {
    super(message)
    this.name = 'ScenarioError'
    this.ruleId = ruleId
    this.pointer = options.pointer ?? ''
    this.suggestion = options.suggestion
    this.evidence = options.evidence
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function refuse(message, options) {
  throw new ScenarioError('scenario-invalid', message, options)
}

/** A record id or cursor, checked for type, emptiness and the declared length bound. */
function checkId(value, pointer, limits, what) {
  if (typeof value !== 'string') {
    refuse(`${what} must be a string; this one is ${value === null ? 'null' : typeof value}.`, {
      pointer,
      suggestion: 'Record identities are compared as strings. Quote numeric ids in the scenario.',
    })
  }
  if (value === '') {
    refuse(`${what} must not be the empty string.`, {
      pointer,
      suggestion: 'Give every record a stable, non-empty identity.',
    })
  }
  if (Array.from(value).length > limits.maxIdLength) {
    throw new ScenarioError(
      'record-id-too-long',
      `${what} is longer than the maxIdLength limit of ${limits.maxIdLength} character(s), so record identity ` +
        'could not be compared reliably and no completeness verdict was reached.',
      {
        pointer,
        suggestion: 'Raise --max-id-length, or use shorter identities in the scenario.',
        evidence: excerpt(value, 60),
      },
    )
  }
}

/**
 * Validate a scenario document.
 *
 * Returns a frozen, normalised scenario. Throws `ScenarioError` for anything it
 * will not run, which the caller turns into an incomplete report. The order of
 * the checks is deliberate: the style is checked before the pages, because
 * reporting page-shaped problems in a document written for a style this tool
 * does not implement would be describing a contract nobody claimed.
 */
export function validateScenario(document, limits) {
  if (!isPlainObject(document)) {
    refuse(`The scenario must be a JSON object; this one is ${Array.isArray(document) ? 'an array' : typeof document}.`, {
      suggestion: 'See docs/pagination-rules.md for the scenario shape.',
    })
  }

  for (const key of Object.keys(document)) {
    if (!SCENARIO_KEYS.includes(key)) {
      refuse(`Unknown scenario key "${excerpt(key, 40)}".`, {
        pointer: `/${sanitize(key)}`,
        suggestion: `Known keys are ${SCENARIO_KEYS.join(', ')}. A misspelled key is refused rather than ignored.`,
      })
    }
  }

  const name = document.name === undefined ? 'scenario' : document.name
  if (typeof name !== 'string' || name.trim() === '') {
    refuse('The scenario name must be a non-empty string when it is given.', { pointer: '/name' })
  }

  const style = document.style === undefined ? 'cursor' : document.style
  if (typeof style !== 'string' || style === '') {
    refuse('The scenario style must be a non-empty string when it is given.', { pointer: '/style' })
  }
  if (!SUPPORTED_STYLES.includes(style)) {
    const known = Object.hasOwn(KNOWN_UNSUPPORTED_STYLES, style)
    throw new ScenarioError(
      'unsupported-pagination-style',
      `Pagination style "${excerpt(style, 40)}" is not implemented by this tool, so nothing about this scenario ` +
        `was exercised. ${known ? KNOWN_UNSUPPORTED_STYLES[style] : 'This style is not recognised at all.'}`,
      {
        pointer: '/style',
        suggestion: `This tool implements ${SUPPORTED_STYLES.join(', ')} only. An unsupported style is reported, never assumed to pass.`,
      },
    )
  }

  let pageLimit = null
  if (document.pageLimit !== undefined) {
    if (!Number.isInteger(document.pageLimit) || document.pageLimit < 1) {
      refuse('The declared pageLimit must be an integer of at least 1.', {
        pointer: '/pageLimit',
        suggestion: 'pageLimit is the page size the API promises, not a limit on this tool.',
      })
    }
    pageLimit = document.pageLimit
  }

  if (!Array.isArray(document.corpus)) {
    refuse('The scenario must declare a corpus array of the record identities the API is supposed to expose.', {
      pointer: '/corpus',
      suggestion: 'Without known identities a walk cannot prove completeness, which is the point of this tool.',
    })
  }
  if (document.corpus.length === 0) {
    refuse('The corpus is empty, so there is no ground truth to compare the walk against.', {
      pointer: '/corpus',
      suggestion: 'List every record the API is supposed to expose.',
    })
  }
  if (document.corpus.length > limits.maxCorpus) {
    throw new ScenarioError(
      'corpus-too-large',
      `The corpus declares ${document.corpus.length} identities, past the maxCorpus limit of ${limits.maxCorpus}. ` +
        'It was not read, so no completeness verdict was reached.',
      { pointer: '/corpus', suggestion: 'Raise --max-corpus, or split the scenario.' },
    )
  }

  const corpus = []
  const corpusSet = new Set()
  for (let index = 0; index < document.corpus.length; index += 1) {
    const id = document.corpus[index]
    checkId(id, `/corpus/${index}`, limits, 'A corpus record id')
    if (corpusSet.has(id)) {
      throw new ScenarioError(
        'corpus-duplicate-id',
        `The corpus lists the identity "${excerpt(id, 60)}" more than once, so "seen once" and "seen twice" ` +
          'cannot be told apart and no completeness verdict was reached.',
        {
          pointer: `/corpus/${index}`,
          suggestion: 'Record identities are the ground truth of this tool; make them unique.',
        },
      )
    }
    corpusSet.add(id)
    corpus.push(id)
  }

  if (!Array.isArray(document.pages)) {
    refuse('The scenario must declare a pages array describing what the mock API serves.', { pointer: '/pages' })
  }
  if (document.pages.length === 0) {
    refuse('The scenario declares no pages, so there is no API to walk.', {
      pointer: '/pages',
      suggestion: 'Declare at least the initial page, the one whose cursor is null.',
    })
  }
  if (document.pages.length > limits.maxScenarioPages) {
    throw new ScenarioError(
      'scenario-too-many-pages',
      `The scenario declares ${document.pages.length} pages, past the maxScenarioPages limit of ` +
        `${limits.maxScenarioPages}. It was not read, so nothing was exercised.`,
      { pointer: '/pages', suggestion: 'Raise --max-scenario-pages, or split the scenario.' },
    )
  }

  const pages = []
  const byCursor = new Map()
  for (let index = 0; index < document.pages.length; index += 1) {
    const page = document.pages[index]
    const at = `/pages/${index}`
    if (!isPlainObject(page)) refuse('Each page must be a JSON object.', { pointer: at })
    for (const key of Object.keys(page)) {
      if (!PAGE_KEYS.includes(key)) {
        refuse(`Unknown page key "${excerpt(key, 40)}".`, {
          pointer: `${at}/${sanitize(key)}`,
          suggestion: `Known page keys are ${PAGE_KEYS.join(', ')}.`,
        })
      }
    }
    if (!Object.hasOwn(page, 'cursor')) {
      refuse('Each page must declare the cursor that requests it, or null for the initial page.', {
        pointer: `${at}/cursor`,
      })
    }
    if (page.cursor !== null && typeof page.cursor !== 'string') {
      refuse('A page cursor must be a string, or null for the initial page.', { pointer: `${at}/cursor` })
    }
    if (typeof page.cursor === 'string' && page.cursor !== '') {
      checkId(page.cursor, `${at}/cursor`, limits, 'A page cursor')
    }
    if (byCursor.has(page.cursor)) {
      refuse(
        page.cursor === null
          ? 'Two pages declare the initial cursor null, so the first request is ambiguous.'
          : `Two pages declare the cursor "${excerpt(page.cursor, 60)}", so one request has two answers.`,
        { pointer: `${at}/cursor`, suggestion: 'A cursor addresses exactly one page.' },
      )
    }

    if (!Object.hasOwn(page, 'nextCursor')) {
      refuse(
        'Each page must declare nextCursor explicitly: a string to continue, or null for the last page. An ' +
          'absent nextCursor is exactly the ambiguity this tool exists to find.',
        { pointer: `${at}/nextCursor` },
      )
    }
    if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
      refuse('A nextCursor must be a string, or null on the last page.', { pointer: `${at}/nextCursor` })
    }
    // The length bound covers every cursor, not only the ones a page is keyed
    // by. A nextCursor no page answers is never checked anywhere else, so
    // leaving it out enforced a narrower rule than the one documented -- and
    // the dangling case is exactly where an unbounded identity arrives. The
    // empty string is exempt here as it is for `cursor`: it is the ambiguous
    // terminator this tool reports, not an identity.
    if (typeof page.nextCursor === 'string' && page.nextCursor !== '') {
      checkId(page.nextCursor, `${at}/nextCursor`, limits, 'A page nextCursor')
    }

    if (!Array.isArray(page.records)) {
      refuse('Each page must declare a records array; an empty array is a legitimate empty page.', {
        pointer: `${at}/records`,
      })
    }
    const records = []
    for (let position = 0; position < page.records.length; position += 1) {
      checkId(page.records[position], `${at}/records/${position}`, limits, 'A served record id')
      records.push(page.records[position])
    }

    const entry = Object.freeze({
      index,
      cursor: page.cursor,
      nextCursor: page.nextCursor,
      records: Object.freeze(records),
    })
    pages.push(entry)
    byCursor.set(page.cursor, entry)
  }

  if (!byCursor.has(null)) {
    refuse('No page declares the initial cursor null, so the walk has nowhere to start.', {
      pointer: '/pages',
      suggestion: 'Give the first page "cursor": null.',
    })
  }

  return Object.freeze({
    name,
    style,
    pageLimit,
    corpus: Object.freeze(corpus),
    corpusSet,
    pages: Object.freeze(pages),
  })
}

/**
 * Build the in-memory mock API.
 *
 * `fetchPage` is a pure lookup in a `Map`. No socket is opened, no port is
 * bound and no file is read: a pagination state machine is exercised by what
 * the responses say, and a transport would only add a way for the test to fail
 * for reasons that are not about pagination.
 *
 * The returned function is `async` because a caller's own in-process mock will
 * usually be, and the walker must treat both the same way.
 */
export function createMockApi(scenario) {
  const byCursor = new Map()
  for (const page of scenario.pages) byCursor.set(page.cursor, page)
  let fetches = 0
  return {
    style: scenario.style,
    get fetches() {
      return fetches
    },
    async fetchPage(cursor) {
      fetches += 1
      if (!byCursor.has(cursor)) return undefined
      const page = byCursor.get(cursor)
      return { records: [...page.records], nextCursor: page.nextCursor, declaredIndex: page.index }
    },
  }
}
