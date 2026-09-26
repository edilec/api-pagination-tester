import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, createMockApi, validateScenario, walkPages } from '../src/index.mjs'

const limits = (overrides = {}) => ({ ...DEFAULT_LIMITS, ...overrides })
const steady = () => 0

/**
 * A caller's own in-process fake: a table of responses, and nothing else.
 *
 * Keyed by a `Map` rather than by an object, because the initial request's
 * cursor is `null` and a `Map` keeps that distinct from every string cursor
 * without a sentinel that a real cursor might collide with.
 */
function fakeApi(entries) {
  const table = new Map(entries)
  let fetches = 0
  return {
    get fetches() {
      return fetches
    },
    async fetchPage(cursor) {
      fetches += 1
      return table.has(cursor) ? table.get(cursor) : undefined
    },
  }
}

const page = (records, nextCursor) => ({ records, nextCursor })

test('a walk follows cursors from the initial request to the last page', async () => {
  const api = fakeApi([
    [null, page(['a', 'b'], 'p2')],
    ['p2', page(['c'], null)],
  ])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.terminatedBy, 'last-page')
  assert.equal(result.complete, true)
  assert.deepEqual(result.requested, [null, 'p2'])
  assert.deepEqual(
    result.pages.map((entry) => [entry.index, entry.cursor, entry.records, entry.terminal, entry.empty]),
    [
      [0, null, ['a', 'b'], false, false],
      [1, 'p2', ['c'], true, false],
    ],
  )
  assert.equal(result.served, 3)
})

/*
 * The distinction the tool exists for. An empty page and a last page are the
 * same thing to a client that stops on `records.length === 0`, and the two
 * mistakes it can make are opposite: truncating the collection, or never
 * leaving it.
 */

test('an empty page is not a last page: the walk continues past it', async () => {
  const api = fakeApi([
    [null, page(['a'], 'p2')],
    ['p2', page([], 'p3')],
    ['p3', page(['b'], null)],
  ])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.pages.length, 3)
  assert.equal(result.pages[1].empty, true)
  assert.equal(result.pages[1].terminal, false, 'an empty page with a next cursor is not terminal')
  assert.equal(result.terminatedBy, 'last-page')
  // The record beyond the empty page is the whole point: a client that stopped
  // at page 1 would hold one record instead of two.
  assert.deepEqual(result.pages.flatMap((entry) => entry.records), ['a', 'b'])
})

test('a last page is not an empty page: a terminal page with records ends the walk', async () => {
  const api = fakeApi([[null, page(['a'], null)]])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].terminal, true)
  assert.equal(result.pages[0].empty, false)
  assert.equal(api.fetches, 1, 'a terminal page is never followed by another request')
})

test('an empty last page is both empty and terminal, and is still the end', async () => {
  const api = fakeApi([
    [null, page(['a'], 'p2')],
    ['p2', page([], null)],
  ])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.pages[1].empty, true)
  assert.equal(result.pages[1].terminal, true)
  assert.equal(result.terminatedBy, 'last-page')
  assert.equal(result.complete, true)
})

/* Termination. */

test('a cursor returned twice terminates the walk instead of looping', async () => {
  const api = fakeApi([
    [null, page(['a'], 'p2')],
    ['p2', page(['b'], 'p2')],
  ])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.terminatedBy, 'repeated-cursor')
  assert.equal(result.repeatedCursor, 'p2')
  assert.equal(result.complete, false)
  assert.equal(result.pages.length, 2)
  assert.equal(api.fetches, 2, 'the repeated cursor is never requested a second time')
})

test('a longer cursor cycle terminates too, at the first repeat', async () => {
  const api = fakeApi([
    [null, page(['a'], 'p2')],
    ['p2', page(['b'], 'p3')],
    ['p3', page(['c'], 'p2')],
  ])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.terminatedBy, 'repeated-cursor')
  assert.equal(result.repeatedCursor, 'p2')
  assert.deepEqual(result.requested, [null, 'p2', 'p3'])
})

test('a page pointing back at the initial request terminates', async () => {
  // The initial cursor is null, and null is in the visited set like any other.
  const api = fakeApi([
    [null, page(['a'], 'p2')],
    ['p2', page(['b'], null)],
  ])
  const looping = {
    async fetchPage(cursor) {
      const response = await api.fetchPage(cursor)
      return response === undefined ? undefined : { ...response, nextCursor: response.nextCursor ?? 'p2' }
    },
  }
  const result = await walkPages({ fetchPage: looping.fetchPage, limits: limits(), clock: steady })
  assert.equal(result.terminatedBy, 'repeated-cursor')
})

test('a walk against an endless generator stops at maxPages rather than running forever', async () => {
  // No table at all: every cursor is fresh, so only the bound can end this.
  let issued = 0
  const endless = {
    async fetchPage() {
      issued += 1
      return page([`r${issued}`], `p${issued}`)
    },
  }
  const result = await walkPages({ fetchPage: endless.fetchPage, limits: limits({ maxPages: 4 }), clock: steady })

  assert.equal(result.terminatedBy, 'page-limit')
  assert.equal(result.pages.length, 4)
  assert.equal(result.complete, false)
})

test('a cursor no page answers ends the walk as dangling, not as the last page', async () => {
  const api = fakeApi([[null, page(['a'], 'gone')]])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.terminatedBy, 'dangling-cursor')
  assert.equal(result.danglingCursor, 'gone')
  assert.equal(result.complete, false)
  assert.equal(result.pages.length, 1)
})

/* The empty-string terminator, which is neither an ending nor a cursor. */

test('an empty-string next cursor that no page answers is read as the end, and flagged', async () => {
  const api = fakeApi([[null, page(['a'], '')]])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.ambiguousTerminator, true)
  assert.equal(result.ambiguousFollows, false)
  assert.equal(result.terminatedBy, 'last-page')
  assert.equal(result.pages[0].terminal, true)
  assert.equal(api.fetches, 2, 'the empty cursor is probed exactly once')
})

test('an empty-string next cursor that a page does answer stops the walk as ambiguous', async () => {
  const api = fakeApi([
    [null, page(['a'], '')],
    ['', page(['b'], null)],
  ])
  const result = await walkPages({ fetchPage: api.fetchPage, limits: limits(), clock: steady })

  assert.equal(result.ambiguousTerminator, true)
  assert.equal(result.ambiguousFollows, true)
  assert.equal(result.terminatedBy, 'ambiguous-terminator')
  assert.equal(result.complete, false)
  assert.equal(result.pages.length, 1, 'the probed page is not attributed to the walk')
  assert.equal(result.served, 1)
})

/* The scenario mock, which is the in-memory API this tool ships with. */

test('the scenario mock answers from memory and opens no socket', async () => {
  const scenario = validateScenario(
    {
      corpus: ['a', 'b'],
      pages: [
        { cursor: null, records: ['a'], nextCursor: 'p2' },
        { cursor: 'p2', records: ['b'], nextCursor: null },
      ],
    },
    DEFAULT_LIMITS,
  )
  const api = createMockApi(scenario)

  assert.deepEqual(await api.fetchPage(null), { records: ['a'], nextCursor: 'p2', declaredIndex: 0 })
  assert.deepEqual(await api.fetchPage('p2'), { records: ['b'], nextCursor: null, declaredIndex: 1 })
  assert.equal(await api.fetchPage('nope'), undefined)
  assert.equal(api.fetches, 3)
  // The mock hands out copies: a caller mutating a page must not rewrite the
  // scenario the next walk reads.
  const first = await api.fetchPage(null)
  first.records.push('tampered')
  assert.deepEqual((await api.fetchPage(null)).records, ['a'])
})

test('walkPages refuses a fetcher or a clock that is not a function', async () => {
  await assert.rejects(() => walkPages({ fetchPage: 'nope', limits: limits(), clock: steady }), TypeError)
  await assert.rejects(() => walkPages({ fetchPage: async () => undefined, limits: limits(), clock: 1 }), TypeError)
})
