import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, testScenarioObject, testScenarioText, validateLimits } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

/**
 * Every documented limit, from both sides of the bound.
 *
 * A limit that is only tested from the exceeding side cannot tell an enforced
 * bound from one that refuses everything, and a limit that is only documented
 * is the defect that let a configuration key be accepted and ignored. So each
 * one is exercised twice: at the bound, where the run must proceed, and one
 * step past it, where the run must stop and say which limit stopped it.
 */

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)

const threePages = () => ({
  corpus: ['a', 'b', 'c'],
  pages: [
    { cursor: null, records: ['a'], nextCursor: 'p2' },
    { cursor: 'p2', records: ['b'], nextCursor: 'p3' },
    { cursor: 'p3', records: ['c'], nextCursor: null },
  ],
})

test('validateLimits refuses an unknown name, a fraction, a negative and a zero floor', () => {
  assert.deepEqual({ ...validateLimits() }, { ...DEFAULT_LIMITS })
  assert.throws(() => validateLimits({ maxPage: 3 }), /Unknown limit "maxPage"/)
  assert.throws(() => validateLimits({ maxPages: 1.5 }), /at least 1/)
  assert.throws(() => validateLimits({ maxPages: -1 }), /at least 1/)
  assert.throws(() => validateLimits({ maxPages: 0 }), /at least 1/)
  assert.throws(() => validateLimits({ maxMillis: -1 }), /at least 0/)
  assert.equal(validateLimits({ maxMillis: 0 }).maxMillis, 0, 'zero is a real time budget')
  assert.equal(Object.isFrozen(validateLimits()), true)
})

test('maxScenarioBytes: a scenario of exactly the bound is read, one byte more is refused', async () => {
  const text = JSON.stringify({ corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] })
  const size = new TextEncoder().encode(text).byteLength

  const atBound = await testScenarioText(text, { limits: { maxScenarioBytes: size } })
  assert.equal(atBound.status, 'pass')
  assert.equal(atBound.summary.bytes, size)

  const past = await testScenarioText(text, { limits: { maxScenarioBytes: size - 1 } })
  assert.deepEqual(ruleIds(past), ['scenario-too-large'])
  assert.equal(past.status, 'incomplete')
  assert.equal(past.summary.checked, 0)
})

test('maxScenarioPages: a scenario at the bound is read, one page more is refused', async () => {
  const atBound = await testScenarioObject(threePages(), { limits: { maxScenarioPages: 3 } })
  assert.equal(atBound.status, 'pass')

  const past = await testScenarioObject(threePages(), { limits: { maxScenarioPages: 2 } })
  assert.deepEqual(ruleIds(past), ['scenario-too-many-pages'])
  assert.equal(past.status, 'incomplete')
})

test('maxCorpus: a corpus at the bound is read, one identity more is refused', async () => {
  const atBound = await testScenarioObject(threePages(), { limits: { maxCorpus: 3 } })
  assert.equal(atBound.status, 'pass')

  const past = await testScenarioObject(threePages(), { limits: { maxCorpus: 2 } })
  assert.deepEqual(ruleIds(past), ['corpus-too-large'])
  assert.equal(past.status, 'incomplete')
})

test('maxPages: a walk at the bound completes, one page more stops the walk', async () => {
  const atBound = await testScenarioObject(threePages(), { limits: { maxPages: 3 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(atBound.summary.pages, 3)

  const past = await testScenarioObject(threePages(), { limits: { maxPages: 2 } })
  assert.equal(past.summary.pages, 2)
  assert.equal(past.walk.terminatedBy, 'page-limit')
  assert.equal(ruleIds(past).includes('page-limit-exceeded'), true)
  assert.equal(past.status, 'incomplete')
})

test('maxRecords: a walk at the bound completes, one record more stops the walk', async () => {
  const atBound = await testScenarioObject(threePages(), { limits: { maxRecords: 3 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(atBound.summary.records, 3)

  const past = await testScenarioObject(threePages(), { limits: { maxRecords: 2 } })
  assert.equal(past.summary.records, 2, 'the page that would have passed the bound is not counted')
  assert.equal(past.walk.terminatedBy, 'record-limit')
  assert.equal(ruleIds(past).includes('record-limit-exceeded'), true)
  assert.equal(past.status, 'incomplete')
})

test('maxIdLength: an identity at the bound is read, one character more is refused', async () => {
  const document = { corpus: ['abc'], pages: [{ cursor: null, records: ['abc'], nextCursor: null }] }
  const atBound = await testScenarioObject(document, { limits: { maxIdLength: 3 } })
  assert.equal(atBound.status, 'pass')

  const past = await testScenarioObject(document, { limits: { maxIdLength: 2 } })
  assert.deepEqual(ruleIds(past), ['record-id-too-long'])
  assert.equal(past.status, 'incomplete')
})

test('maxIdLength applies to cursors as well as to record identities', async () => {
  const document = {
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'longcursor' },
      { cursor: 'longcursor', records: ['b'], nextCursor: null },
    ],
  }
  const past = await testScenarioObject(document, { limits: { maxIdLength: 4 } })
  assert.deepEqual(ruleIds(past), ['record-id-too-long'])
  assert.equal(past.findings[0].location.pointer, '/pages/1/cursor')
})

test('maxFindings: a run at the bound reports everything, one finding more is capped and says so', async () => {
  const document = { corpus: ['a', 'b', 'c'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] }

  const atBound = await testScenarioObject(document, { limits: { maxFindings: 2 } })
  assert.deepEqual(ruleIds(atBound), ['record-missing', 'record-missing'])
  assert.equal(atBound.status, 'fail')

  const past = await testScenarioObject(document, { limits: { maxFindings: 1 } })
  assert.equal(ruleIds(past).includes('too-many-findings'), true)
  assert.equal(past.findings.length, 2, 'the cap finding is added past the cap, not instead of a finding')
  assert.equal(past.status, 'incomplete', 'a bounded list is never a silent truncation')
})

test('maxMillis: a budget of zero is spent before the first fetch', async () => {
  const report = await testScenarioObject(threePages(), { limits: { maxMillis: 0 }, clock: () => 0 })
  assert.equal(report.summary.pages, 0)
  assert.equal(report.walk.terminatedBy, 'time-limit')
  assert.equal(ruleIds(report).includes('time-limit-exceeded'), true)
  assert.equal(ruleIds(report).includes('no-pages-fetched'), true)
  assert.equal(report.status, 'incomplete')
})

test('maxMillis: a budget larger than the walk takes is never spent', async () => {
  const report = await testScenarioObject(threePages(), { limits: { maxMillis: 1 }, clock: () => 0 })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.pages, 3)
})

test('maxMillis is wired to the clock mid-walk, not only at the start', async () => {
  // The clock advances ten milliseconds per reading: the start, then once per
  // page. The bound falls between the second and third page.
  let now = 0
  const clock = () => {
    const reading = now
    now += 10
    return reading
  }
  const report = await testScenarioObject(threePages(), { limits: { maxMillis: 25 }, clock })

  assert.equal(report.summary.pages, 2)
  assert.equal(report.walk.terminatedBy, 'time-limit')
  assert.equal(report.status, 'incomplete')
  // Nothing about the elapsed time reaches the report: a clock may only end a
  // run early, and that is a finding of its own.
  assert.equal(JSON.stringify(report).includes('"elapsed"'), false)
})

test('every limit flag on the CLI actually reaches the limit it names', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-limits-'))
  try {
    const target = join(base, 'scenario.json')
    await writeFile(target, JSON.stringify(threePages()))
    // The findings cap needs a scenario that raises findings at all; every
    // other bound is reached by the clean one.
    const dirty = join(base, 'dirty.json')
    await writeFile(
      dirty,
      JSON.stringify({ corpus: ['a', 'b', 'c'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] }),
    )
    const invoke = async (path, args) => {
      try {
        const { stdout } = await run(process.execPath, [CLI, '--input', path, '--json', ...args], {
          cwd: projectDirectory,
        })
        return { code: 0, report: JSON.parse(stdout) }
      } catch (error) {
        return { code: error.code, report: JSON.parse(error.stdout) }
      }
    }

    for (const [flag, ruleId] of [
      ['--max-scenario-bytes', 'scenario-too-large'],
      ['--max-scenario-pages', 'scenario-too-many-pages'],
      ['--max-corpus', 'corpus-too-large'],
      ['--max-pages', 'page-limit-exceeded'],
      ['--max-records', 'record-limit-exceeded'],
      ['--max-id-length', 'record-id-too-long'],
    ]) {
      const { code, report } = await invoke(target, [flag, '1'])
      assert.equal(code, 2, `${flag} must reach its limit`)
      assert.equal(ruleIds(report).includes(ruleId), true, `${flag} did not raise ${ruleId}`)
    }

    const capped = await invoke(dirty, ['--max-findings', '1'])
    assert.equal(capped.code, 2, '--max-findings must reach its limit')
    assert.equal(ruleIds(capped.report).includes('too-many-findings'), true)

    const timed = await invoke(target, ['--max-millis', '0'])
    assert.equal(timed.code, 2)
    assert.equal(ruleIds(timed.report).includes('time-limit-exceeded'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the CLI refuses a limit value that is not an integer, and a repeated flag', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-limits-'))
  try {
    const target = join(base, 'scenario.json')
    await writeFile(target, JSON.stringify(threePages()))
    const invoke = async (args) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [CLI, '--input', target, ...args], {
          cwd: projectDirectory,
        })
        return { code: 0, stdout, stderr }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
    }

    for (const args of [['--max-pages', 'lots'], ['--max-pages', '0'], ['--max-pages', '-1'], ['--max-pages', '1.5']]) {
      const result = await invoke(args)
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '', 'a configuration error never had a subject, so stdout stays empty')
    }

    const repeated = await invoke(['--max-pages', '2', '--max-pages', '1'])
    assert.equal(repeated.code, 2)
    assert.equal(repeated.stdout, '')
    assert.match(repeated.stderr, /--max-pages was given more than once/)

    const zeroMillis = await invoke(['--max-millis', '0', '--json'])
    assert.equal(zeroMillis.code, 2, 'zero is a valid budget, not a rejected value')
    assert.equal(zeroMillis.stdout.length > 0, true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
