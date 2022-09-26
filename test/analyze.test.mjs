import assert from 'node:assert/strict'
import test from 'node:test'

import { indexRecords, testScenarioObject } from '../src/index.mjs'

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)
const find = (report, ruleId) => report.findings.find((finding) => finding.ruleId === ruleId)

/* --- boundary duplicates -------------------------------------------------- */

test('a record served on two pages is reported as a boundary duplicate', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b', 'c'],
    pages: [
      { cursor: null, records: ['a', 'b'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b', 'c'], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['record-duplicated'])
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.walk.records.duplicated, ['b'])
  assert.equal(report.summary.records, 4, 'four records were served')
  assert.equal(report.summary.distinctRecords, 3, 'three distinct identities were served')
  assert.equal(find(report, 'record-duplicated').evidence, 'pages 0, 1')
})

test('a record served twice inside one page is a different defect from a boundary duplicate', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['a', 'a', 'b'], nextCursor: null }],
  })

  assert.deepEqual(ruleIds(report), ['record-repeated-in-page'])
  assert.deepEqual(report.walk.records.repeatedInPage, ['a'])
  assert.deepEqual(report.walk.records.duplicated, [], 'one page cannot produce a boundary duplicate')
  assert.match(find(report, 'record-repeated-in-page').message, /not a page boundary problem/)
})

test('indexRecords keeps the two questions apart', () => {
  const { pagesById, repeatedInPage } = indexRecords([
    { index: 0, records: ['a', 'a', 'b'] },
    { index: 1, records: ['b'] },
  ])
  assert.deepEqual(pagesById.get('a'), [0], 'a repeat inside one page is still one page')
  assert.deepEqual(pagesById.get('b'), [0, 1])
  assert.deepEqual([...repeatedInPage.entries()], [['a', 0]])
})

/* --- missing records ------------------------------------------------------ */

test('a corpus record served on no page is reported missing once the walk is complete', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b', 'c'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['c'], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['record-missing'])
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.walk.records.missing, ['b'])
  assert.equal(report.walk.complete, true)
})

test('an incomplete walk reports completeness as unknown rather than calling records missing', async () => {
  // The same corpus and the same two observed records, but the walk ends on a
  // cursor loop. Nothing is known about the third record, and unknown is not a
  // verdict: claiming "missing" here would be an assertion about evidence
  // nobody obtained.
  const report = await testScenarioObject({
    corpus: ['a', 'b', 'c'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['c'], nextCursor: 'p2' },
    ],
  })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.walk.records.missing, [], 'nothing may be declared missing from an unfinished walk')
  assert.equal(ruleIds(report).includes('record-missing'), false)
  assert.equal(ruleIds(report).includes('completeness-unknown'), true)
  assert.equal(ruleIds(report).includes('cursor-repeated'), true)
})

test('a duplicate observed before an incomplete walk ended is still reported', async () => {
  // A duplicate is something the walk saw. An observation stays true however
  // the walk ended, so it is not withheld the way an inference is.
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['a'], nextCursor: 'p2' },
    ],
  })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.walk.records.duplicated, ['a'])
  assert.equal(ruleIds(report).includes('record-duplicated'), true)
})

test('a record the corpus does not declare is reported as unknown', async () => {
  const report = await testScenarioObject({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a', 'zz'], nextCursor: null }],
  })

  assert.deepEqual(ruleIds(report), ['record-unknown'])
  assert.deepEqual(report.walk.records.unknown, ['zz'])
  assert.equal(report.status, 'fail')
})

/* --- empty page versus last page ------------------------------------------ */

test('an empty page in the middle of a collection is reported, with what a client would miss', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: [], nextCursor: 'p3' },
      { cursor: 'p3', records: ['b'], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['empty-page-not-last'])
  assert.equal(report.status, 'pass', 'an empty page is a warning: the walk itself was correct and complete')
  assert.equal(report.walk.pages[1].empty, true)
  assert.equal(report.walk.pages[1].terminal, false)
  assert.match(find(report, 'empty-page-not-last').message, /miss the 1 record\(s\) this walk observed after it/)
  assert.equal(
    find(report, 'empty-page-not-last').evidence,
    'next cursor p3; 1 record(s) observed after it in this walk',
  )
})

test('the records a truncating client would miss are counted as observed, not asserted', async () => {
  // The same empty page, walked twice. Bounded at that page, the two records
  // that follow it in the scenario were never fetched, so "would ... miss 0
  // record(s)" would be a flat claim about pages nobody read. The count is
  // scoped to what this walk saw, in the message and in the evidence alike.
  const document = {
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: [], nextCursor: 'p2' },
      { cursor: 'p2', records: ['a', 'b'], nextCursor: null },
    ],
  }

  const cut = await testScenarioObject(document, { limits: { maxPages: 1 } })
  const cutFinding = find(cut, 'empty-page-not-last')
  assert.equal(cut.walk.complete, false)
  assert.match(cutFinding.message, /miss the 0 record\(s\) this walk observed after it/)
  assert.equal(cutFinding.evidence, 'next cursor p2; 0 record(s) observed after it in this walk')
  assert.equal(/miss 0 record\(s\)\./.test(cutFinding.message), false, 'an unbounded claim about unread pages')

  const whole = await testScenarioObject(document)
  assert.equal(whole.walk.complete, true)
  assert.match(find(whole, 'empty-page-not-last').message, /miss the 2 record\(s\) this walk observed after it/)
})

test('an empty last page is reported as an ending, not as an empty page', async () => {
  const report = await testScenarioObject({
    corpus: ['a'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: [], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['terminal-page-empty'])
  assert.equal(report.status, 'pass')
  assert.equal(report.walk.pages[1].empty, true)
  assert.equal(report.walk.pages[1].terminal, true)
  assert.equal(ruleIds(report).includes('empty-page-not-last'), false, 'the last page is never the middle one')
})

test('the two conditions are told apart in one scenario that has both', async () => {
  const report = await testScenarioObject({
    corpus: ['a'],
    pages: [
      { cursor: null, records: [], nextCursor: 'p2' },
      { cursor: 'p2', records: ['a'], nextCursor: 'p3' },
      { cursor: 'p3', records: [], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['empty-page-not-last', 'terminal-page-empty'])
  assert.equal(report.findings[0].page, 0)
  assert.equal(report.findings[1].page, 2)
})

/* --- page size against the declared limit --------------------------------- */

test('a page carrying more than the declared limit is reported', async () => {
  const report = await testScenarioObject({
    pageLimit: 2,
    corpus: ['a', 'b', 'c'],
    pages: [{ cursor: null, records: ['a', 'b', 'c'], nextCursor: null }],
  })

  assert.deepEqual(ruleIds(report), ['page-over-limit'])
  assert.equal(report.status, 'fail')
})

test('a short page before the last one is reported, and a short last page is not', async () => {
  const report = await testScenarioObject({
    pageLimit: 2,
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['page-short-before-last'])
  assert.equal(report.findings[0].page, 0, 'only the non-terminal short page')
  assert.equal(report.status, 'pass')
})

test('without a declared page limit neither page-size rule can fire', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.walk.pageLimit, null)
})

/* --- pages nothing leads to ------------------------------------------------ */

test('a declared page the walk never requested is reported unreachable', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a', 'b'], nextCursor: null },
      { cursor: 'orphan', records: ['a'], nextCursor: null },
    ],
  })

  assert.deepEqual(ruleIds(report), ['page-unreachable'])
  assert.deepEqual(report.walk.unreachablePages, ['orphan'])
  assert.equal(report.status, 'pass')
})

test('a walk stopped by a bound calls nothing unreachable, because it never got there', async () => {
  // The walk is cut off after one page. Page 0 hands out the cursor for page 1,
  // which hands out the cursor for page 2, so "nothing the API returns leads a
  // client to it" is false of both -- the walk simply stopped. Unreachability
  // is the dual of missing and needs the same complete walk behind it.
  const chain = {
    corpus: ['a', 'b', 'c'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: 'p3' },
      { cursor: 'p3', records: ['c'], nextCursor: null },
    ],
  }

  const cut = await testScenarioObject(chain, { limits: { maxPages: 1 } })
  assert.equal(cut.status, 'incomplete')
  assert.equal(cut.walk.complete, false)
  assert.deepEqual(cut.walk.unreachablePages, [], 'a bound is not evidence about what leads where')
  assert.equal(cut.summary.unreachablePages, 0)
  assert.equal(ruleIds(cut).includes('page-unreachable'), false)
  assert.equal(ruleIds(cut).includes('completeness-unknown'), true, 'what was not examined is still named')

  // The same chain walked to the end really does reach every page, so the
  // assertion above is not passing for want of anything to report.
  const whole = await testScenarioObject(chain)
  assert.equal(whole.status, 'pass')
  assert.equal(whole.summary.pages, 3)
})

test('a cycle that strands a declared page does not make it unreachable either', async () => {
  // The cycle example: the walk loops between page 0 and page 1 and never
  // reaches the page keyed "page:3". Nothing observed says whether anything
  // leads there, so nothing is claimed.
  const report = await testScenarioObject({
    corpus: ['a', 'b', 'c'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: 'p2' },
      { cursor: 'p3', records: ['c'], nextCursor: null },
    ],
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.walk.terminatedBy, 'repeated-cursor')
  assert.deepEqual(report.walk.unreachablePages, [])
  assert.equal(ruleIds(report).includes('page-unreachable'), false)
})

test('a page probed for the empty-string cursor is not called unreachable', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: '' },
      { cursor: '', records: ['b'], nextCursor: null },
    ],
  })

  assert.equal(ruleIds(report).includes('page-unreachable'), false, 'the probe did request it')
  assert.equal(ruleIds(report).includes('terminator-ambiguous'), true)
  assert.equal(report.walk.terminatedBy, 'ambiguous-terminator')
})

/* --- the ambiguous terminator ---------------------------------------------- */

test('an empty-string terminator no page answers is an error but still a complete walk', async () => {
  const report = await testScenarioObject({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a'], nextCursor: '' }],
  })

  assert.deepEqual(ruleIds(report), ['terminator-ambiguous'])
  assert.equal(report.status, 'fail')
  assert.equal(report.walk.complete, true)
  assert.match(find(report, 'terminator-ambiguous').message, /would get nothing back/)
})

test('an empty-string terminator a page does answer stops the walk and blocks the verdict', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: '' },
      { cursor: '', records: ['b'], nextCursor: null },
    ],
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.walk.complete, false)
  assert.deepEqual(report.walk.records.missing, [])
  assert.match(find(report, 'terminator-ambiguous').message, /disagree about real records/)
})

/* --- what an unfinished walk is allowed to claim --------------------------- */

test('completeness-unknown counts corpus records, not the identities the walk served', async () => {
  // Both of these walks stopped on a dangling cursor having served nothing the
  // corpus declares. A count taken from the served identities answers a
  // different question: it reports one record unobserved when both are, and it
  // goes negative as soon as more unknown ids are served than the corpus holds.
  const undercount = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['x'], nextCursor: 'gone' }],
  })

  assert.equal(undercount.status, 'incomplete')
  assert.equal(undercount.summary.observedCorpus, 0, 'no declared identity was observed')
  assert.match(find(undercount, 'completeness-unknown').message, /so 2 corpus record\(s\) were never observed/)

  const negative = await testScenarioObject({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['x', 'y', 'z'], nextCursor: 'gone' }],
  })

  assert.equal(negative.summary.observedCorpus, 0)
  assert.match(find(negative, 'completeness-unknown').message, /so 1 corpus record\(s\) were never observed/)
  assert.equal(
    /-\d+ corpus record/.test(find(negative, 'completeness-unknown').message),
    false,
    'a count of records never goes negative',
  )
})

test('observedCorpus counts the declared identities a walk saw, and nothing else', async () => {
  const report = await testScenarioObject({
    corpus: ['a', 'b', 'c'],
    pages: [{ cursor: null, records: ['a', 'x'], nextCursor: 'gone' }],
  })

  assert.equal(report.summary.observedCorpus, 1)
  assert.equal(report.summary.distinctRecords, 2, 'the served count includes the identity the corpus never declared')
  assert.match(find(report, 'completeness-unknown').message, /so 2 corpus record\(s\) were never observed/)
})
