import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY, byCodeUnit, testScenarioObject } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

/**
 * Ordering, pinned by what the report emits.
 *
 * Grepping this package's own source for `.localeCompare(` would not be a
 * determinism test: substituting `Intl.Collator` produces identical collation
 * drift with different source text, so the grep passes while the order silently
 * becomes machine-dependent.
 *
 * Every site in `src/` that orders something reaching output is pinned below by
 * the same method: choose values whose code-unit order and collation order
 * genuinely differ, push them through the real entry point, and assert the
 * exact emitted sequence. Each site is asserted on its own observable output,
 * so swapping one comparator to a collator fails a test that names that site.
 *
 * The sites, and where each is pinned:
 *
 * | site | file | pinned by |
 * | --- | --- | --- |
 * | findings sorted by pointer | `src/rules.mjs` `sortFindings` | "findings are ordered by pointer..." |
 * | findings tie-broken by rule id | `src/rules.mjs` `sortFindings` | "a pointer tie is broken by rule id..." (equivalent mutant, proved by enumeration) |
 * | `walk.records.duplicated` | `src/analyze.mjs` | "duplicated ids are emitted..." |
 * | `walk.records.repeatedInPage` | `src/analyze.mjs` | "repeated-in-page ids are emitted..." |
 * | `walk.records.unknown` | `src/analyze.mjs` | "unknown ids are emitted..." |
 * | `walk.records.missing` | `src/analyze.mjs` | "missing ids are emitted..." |
 * | `walk.unreachablePages` | `src/analyze.mjs` | "unreachable cursors are emitted..." |
 */

// Values whose code-unit order and English collation order disagree. `Z`
// precedes `a` by code unit and follows it under a collator; `-` precedes `_`
// by code unit and both are ignorable punctuation to a collator.
const MIXED = Object.freeze(['apple', 'assets', 'a_b', 'a-b', 'Zeta', 'README'])
const BY_CODE_UNIT = Object.freeze(['README', 'Zeta', 'a-b', 'a_b', 'apple', 'assets'])

const pointers = (report) => report.findings.map((finding) => finding.location.pointer)

test('the comparator disagrees with an English collator wherever these values differ', () => {
  const collator = new Intl.Collator('en')
  for (const [left, right] of [
    ['Zeta', 'apple'],
    ['README', 'assets'],
    ['a-b', 'a_b'],
    ['Z', 'a'],
  ]) {
    assert.equal(byCodeUnit(left, right), -1, `${left} must precede ${right} by code unit`)
    assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is the disagreement`)
  }
  // The sorted sequence differs too, not only the pairwise comparisons -- which
  // is what makes every deepEqual below load bearing.
  assert.notDeepEqual([...MIXED].sort(new Intl.Collator('en').compare), [...BY_CODE_UNIT])
})

test('findings are ordered by pointer in code-unit order, not collation order', async () => {
  // Every one of these is a missing corpus record, so every finding carries the
  // same section and the same page number and the pointer alone decides.
  const report = await testScenarioObject({
    corpus: [...MIXED, 'served'],
    pages: [{ cursor: null, records: ['served'], nextCursor: null }],
  })

  assert.deepEqual(pointers(report), [
    '/records/README',
    '/records/Zeta',
    '/records/a-b',
    '/records/a_b',
    '/records/apple',
    '/records/assets',
  ])
  const collated = [...pointers(report)].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(collated, pointers(report), 'a collator would have produced a different order')
})

test('a pointer tie is broken by rule id, and that tie is reachable', async () => {
  // An id served on two pages that the corpus does not declare raises both
  // `record-duplicated` and `record-unknown` at the same section, the same page
  // and the same pointer, so the rule id is the only thing left to order them.
  const report = await testScenarioObject({
    corpus: ['kept'],
    pages: [
      { cursor: null, records: ['kept', 'ghost'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['ghost'], nextCursor: null },
    ],
  })

  const ghost = report.findings.filter((finding) => finding.location.pointer === '/records/ghost')
  assert.equal(ghost.length, 2, 'the tie must actually occur, or this test cannot fail')
  assert.deepEqual(
    ghost.map((finding) => finding.ruleId),
    ['record-duplicated', 'record-unknown'],
  )
  assert.equal(ghost[0].page, ghost[1].page, 'the earlier sort keys really are equal')
})

test('the rule id alphabet makes collation and code-unit order identical, so that site cannot drift', () => {
  /*
   * An honest gap, proved rather than asserted. Every rule id is drawn from
   * [a-z0-9-], and over the ids this catalog actually holds an English collator
   * and a code-unit comparison agree on every pair -- so substituting a
   * collator at the rule-id tie-break would change nothing observable, and no
   * test could catch it. That is an equivalent mutant, not a gap in coverage.
   *
   * That is proved here by enumerating every ordered pair of the real rule ids
   * rather than argued. If a future rule id introduces a character where the
   * two disagree -- an upper-case letter, a digit boundary, an underscore --
   * this test fails and the site stops being an equivalent mutant.
   */
  const ids = Object.keys(RULE_SEVERITY)
  assert.equal(ids.length > 20, true, 'the enumeration must cover a real catalog')
  const collator = new Intl.Collator('en')
  let pairs = 0
  for (const left of ids) {
    assert.match(left, /^[a-z0-9-]+$/, `rule id ${left} must stay inside the proved alphabet`)
    for (const right of ids) {
      pairs += 1
      assert.equal(
        Math.sign(byCodeUnit(left, right)),
        Math.sign(collator.compare(left, right)),
        `code-unit and collation order disagree on ${left} vs ${right}`,
      )
    }
  }
  assert.equal(pairs, ids.length * ids.length)
})

test('duplicated ids are emitted in code-unit order', async () => {
  const report = await testScenarioObject({
    corpus: [...MIXED],
    pages: [
      { cursor: null, records: [...MIXED], nextCursor: 'p2' },
      { cursor: 'p2', records: [...MIXED], nextCursor: null },
    ],
  })

  assert.deepEqual(report.walk.records.duplicated, [...BY_CODE_UNIT])
  assert.notDeepEqual(
    [...report.walk.records.duplicated].sort(new Intl.Collator('en').compare),
    report.walk.records.duplicated,
  )
})

test('repeated-in-page ids are emitted in code-unit order', async () => {
  const report = await testScenarioObject({
    corpus: [...MIXED],
    pages: [{ cursor: null, records: [...MIXED, ...MIXED], nextCursor: null }],
  })

  assert.deepEqual(report.walk.records.repeatedInPage, [...BY_CODE_UNIT])
  assert.deepEqual(report.walk.records.duplicated, [], 'one page cannot produce a boundary duplicate')
  assert.notDeepEqual(
    [...report.walk.records.repeatedInPage].sort(new Intl.Collator('en').compare),
    report.walk.records.repeatedInPage,
  )
})

test('unknown ids are emitted in code-unit order', async () => {
  const report = await testScenarioObject({
    corpus: ['kept'],
    pages: [{ cursor: null, records: ['kept', ...MIXED], nextCursor: null }],
  })

  assert.deepEqual(report.walk.records.unknown, [...BY_CODE_UNIT])
  assert.notDeepEqual(
    [...report.walk.records.unknown].sort(new Intl.Collator('en').compare),
    report.walk.records.unknown,
  )
})

test('missing ids are emitted in code-unit order', async () => {
  const report = await testScenarioObject({
    corpus: [...MIXED, 'served'],
    pages: [{ cursor: null, records: ['served'], nextCursor: null }],
  })

  assert.deepEqual(report.walk.records.missing, [...BY_CODE_UNIT])
  assert.notDeepEqual(
    [...report.walk.records.missing].sort(new Intl.Collator('en').compare),
    report.walk.records.missing,
  )
})

test('unreachable cursors are emitted in code-unit order', async () => {
  const report = await testScenarioObject({
    corpus: ['kept'],
    pages: [
      { cursor: null, records: ['kept'], nextCursor: null },
      ...MIXED.map((cursor) => ({ cursor, records: ['kept'], nextCursor: null })),
    ],
  })

  assert.deepEqual(report.walk.unreachablePages, [...BY_CODE_UNIT])
  assert.notDeepEqual(
    [...report.walk.unreachablePages].sort(new Intl.Collator('en').compare),
    report.walk.unreachablePages,
  )
})

test('the corpus order in the scenario does not decide any emitted order', async () => {
  // The same six identities, declared in two different orders. If any site
  // leaned on the order it was handed rather than sorting, these would differ.
  const build = (corpus) => ({ corpus: [...corpus, 'served'], pages: [{ cursor: null, records: ['served'], nextCursor: null }] })
  const forwards = await testScenarioObject(build(MIXED))
  const backwards = await testScenarioObject(build([...MIXED].reverse()))

  assert.deepEqual(forwards.walk.records.missing, backwards.walk.records.missing)
  assert.deepEqual(pointers(forwards), pointers(backwards))
})

test('the real binary produces byte-identical stdout over identical input', async () => {
  const first = await run(process.execPath, [CLI, '--input', 'examples/orders-broken.json', '--json'], {
    cwd: projectDirectory,
  }).catch((error) => error)
  const second = await run(process.execPath, [CLI, '--input', 'examples/orders-broken.json', '--json'], {
    cwd: projectDirectory,
  }).catch((error) => error)

  assert.equal(first.code, 1, 'the broken example fails, which is what makes this report worth comparing')
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 0, true)
})
