import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULE_SEVERITY, SEVERITY_VALUES, createFinding } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The severity table as a source of truth.
 *
 * These tests assert that the table, the documented catalog and the shipped
 * source agree. That is worth having, and it is *not* the guarantee: three
 * declarations that agree with each other can be edited together in one commit.
 *
 * The guarantee lives in `test/severity-behaviour.test.mjs`, which imports
 * nothing from `src/`, runs the real binary, and asserts exit codes and literal
 * inline counts. An exit code cannot be edited at all.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/pagination-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 27)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/pagination-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule the source emits is defined in the severity table', async () => {
  const source = [
    await readProjectFile('src/analyze.mjs'),
    await readProjectFile('src/index.mjs'),
    await readProjectFile('src/rules.mjs'),
    await readProjectFile('src/scenario.mjs'),
  ].join('\n')

  // Two construction shapes: `findings.add('rule-id', ...)` and the scenario
  // refusals, `new ScenarioError('rule-id', ...)`, plus the one literal the
  // findings cap writes.
  const added = [...source.matchAll(/findings\.add\(\s*\n?\s*'([a-z0-9-]+)'/g)].map((match) => match[1])
  const refused = [...source.matchAll(/ScenarioError\(\s*\n?\s*'([a-z0-9-]+)'/g)].map((match) => match[1])
  const capped = [...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1])
  const emitted = new Set([...added, ...refused, ...capped])

  assert.equal(emitted.size > 20, true, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to
  // prevent: it lets one rule be downgraded without the table, the docs or a
  // test noticing.
  for (const path of [
    'src/analyze.mjs',
    'src/index.mjs',
    'src/scenario.mjs',
    'bin/api-pagination-tester.mjs',
  ]) {
    const source = await readProjectFile(path)
    assert.equal(/severity:\s*'/.test(source), false, `${path} writes a severity literal`)
  }
})

test('every severity in the table is one of the three the contract allows', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(SEVERITY_VALUES.includes(severity), `${ruleId} carries an unknown severity`)
  }
  assert.deepEqual([...SEVERITY_VALUES], ['error', 'warning', 'info'])
})

test('a finding for a rule the table does not know throws rather than defaulting', () => {
  assert.throws(
    () => createFinding({ ruleId: 'not-a-rule', message: 'x', file: 'f', pointer: '', page: -1 }),
    /not in RULE_SEVERITY/,
  )
})

test('createFinding takes severity from the table and from nowhere else', () => {
  const finding = createFinding({
    ruleId: 'record-missing',
    // A severity supplied at the construction site is ignored, which is the
    // whole point of the table.
    severity: 'info',
    message: 'x',
    file: 'f.json',
    pointer: '/records/a',
    page: -1,
  })
  assert.equal(finding.severity, RULE_SEVERITY['record-missing'])
  assert.equal(finding.page, undefined, 'a page index below zero is not a page')
})

test('the table is frozen, so no caller can rewrite a severity at runtime', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    'use strict'
    RULE_SEVERITY['record-missing'] = 'info'
  }, TypeError)
})
