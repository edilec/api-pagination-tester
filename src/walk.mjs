/**
 * api-pagination-tester -- the pagination state machine.
 *
 * The walker follows cursors from the initial request until the API says there
 * is no next page, and it always stops. Four things keep it honest:
 *
 * 1. **A visited set, not a hope.** Every cursor that has been *requested* is
 *    remembered. A cursor returned a second time ends the walk with a reason
 *    instead of spinning, so a mock that points page 3 back at page 2 produces
 *    a report rather than a hung process.
 * 2. **An empty page is not a last page.** Zero records is a page like any
 *    other; the walk continues if it carries a next cursor. Only `nextCursor:
 *    null` ends the walk. A client that conflates the two either truncates at
 *    the first empty page or, in the other direction, refetches the last page
 *    forever -- so the two conditions are separate states here and separate
 *    rules downstream.
 * 3. **An empty-string next cursor is neither.** `""` is the shape that breaks
 *    real clients: `if (next)` reads it as the end, `if (next !== null)` reads
 *    it as another page. The walker refuses to guess -- it probes once, reports
 *    the ambiguity, and says which reading it took.
 * 4. **Every bound is explicit.** Pages, records and milliseconds are all
 *    capped, and hitting a cap ends the walk with a named reason that becomes a
 *    finding. Nothing is silently cut short.
 *
 * There is no I/O in this module. `fetchPage` is supplied by the caller -- the
 * scenario mock, or a caller's own in-process fake.
 */

/** Why a walk stopped. `last-page` is the only ending that proves completeness. */
export const TERMINATIONS = Object.freeze([
  'last-page',
  'repeated-cursor',
  'dangling-cursor',
  'ambiguous-terminator',
  'page-limit',
  'record-limit',
  'time-limit',
])

/**
 * Walk a paginated API.
 *
 * Returns the pages in the order they were fetched, the cursors requested, and
 * why the walk stopped. It raises no findings and reaches no verdict: deciding
 * what the walk means is `analyze.mjs`'s job, and keeping the two apart is what
 * lets the state machine be tested without a report in the way.
 */
export async function walkPages({ fetchPage, limits, clock, start = null }) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function')
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning milliseconds')

  const pages = []
  const requested = []
  const visited = new Set()
  const started = clock()

  let cursor = start
  let served = 0
  let terminatedBy = null
  let repeatedCursor = null
  let danglingCursor = null
  let ambiguousTerminator = false
  let ambiguousFollows = false
  let probedEmptyCursor = false

  for (;;) {
    if (pages.length >= limits.maxPages) {
      terminatedBy = 'page-limit'
      break
    }
    // The budget is spent once the elapsed time *reaches* it, which is what
    // makes a budget of zero mean zero -- and a zero budget is how the wiring
    // between the flag and the clock is proven rather than assumed.
    if (clock() - started >= limits.maxMillis) {
      terminatedBy = 'time-limit'
      break
    }
    if (visited.has(cursor)) {
      terminatedBy = 'repeated-cursor'
      repeatedCursor = cursor
      break
    }
    visited.add(cursor)
    requested.push(cursor)

    const response = await fetchPage(cursor)
    if (response === undefined || response === null) {
      terminatedBy = 'dangling-cursor'
      danglingCursor = cursor
      break
    }

    const records = Array.isArray(response.records) ? [...response.records] : []
    // Checked before the page is attributed, so the counts describe pages the
    // walk actually took in rather than a page it half-read.
    if (served + records.length > limits.maxRecords) {
      terminatedBy = 'record-limit'
      break
    }
    served += records.length

    const next = response.nextCursor === undefined ? null : response.nextCursor
    const terminal = next === null
    pages.push({
      index: pages.length,
      cursor,
      records,
      nextCursor: next,
      terminal,
      empty: records.length === 0,
      declaredIndex: typeof response.declaredIndex === 'number' ? response.declaredIndex : -1,
    })

    if (terminal) {
      terminatedBy = 'last-page'
      break
    }

    if (next === '') {
      // The ambiguous terminator. One probe decides which reading is even
      // possible: if no page answers the empty cursor, the API meant "the end"
      // and wrote it badly, and the walk is complete. If a page does answer,
      // the two readings genuinely disagree about the data and the walk cannot
      // claim to have seen everything. The probe is not attributed to the walk.
      ambiguousTerminator = true
      probedEmptyCursor = true
      const probe = await fetchPage('')
      if (probe === undefined || probe === null) {
        pages[pages.length - 1].terminal = true
        terminatedBy = 'last-page'
      } else {
        ambiguousFollows = true
        terminatedBy = 'ambiguous-terminator'
      }
      break
    }

    cursor = next
  }

  return Object.freeze({
    pages,
    requested,
    served,
    terminatedBy,
    repeatedCursor,
    danglingCursor,
    ambiguousTerminator,
    ambiguousFollows,
    probedEmptyCursor,
    complete: terminatedBy === 'last-page',
  })
}
