/**
 * api-pagination-tester -- what a walk means.
 *
 * The walker produces facts: these pages were served, in this order, and the
 * walk stopped for this reason. This module turns those facts into findings and
 * into the record-identity verdict.
 *
 * The one inference that needs a complete walk is *missing*. A record that did
 * not appear is only missing if the walk reached the real last page; if the
 * walk stopped early -- a cursor loop, a dangling cursor, a bound -- then the
 * records it never reached are simply unobserved, and reporting them as missing
 * would be an assertion about evidence nobody obtained. That case raises
 * `completeness-unknown` instead, which is the single place in this tool where
 * an early ending makes the run incomplete.
 *
 * Duplicates and unknown records need no such care: both are things the walk
 * *saw*, and an observation stays true however the walk ended.
 */

import { SECTIONS } from './rules.mjs'
import { byCodeUnit, cursorLabel, excerpt } from './text.mjs'

const TERMINATION_TEXT = Object.freeze({
  'ambiguous-terminator': 'a next cursor of "" that another page answers',
  'dangling-cursor': 'a cursor no page answers',
  'last-page': 'a page declaring no next cursor',
  'page-limit': 'the maxPages limit',
  'record-limit': 'the maxRecords limit',
  'repeated-cursor': 'a cursor that had already been requested',
  'time-limit': 'the maxMillis limit',
})

/** A page index list, rendered for evidence. Page numbers are this tool's own. */
function pageList(indexes) {
  return indexes.join(', ')
}

/**
 * Index the walk by record identity.
 *
 * Two different questions, deliberately answered separately: on how many
 * *distinct pages* did this id appear (a boundary duplicate, the classic
 * off-by-one where page 2 repeats the last row of page 1), and did it appear
 * twice inside *one* page (a different defect, usually a join fanning out).
 * Collapsing them would report a page-internal duplicate as a boundary bug and
 * send the reader to the wrong place.
 */
export function indexRecords(pages) {
  const pagesById = new Map()
  const repeatedInPage = new Map()
  for (const page of pages) {
    const seenHere = new Set()
    for (const id of page.records) {
      if (seenHere.has(id)) {
        if (!repeatedInPage.has(id)) repeatedInPage.set(id, page.index)
      }
      seenHere.add(id)
      const where = pagesById.get(id)
      if (where === undefined) pagesById.set(id, [page.index])
      else if (!where.includes(page.index)) where.push(page.index)
    }
  }
  return { pagesById, repeatedInPage }
}

/**
 * Evaluate a walk and fill the finding set.
 *
 * Returns the record verdict, whose four id lists reach the report as they are
 * ordered here. Each list is sorted at its own call site by UTF-16 code unit;
 * they are separate sites on purpose, and each one is pinned by a test that
 * asserts the exact emitted sequence for ids whose collation order differs.
 * Sorting compares the raw ids, because raw ids are the identities; the report
 * carries the sanitised form of the same sequence.
 */
export function analyzeWalk({ scenario, result, findings }) {
  const { pagesById, repeatedInPage } = indexRecords(result.pages)

  /**
   * How many declared identities the walk actually saw.
   *
   * Counted against the corpus, not against the served ids: `pagesById` also
   * holds identities the corpus never declared, so subtracting its size from
   * the corpus length answers a question nobody asked. A walk that served one
   * unknown id and no corpus id would report one corpus record unobserved when
   * the true number is all of them, and a walk serving more unknown ids than
   * the corpus declares would report a negative count -- a number no reader can
   * act on and a claim about evidence that was never obtained.
   */
  const observedCorpus = scenario.corpus.filter((id) => pagesById.has(id)).length

  if (result.pages.length === 0) {
    findings.add(
      'no-pages-fetched',
      'No page was fetched, so this run checked nothing. A walk that observed no page cannot report that a ' +
        'pagination contract holds.',
      {
        section: SECTIONS.walk,
        pointer: '/pages',
        suggestion: 'Check the initial page, the limits, and that the scenario declares a page with cursor null.',
      },
    )
  }

  // --- how the walk ended ----------------------------------------------------

  if (result.terminatedBy === 'repeated-cursor') {
    findings.add(
      'cursor-repeated',
      `The API returned the cursor ${cursorLabel(result.repeatedCursor)}, which had already been requested. The ` +
        `walk stopped after ${result.pages.length} page(s) instead of looping; a client without a visited set ` +
        'would not stop at all.',
      {
        section: SECTIONS.walk,
        pointer: '/pages',
        evidence: `requested cursors: ${result.requested.map(cursorLabel).join(' -> ')}`,
        suggestion: 'Make every next cursor advance. A cursor that repeats is an infinite loop in every client.',
      },
    )
  }

  if (result.terminatedBy === 'dangling-cursor') {
    findings.add(
      'cursor-unknown',
      `The API handed out the cursor ${cursorLabel(result.danglingCursor)} and then no page answered it, so the ` +
        'walk could not continue and the rest of the collection was never observed.',
      {
        section: SECTIONS.walk,
        pointer: '/pages',
        suggestion: 'Declare a page for every cursor a page returns, or return null to end the collection.',
      },
    )
  }

  if (result.terminatedBy === 'page-limit') {
    findings.add(
      'page-limit-exceeded',
      `The walk reached the maxPages limit of ${result.pages.length} page(s) with the collection still unfinished, ` +
        'so it stopped there. Nothing beyond that point was observed.',
      {
        section: SECTIONS.walk,
        pointer: '/pages',
        suggestion: 'Raise --max-pages, or shorten the scenario.',
      },
    )
  }

  if (result.terminatedBy === 'record-limit') {
    findings.add(
      'record-limit-exceeded',
      `The next page would have taken the walk past the maxRecords limit, so it stopped after ${result.served} ` +
        'record(s). That page was not counted and nothing after it was observed.',
      {
        section: SECTIONS.walk,
        pointer: '/pages',
        suggestion: 'Raise --max-records, or shorten the scenario.',
      },
    )
  }

  if (result.terminatedBy === 'time-limit') {
    findings.add(
      'time-limit-exceeded',
      `The walk reached the maxMillis limit after ${result.pages.length} page(s). The rest of the collection was ` +
        'not walked.',
      {
        section: SECTIONS.walk,
        pointer: '/pages',
        suggestion: 'Raise --max-millis, or shorten the scenario.',
      },
    )
  }

  if (result.ambiguousTerminator) {
    findings.add(
      'terminator-ambiguous',
      'A page ended with a next cursor of "" rather than null. `if (next)` reads that as the end and ' +
        '`if (next !== null)` requests another page, so two correct-looking clients disagree about the data. ' +
        `${
          result.ambiguousFollows
            ? 'A page does answer the empty cursor, so they disagree about real records and this walk stopped rather than pick a side.'
            : 'No page answers the empty cursor, so this walk read it as the end; a client that requested it would get nothing back.'
        }`,
      {
        section: SECTIONS.walk,
        pointer: `/pages/${result.pages.length > 0 ? result.pages[result.pages.length - 1].declaredIndex : 0}/nextCursor`,
        suggestion: 'End a collection with null. An empty string is not a terminator in any specification.',
      },
    )
  }

  // --- page shape ------------------------------------------------------------

  const recordsAfter = []
  let running = 0
  for (let index = result.pages.length - 1; index >= 0; index -= 1) {
    recordsAfter[index] = running
    running += result.pages[index].records.length
  }

  for (const page of result.pages) {
    const at = `/pages/${page.declaredIndex >= 0 ? page.declaredIndex : page.index}`
    if (page.empty && !page.terminal) {
      findings.add(
        'empty-page-not-last',
        `Page ${page.index} carries no records and still hands out a next cursor, so it is an empty page and not ` +
          `the last page. A client that stops when a page comes back empty would end the walk here and miss ` +
          `${recordsAfter[page.index]} record(s).`,
        {
          section: SECTIONS.pages,
          page: page.index,
          pointer: `${at}/records`,
          evidence: `next cursor ${cursorLabel(page.nextCursor)}; ${recordsAfter[page.index]} record(s) follow`,
          suggestion: 'Keep following the cursor until it is null. Emptiness is not a terminator.',
        },
      )
    }
    if (page.empty && page.terminal) {
      findings.add(
        'terminal-page-empty',
        `Page ${page.index} carries no records and declares no next cursor, so it is the last page and it is ` +
          'empty. That is a legitimate ending, and it is reported so that it is never confused with an empty ' +
          'page in the middle of a collection.',
        { section: SECTIONS.pages, page: page.index, pointer: `${at}/records` },
      )
    }
    if (scenario.pageLimit !== null && page.records.length > scenario.pageLimit) {
      findings.add(
        'page-over-limit',
        `Page ${page.index} carries ${page.records.length} record(s), more than the declared page limit of ` +
          `${scenario.pageLimit}. A client sizing buffers or rate budgets from the declared limit is wrong here.`,
        {
          section: SECTIONS.pages,
          page: page.index,
          pointer: `${at}/records`,
          suggestion: 'Serve at most the declared limit, or declare the limit the API actually honours.',
        },
      )
    }
    if (scenario.pageLimit !== null && !page.terminal && !page.empty && page.records.length < scenario.pageLimit) {
      findings.add(
        'page-short-before-last',
        `Page ${page.index} carries ${page.records.length} of the declared ${scenario.pageLimit} record(s) and is ` +
          'not the last page. A client that stops when a page comes back short would end the walk here.',
        {
          section: SECTIONS.pages,
          page: page.index,
          pointer: `${at}/records`,
          evidence: `${recordsAfter[page.index]} record(s) follow`,
          suggestion: 'A short page is not a terminator either; only a null next cursor is.',
        },
      )
    }
  }

  // --- pages the walk never asked for ----------------------------------------

  const requestedCursors = new Set(result.requested)
  if (result.probedEmptyCursor) requestedCursors.add('')
  const unreachable = scenario.pages
    .filter((page) => page.cursor !== null && !requestedCursors.has(page.cursor))
    .map((page) => page.cursor)
    // Ordering site: declared cursors the walk never requested.
    .sort(byCodeUnit)
  const unreachableIndex = new Map(scenario.pages.map((page) => [page.cursor, page.index]))
  for (const cursor of unreachable) {
    findings.add(
      'page-unreachable',
      `The scenario declares a page for the cursor ${cursorLabel(cursor)} that the walk never requested, so ` +
        'nothing the API returns leads a client to it.',
      {
        section: SECTIONS.pages,
        pointer: `/pages/${unreachableIndex.get(cursor)}/cursor`,
        suggestion: 'Point some page at it with a next cursor, or delete it from the scenario.',
      },
    )
  }

  // --- record identities -----------------------------------------------------

  const duplicated = [...pagesById.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([id]) => id)
    // Ordering site: ids served on more than one page.
    .sort(byCodeUnit)
  for (const id of duplicated) {
    const where = pagesById.get(id)
    findings.add(
      'record-duplicated',
      `The record "${excerpt(id, 60)}" was served on ${where.length} different pages, so a client that appends ` +
        'every page to one list ends up with it twice. This is the classic page-boundary duplicate.',
      {
        section: SECTIONS.records,
        page: where[0],
        pointer: `/records/${id}`,
        evidence: `pages ${pageList(where)}`,
        suggestion: 'Page on a stable, total ordering so a record cannot land on both sides of a boundary.',
      },
    )
  }

  const repeated = [...repeatedInPage.keys()]
    // Ordering site: ids served twice inside one page.
    .sort(byCodeUnit)
  for (const id of repeated) {
    findings.add(
      'record-repeated-in-page',
      `The record "${excerpt(id, 60)}" appears twice within page ${repeatedInPage.get(id)}. That is not a page ` +
        'boundary problem; one page returned the same identity twice.',
      {
        section: SECTIONS.records,
        page: repeatedInPage.get(id),
        pointer: `/records/${id}`,
        suggestion: 'Check for a join that fans out, or a page assembled from overlapping queries.',
      },
    )
  }

  const unknown = [...pagesById.keys()]
    .filter((id) => !scenario.corpusSet.has(id))
    // Ordering site: ids served that the corpus does not declare.
    .sort(byCodeUnit)
  for (const id of unknown) {
    findings.add(
      'record-unknown',
      `The record "${excerpt(id, 60)}" was served but is not in the declared corpus, so the walk cannot say what ` +
        'it is. Either the API is returning something it should not, or the corpus is out of date.',
      {
        section: SECTIONS.records,
        page: pagesById.get(id)[0],
        pointer: `/records/${id}`,
        suggestion: 'Reconcile the corpus with the API, then run again.',
      },
    )
  }

  let missing = []
  if (result.complete) {
    missing = scenario.corpus
      .filter((id) => !pagesById.has(id))
      // Ordering site: corpus ids no page served.
      .sort(byCodeUnit)
    for (const id of missing) {
      findings.add(
        'record-missing',
        `The record "${excerpt(id, 60)}" is in the corpus and appeared on no page, so a client that walked this ` +
          'API to the last page would never see it.',
        {
          section: SECTIONS.records,
          pointer: `/records/${id}`,
          suggestion: 'Check the boundary condition on the page query; a strict comparison often drops one row.',
        },
      )
    }
  } else {
    findings.add(
      'completeness-unknown',
      `The walk ended on ${TERMINATION_TEXT[result.terminatedBy] ?? 'an unknown condition'} rather than on the ` +
        `last page, so ${scenario.corpus.length - observedCorpus} corpus record(s) were never observed. Whether ` +
        'they are missing or merely unreached is not known, and unknown is not a pass.',
      {
        section: SECTIONS.walk,
        pointer: '/corpus',
        evidence: `terminated by ${result.terminatedBy}; ${result.pages.length} page(s) walked`,
        suggestion: 'Fix the reason the walk stopped, then run again to get a completeness verdict.',
      },
    )
    findings.incomplete = true
  }

  return {
    duplicated,
    missing,
    repeatedInPage: repeated,
    unknown,
    unreachablePages: unreachable,
    distinct: pagesById.size,
    observedCorpus,
  }
}
