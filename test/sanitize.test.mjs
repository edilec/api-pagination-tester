import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { formatReport, isForgeable, testScenarioObject } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

/**
 * Sanitising, tested where it is usually missed.
 *
 * Several tools in this catalog sanitised an `evidence` field carefully and let
 * an identifier through, so a record id containing a newline forged whole lines
 * in the report. Here the untrusted strings *are* identifiers -- record ids and
 * cursors, both of which reach the report as text, as JSON pointers and as
 * entries in the walk summary -- so every case below arrives through one.
 */

// Control characters are built from code points rather than written as escape
// sequences; an escape in a source file is one editing accident away from
// becoming the literal character it names.
const ch = (code) => String.fromCodePoint(code)

const CLASSES = [
  ['C0 line feed', 0x0a],
  ['C0 escape', 0x1b],
  ['C0 null', 0x00],
  ['DEL', 0x7f],
  ['C1 NEL', 0x85],
  ['C1 CSI', 0x9b],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['arabic letter mark', 0x061c],
  ['left-to-right mark', 0x200e],
  ['right-to-left override', 0x202e],
  ['first strong isolate', 0x2068],
]

test('every forgeable class is stripped when it arrives through a record id', async () => {
  for (const [name, code] of CLASSES) {
    const id = `ghost${ch(code)}row`
    const report = await testScenarioObject({
      corpus: ['kept'],
      pages: [{ cursor: null, records: ['kept', id], nextCursor: null }],
    })

    const serialised = JSON.stringify(report)
    assert.equal(serialised.includes(ch(code)), false, `${name} survived into the report`)
    assert.equal(isForgeable(code), true)
    assert.deepEqual(report.walk.records.unknown, ['ghost row'], `${name} must become a space`)
    assert.equal(report.findings[0].location.pointer, '/records/ghost row', `${name} must be stripped from the pointer`)
    assert.equal(report.findings[0].message.includes(ch(code)), false)

    // The human report is where a forged line would actually appear. Its own
    // line feeds are its own, so the line feed case is checked by counting
    // lines instead, in the test below.
    const text = formatReport(report)
    if (code !== 0x0a) assert.equal(text.includes(ch(code)), false, `${name} survived into the human report`)
    assert.equal(text.trim().split('\n').filter((line) => /^(ERROR|WARNING|INFO)/.test(line)).length, 1)
  }
})

test('a record id cannot forge an extra report line', async () => {
  // Two line feeds and a severity word: if identifiers were not sanitised this
  // would print as its own ERROR line and read as a finding nobody raised.
  const forged = `x${ch(0x0a)}ERROR   forged.json/records/none invented-rule a finding nobody raised${ch(0x0a)}y`
  const report = await testScenarioObject({
    corpus: ['kept'],
    pages: [{ cursor: null, records: ['kept', forged], nextCursor: null }],
  })

  const lines = formatReport(report).trim().split('\n')
  const severityLines = lines.filter((line) => /^(ERROR|WARNING|INFO)/.test(line))
  assert.equal(severityLines.length, 1, 'exactly one finding was raised, so exactly one line may say so')
  assert.equal(severityLines[0].includes('invented-rule'), true, 'the text is still shown, inline and defanged')
  assert.equal(lines.some((line) => line.startsWith('ERROR   forged.json')), false)
})

test('a cursor is sanitised on the way out too', async () => {
  const cursor = `page${ch(0x202e)}2`
  const report = await testScenarioObject({
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: cursor },
      { cursor, records: ['b'], nextCursor: null },
      { cursor: `orphan${ch(0x85)}page`, records: ['a'], nextCursor: null },
    ],
  })

  const serialised = JSON.stringify(report)
  assert.equal(serialised.includes(ch(0x202e)), false)
  assert.equal(serialised.includes(ch(0x85)), false)
  assert.equal(report.walk.pages[1].cursor, 'page 2')
  assert.deepEqual(report.walk.unreachablePages, ['orphan page'])
})

test('a scenario name is sanitised, not only the findings', async () => {
  const report = await testScenarioObject({
    name: `orders${ch(0x2028)}injected`,
    corpus: ['a'],
    pages: [{ cursor: null, records: ['a'], nextCursor: null }],
  })

  assert.equal(report.walk.scenario, 'orders injected')
  assert.equal(formatReport(report).includes(ch(0x2028)), false)
})

test('sanitising is an output step: two ids that differ only by a control character stay two ids', async () => {
  // If the guard normalised on the way *in*, these would collapse into one
  // identity and the tool would invent a boundary duplicate that the API never
  // served. Identity is always the raw value.
  const report = await testScenarioObject({
    corpus: [`row${ch(0x0a)}1`, 'row 1'],
    pages: [{ cursor: null, records: [`row${ch(0x0a)}1`, 'row 1'], nextCursor: null }],
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.walk.records.duplicated, [], 'no duplicate was manufactured by the guard')
  assert.equal(report.summary.distinctRecords, 2)
  assert.equal(report.summary.records, 2)
})

test('the real binary never writes a forgeable character to stdout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-sanitize-'))
  try {
    const target = join(base, 'scenario.json')
    await writeFile(
      target,
      JSON.stringify({
        name: `n${ch(0x9b)}m`,
        corpus: ['kept'],
        pages: [
          { cursor: null, records: ['kept', `bad${ch(0x1b)}[31mid`], nextCursor: `c${ch(0x202e)}2` },
          { cursor: `c${ch(0x202e)}2`, records: [], nextCursor: null },
        ],
      }),
    )
    const invoke = async (args) => {
      try {
        const { stdout } = await run(process.execPath, [CLI, '--input', target, ...args], { cwd: projectDirectory })
        return stdout
      } catch (error) {
        return error.stdout
      }
    }

    for (const stdout of [await invoke([]), await invoke(['--json'])]) {
      for (const [name, code] of CLASSES) {
        if (code === 0x0a) continue // the report is line-oriented; its own newlines are its own
        assert.equal(stdout.includes(ch(code)), false, `${name} reached stdout`)
      }
      assert.equal(stdout.includes(ch(0x1b)), false, 'no terminal escape sequence reaches a terminal')
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
