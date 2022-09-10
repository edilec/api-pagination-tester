import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the frozen table against the
 * documented catalog and against a hand-written copy. Those are three
 * declarations agreeing with each other: one commit can edit all three, and a
 * rule quietly demoted from `error` to `warning` reaches exit 0 with that suite
 * still green.
 *
 * This file asserts the consequence instead, and it is written to be immune to
 * that coordinated edit:
 *
 * - it imports nothing from `src/` -- not the severity table, not the rule
 *   catalog, not a constant;
 * - it shares no expectation map, no case table and no parameterised loop with
 *   any other file or with itself. Every scenario is written out inline and
 *   every expected number is a literal in the assertion;
 * - it never compares a finding's severity against a value from a map. It
 *   compares the process exit code, the literal counts in `summary`, and the
 *   severity word the human report prints.
 *
 * For rules that also make the run incomplete the exit code is 2 whatever the
 * severity says, so for those the literal `summary.errors` count and the
 * printed word are what notice a demotion.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

/**
 * Run the real binary over one scenario, twice: once for the JSON report and
 * once for the human one. Carries no expectations of its own.
 */
async function runCli(document, args = []) {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-severity-'))
  try {
    const target = join(base, 'scenario.json')
    await writeFile(target, JSON.stringify(document, null, 2))
    const invoke = async (extra) => {
      try {
        const { stdout } = await run(process.execPath, [CLI, '--input', target, ...extra], { cwd: projectDirectory })
        return { code: 0, stdout }
      } catch (error) {
        return { code: error.code, stdout: error.stdout }
      }
    }
    const json = await invoke(['--json', ...args])
    const human = await invoke(args)
    assert.equal(json.code, human.code, 'the two invocations must agree on the exit code')
    return { code: json.code, report: JSON.parse(json.stdout), text: human.stdout }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** The human report line that names a rule. Carries no expectations either. */
function line(text, ruleId) {
  const found = text.split('\n').find((candidate) => candidate.includes(` ${ruleId} `))
  assert.notEqual(found, undefined, `the human report must name ${ruleId}`)
  return found
}

/* ------------------------------------------------------------------------- *
 * Rules whose severity alone decides the verdict. Nothing else in these runs
 * is wrong and none of them makes the run incomplete, so `error` is the only
 * thing keeping each one out of a green exit 0.
 * ------------------------------------------------------------------------- */

test('a boundary duplicate fails the run and exits 1', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a', 'b'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: null },
    ],
  })
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'record-duplicated').startsWith('ERROR'), true)
})

test('a corpus record on no page fails the run and exits 1', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['a'], nextCursor: null }],
  })
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'record-missing').startsWith('ERROR'), true)
})

test('a served record the corpus does not declare fails the run and exits 1', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a', 'z'], nextCursor: null }],
  })
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'record-unknown').startsWith('ERROR'), true)
})

test('a record served twice inside one page fails the run and exits 1', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a', 'a'], nextCursor: null }],
  })
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'record-repeated-in-page').startsWith('ERROR'), true)
})

test('a page bigger than the declared page limit fails the run and exits 1', async () => {
  const { code, report, text } = await runCli({
    pageLimit: 1,
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['a', 'b'], nextCursor: null }],
  })
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'page-over-limit').startsWith('ERROR'), true)
})

test('an empty-string terminator fails the run and exits 1', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a'], nextCursor: '' }],
  })
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'terminator-ambiguous').startsWith('ERROR'), true)
})

/* ------------------------------------------------------------------------- *
 * Rules that are deliberately not errors. A promotion is as much a drift as a
 * demotion: it would fail builds over a legal pagination shape.
 * ------------------------------------------------------------------------- */

test('an empty page in the middle is a warning: the run still passes and exits 0', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: [], nextCursor: 'p3' },
      { cursor: 'p3', records: ['b'], nextCursor: null },
    ],
  })
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'empty-page-not-last').startsWith('WARNING'), true)
})

test('a short page before the last is a warning: the run still passes and exits 0', async () => {
  const { code, report, text } = await runCli({
    pageLimit: 2,
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: null },
    ],
  })
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'page-short-before-last').startsWith('WARNING'), true)
})

test('a page nothing leads to is a warning: the run still passes and exits 0', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: null },
      { cursor: 'orphan', records: ['a'], nextCursor: null },
    ],
  })
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'page-unreachable').startsWith('WARNING'), true)
})

test('an empty last page is information: the run passes and exits 0', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: [], nextCursor: null },
    ],
  })
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(line(text, 'terminal-page-empty').startsWith('INFO'), true)
})

/* ------------------------------------------------------------------------- *
 * Rules that also make the run incomplete. The exit code is 2 either way, so
 * the literal error count and the printed severity word are what notice a
 * demotion here.
 * ------------------------------------------------------------------------- */

test('a repeated cursor is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: 'p2' },
    ],
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'cursor-repeated').startsWith('ERROR'), true)
  assert.equal(line(text, 'completeness-unknown').startsWith('ERROR'), true)
})

test('a cursor no page answers is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'b'],
    pages: [{ cursor: null, records: ['a'], nextCursor: 'gone' }],
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'cursor-unknown').startsWith('ERROR'), true)
  assert.equal(line(text, 'completeness-unknown').startsWith('ERROR'), true)
})

test('the page bound is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    {
      corpus: ['a', 'b', 'c'],
      pages: [
        { cursor: null, records: ['a'], nextCursor: 'p2' },
        { cursor: 'p2', records: ['b'], nextCursor: 'p3' },
        { cursor: 'p3', records: ['c'], nextCursor: null },
      ],
    },
    ['--max-pages', '1'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 2)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'page-limit-exceeded').startsWith('ERROR'), true)
  assert.equal(line(text, 'completeness-unknown').startsWith('ERROR'), true)
  assert.equal(line(text, 'page-unreachable').startsWith('WARNING'), true)
})

test('the record bound is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    {
      corpus: ['a', 'b'],
      pages: [
        { cursor: null, records: ['a'], nextCursor: 'p2' },
        { cursor: 'p2', records: ['b'], nextCursor: null },
      ],
    },
    ['--max-records', '1'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'record-limit-exceeded').startsWith('ERROR'), true)
})

test('the time bound, an unwalked run and an unknown completeness are three errors at exit 2', async () => {
  const { code, report, text } = await runCli(
    { corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] },
    ['--max-millis', '0'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.errors, 3)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'time-limit-exceeded').startsWith('ERROR'), true)
  assert.equal(line(text, 'no-pages-fetched').startsWith('ERROR'), true)
  assert.equal(line(text, 'completeness-unknown').startsWith('ERROR'), true)
})

test('an unknown scenario key is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a'], nextCursor: null }],
    nextcursor: 'typo',
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'scenario-invalid').startsWith('ERROR'), true)
})

test('a scenario past the byte bound is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    { corpus: ['a'], pages: [{ cursor: null, records: ['a'], nextCursor: null }] },
    ['--max-scenario-bytes', '10'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'scenario-too-large').startsWith('ERROR'), true)
})

test('a scenario past the declared-page bound is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    {
      corpus: ['a', 'b'],
      pages: [
        { cursor: null, records: ['a'], nextCursor: 'p2' },
        { cursor: 'p2', records: ['b'], nextCursor: null },
      ],
    },
    ['--max-scenario-pages', '1'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'scenario-too-many-pages').startsWith('ERROR'), true)
})

test('a corpus past its bound is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    { corpus: ['a', 'b'], pages: [{ cursor: null, records: ['a', 'b'], nextCursor: null }] },
    ['--max-corpus', '1'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'corpus-too-large').startsWith('ERROR'), true)
})

test('a corpus listing one identity twice is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'a'],
    pages: [{ cursor: null, records: ['a'], nextCursor: null }],
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'corpus-duplicate-id').startsWith('ERROR'), true)
})

test('an over-long identity is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    { corpus: ['abcdef'], pages: [{ cursor: null, records: ['abcdef'], nextCursor: null }] },
    ['--max-id-length', '3'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'record-id-too-long').startsWith('ERROR'), true)
})

test('an unsupported pagination style is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli({
    style: 'offset',
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a'], nextCursor: null }],
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'unsupported-pagination-style').startsWith('ERROR'), true)
})

test('a findings cap is an error, and the run is incomplete at exit 2', async () => {
  const { code, report, text } = await runCli(
    {
      corpus: ['a', 'b', 'c'],
      pages: [
        { cursor: null, records: ['a', 'b', 'c'], nextCursor: 'p2' },
        { cursor: 'p2', records: ['a', 'b', 'c'], nextCursor: null },
      ],
    },
    ['--max-findings', '1'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(line(text, 'too-many-findings').startsWith('ERROR'), true)
})

test('a scenario that is not UTF-8 is an error, and the run is incomplete at exit 2', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-severity-'))
  try {
    const target = join(base, 'scenario.json')
    await writeFile(target, Buffer.from([0x7b, 0xff, 0x7d]))
    const invoke = async (extra) => {
      try {
        const { stdout } = await run(process.execPath, [CLI, '--input', target, ...extra], { cwd: projectDirectory })
        return { code: 0, stdout }
      } catch (error) {
        return { code: error.code, stdout: error.stdout }
      }
    }
    const json = await invoke(['--json'])
    const human = await invoke([])
    const report = JSON.parse(json.stdout)

    assert.equal(report.status, 'incomplete')
    assert.equal(json.code, 2)
    assert.equal(human.code, 2)
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.info, 0)
    assert.equal(line(human.stdout, 'scenario-not-utf8').startsWith('ERROR'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a scenario that cannot be read is an error, and the run is incomplete at exit 2', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-severity-'))
  try {
    const target = join(base, 'absent.json')
    const invoke = async (extra) => {
      try {
        const { stdout } = await run(process.execPath, [CLI, '--input', target, ...extra], { cwd: projectDirectory })
        return { code: 0, stdout }
      } catch (error) {
        return { code: error.code, stdout: error.stdout }
      }
    }
    const json = await invoke(['--json'])
    const human = await invoke([])
    const report = JSON.parse(json.stdout)

    assert.equal(report.status, 'incomplete')
    assert.equal(json.code, 2)
    assert.equal(human.code, 2)
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.info, 0)
    assert.equal(report.location, undefined)
    assert.equal(line(human.stdout, 'scenario-unreadable').startsWith('ERROR'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------------- *
 * The shape of the contract itself, so that a demotion cannot be hidden by
 * changing what an exit code means.
 * ------------------------------------------------------------------------- */

test('a clean scenario is the only thing that exits 0', async () => {
  const { code, report, text } = await runCli({
    corpus: ['a', 'b', 'c'],
    pages: [
      { cursor: null, records: ['a', 'b'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['c'], nextCursor: null },
    ],
  })
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 2)
  assert.equal(text.includes('ERROR'), false)
  assert.equal(text.includes('WARNING'), false)
})
