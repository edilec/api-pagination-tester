import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { testScenarioObject, testScenarioText } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

/**
 * Every `incomplete = true` in `src/`, and the test that fails without it.
 *
 * Deleting one of these assignments once let an entirely unread input report
 * `pass` with a full suite still green. There are exactly three sites, each
 * uniquely responsible for a set of runs, and each is pinned below by an
 * observable difference -- the reported status and the process exit code, which
 * move from `incomplete`/2 to `fail`/1 the moment the assignment goes.
 *
 * | site | reached by | pinned by |
 * | --- | --- | --- |
 * | `refusedReport` in `src/index.mjs` | every scenario-level refusal | "a refused scenario is incomplete..." |
 * | the completeness branch in `src/analyze.mjs` | every walk that did not end on a last page | "a walk that ended early is incomplete..." |
 * | the cap in `FindingSet.add` in `src/rules.mjs` | a run past `maxFindings` | "a capped findings list is incomplete..." |
 *
 * No run reaches two of them at once for the same reason, so none of the three
 * is propped up by another: removing any one changes what a real run reports.
 */

async function cliExit(document, args = []) {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-incomplete-'))
  try {
    const target = join(base, 'scenario.json')
    await writeFile(target, JSON.stringify(document))
    try {
      await run(process.execPath, [CLI, '--input', target, '--json', ...args], { cwd: projectDirectory })
      return 0
    } catch (error) {
      return error.code
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a refused scenario is incomplete, not merely failed', async () => {
  // Site 1: `refusedReport`. Every scenario-level refusal arrives there, so one
  // assignment decides the status of all of them.
  const refusals = [
    { corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }], typo: 1 },
    { corpus: [], pages: [{ cursor: null, records: [], nextCursor: null }] },
    { corpus: ['a', 'a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] },
    { style: 'offset', corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] },
  ]
  for (const document of refusals) {
    const report = await testScenarioObject(document)
    assert.equal(report.status, 'incomplete', 'a refused scenario obtained no evidence')
    assert.equal(report.summary.checked, 0)
    assert.equal(await cliExit(document), 2, 'without the incomplete flag this would exit 1')
  }

  const unparsable = await testScenarioText('{')
  assert.equal(unparsable.status, 'incomplete')
})

test('a walk that ended early is incomplete, not merely failed', async () => {
  // Site 2: the completeness branch. The scenario is valid and the findings are
  // few, so neither of the other two sites is reachable here.
  const cycle = {
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: 'p2' },
    ],
  }
  const report = await testScenarioObject(cycle)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.walk.complete, false)
  assert.equal(await cliExit(cycle), 2, 'without the incomplete flag this would exit 1')

  const dangling = {
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['a'], nextCursor: 'gone' }],
  }
  assert.equal((await testScenarioObject(dangling)).status, 'incomplete')
  assert.equal(await cliExit(dangling), 2)
})

test('a capped findings list is incomplete, not merely failed', async () => {
  // Site 3: the cap. The walk here is complete and the scenario is valid, so
  // this run reaches neither of the other two sites -- the cap is the only
  // thing that can make it incomplete.
  const document = { corpus: ['a', 'b', 'c'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] }

  const uncapped = await testScenarioObject(document)
  assert.equal(uncapped.status, 'fail', 'the same run without a cap merely fails')
  assert.equal(await cliExit(document), 1)

  const capped = await testScenarioObject(document, { limits: { maxFindings: 1 } })
  assert.equal(capped.status, 'incomplete')
  assert.equal(capped.walk.complete, true, 'the walk itself finished; only the report is bounded')
  assert.equal(await cliExit(document, ['--max-findings', '1']), 2)
})

test('a pass is never reachable with nothing checked', async () => {
  // The vacuous-pass guard. Every route to `checked: 0` is enumerated here and
  // none of them is green.
  const routes = [
    [{ corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }], typo: 1 }, {}],
    [{ style: 'keyset', corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] }, {}],
    [
      { corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] },
      { limits: { maxMillis: 0 }, clock: () => 0 },
    ],
    [
      { corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] },
      { limits: { maxCorpus: 0 } },
    ],
  ]
  for (const [document, options] of routes) {
    const report = await testScenarioObject(document, options).catch(() => null)
    if (report === null) continue // a configuration error never had a subject
    assert.equal(report.summary.checked, 0)
    assert.notEqual(report.status, 'pass', 'a run that checked nothing must never be green')
    assert.equal(report.summary.errors > 0, true, 'and it must say why')
  }
})

test('an unfinished walk never reports a record as missing', async () => {
  // The inference that needs evidence, withheld when the evidence is not there.
  // Both of these observed exactly one of two corpus records.
  for (const document of [
    {
      corpus: ['a', 'b'],
      pages: [
        { cursor: null, records: ['a'], nextCursor: 'p2' },
        { cursor: 'p2', records: ['a'], nextCursor: 'p2' },
      ],
    },
    { corpus: ['a', 'b'], pages: [{ cursor: null, records: ['a'], nextCursor: 'gone' }] },
  ]) {
    const report = await testScenarioObject(document)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.missing, 0)
    assert.equal(
      report.findings.some((finding) => finding.ruleId === 'completeness-unknown'),
      true,
      'what was not observed is named as unknown rather than left silent',
    )
  }
})

test('a complete walk does report a record as missing, so the distinction is real', async () => {
  // The same corpus and the same single observed record, but this walk reached
  // the last page. Without this half, the test above would pass for a tool that
  // simply never reports anything missing.
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['a'], nextCursor: null }],
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.missing, 1)
  assert.deepEqual(report.walk.records.missing, ['b'])
})
