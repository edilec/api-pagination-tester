import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  KNOWN_UNSUPPORTED_STYLES,
  SUPPORTED_STYLES,
  ScenarioError,
  testScenarioObject,
  testScenarioText,
  validateScenario,
} from '../src/index.mjs'

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)

const clean = () => ({
  name: 'orders',
  style: 'cursor',
  pageLimit: 2,
  corpus: ['a', 'b', 'c'],
  pages: [
    { cursor: null, records: ['a', 'b'], nextCursor: 'p2' },
    { cursor: 'p2', records: ['c'], nextCursor: null },
  ],
})

test('a well-formed scenario validates and keeps its declared shape', () => {
  const scenario = validateScenario(clean(), DEFAULT_LIMITS)
  assert.equal(scenario.name, 'orders')
  assert.equal(scenario.style, 'cursor')
  assert.equal(scenario.pageLimit, 2)
  assert.deepEqual([...scenario.corpus], ['a', 'b', 'c'])
  assert.equal(scenario.pages.length, 2)
  assert.equal(scenario.pages[0].cursor, null)
  assert.equal(scenario.pages[1].index, 1)
})

test('a clean scenario passes with no findings at all', async () => {
  const report = await testScenarioObject(clean())
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.corpus, 3)
  assert.equal(report.summary.distinctRecords, 3)
})

test('an unknown scenario key is refused rather than ignored', async () => {
  const document = { ...clean(), nextcursor: 'typo' }
  const report = await testScenarioObject(document)
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.equal(report.status, 'incomplete')
  assert.match(report.findings[0].message, /Unknown scenario key "nextcursor"/)
})

test('an unknown page key is refused rather than ignored', async () => {
  const document = clean()
  document.pages[0] = { cursor: null, records: ['a', 'b'], nextCursor: 'p2', next_cursor: 'p2' }
  const report = await testScenarioObject(document)
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.equal(report.findings[0].location.pointer, '/pages/0/next_cursor')
})

test('an absent nextCursor is refused, because absence is exactly the ambiguity', async () => {
  const document = clean()
  document.pages[1] = { cursor: 'p2', records: ['c'] }
  const report = await testScenarioObject(document)
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.equal(report.findings[0].location.pointer, '/pages/1/nextCursor')
})

test('two pages claiming one cursor are refused', async () => {
  const document = clean()
  document.pages.push({ cursor: 'p2', records: ['c'], nextCursor: null })
  const report = await testScenarioObject(document)
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.match(report.findings[0].message, /one request has two answers/)
})

test('a scenario with no initial page is refused', async () => {
  const document = clean()
  document.pages[0] = { cursor: 'p1', records: ['a', 'b'], nextCursor: 'p2' }
  const report = await testScenarioObject(document)
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.match(report.findings[0].message, /nowhere to start/)
})

test('an empty corpus is refused, because there is no ground truth to compare against', async () => {
  const report = await testScenarioObject({ ...clean(), corpus: [] })
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.equal(report.findings[0].location.pointer, '/corpus')
})

test('a non-string record id is refused rather than coerced', async () => {
  const document = clean()
  document.pages[0].records = ['a', 7]
  const report = await testScenarioObject(document)
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.equal(report.findings[0].location.pointer, '/pages/0/records/1')
})

test('a corpus that lists one identity twice is refused, not silently deduplicated', async () => {
  const report = await testScenarioObject({ ...clean(), corpus: ['a', 'b', 'a'] })
  assert.deepEqual(ruleIds(report), ['corpus-duplicate-id'])
  assert.equal(report.status, 'incomplete')
  assert.match(report.findings[0].message, /cannot be told apart/)
})

test('the supported style is exercised and every other style is reported unsupported', async () => {
  assert.deepEqual([...SUPPORTED_STYLES], ['cursor'])
  for (const style of Object.keys(KNOWN_UNSUPPORTED_STYLES)) {
    const report = await testScenarioObject({ ...clean(), style })
    assert.deepEqual(ruleIds(report), ['unsupported-pagination-style'], `${style} must be reported, not assumed`)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.equal(report.walk.style, null, 'nothing was walked, so no style was exercised')
  }
})

test('a style nobody has heard of is reported unsupported too, never treated as satisfied', async () => {
  const report = await testScenarioObject({ ...clean(), style: 'graphql-relay' })
  assert.deepEqual(ruleIds(report), ['unsupported-pagination-style'])
  assert.match(report.findings[0].message, /not recognised at all/)
  assert.equal(report.status, 'incomplete')
})

test('a scenario that is not JSON is refused with a report, not a crash', async () => {
  const report = await testScenarioText('{ not json')
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.equal(report.status, 'incomplete')
})

test('a scenario that is not an object is refused', async () => {
  const report = await testScenarioText('[1, 2]')
  assert.deepEqual(ruleIds(report), ['scenario-invalid'])
  assert.match(report.findings[0].message, /must be a JSON object/)
})

test('bytes that are not UTF-8 are refused by the decoder, not guessed at', async () => {
  const { testScenarioBytes } = await import('../src/index.mjs')
  const report = await testScenarioBytes(new Uint8Array([0x7b, 0xff, 0x7d]))
  assert.deepEqual(ruleIds(report), ['scenario-not-utf8'])
  assert.equal(report.status, 'incomplete')
})

test('a validation refusal carries its rule id so the caller never has to guess', () => {
  assert.throws(
    () => validateScenario({ corpus: ['a'], pages: [] }, DEFAULT_LIMITS),
    (error) => error instanceof ScenarioError && error.ruleId === 'scenario-invalid',
  )
})

test('the public entry points refuse unknown options and bad argument types', async () => {
  await assert.rejects(() => testScenarioObject(clean(), { limit: {} }), TypeError)
  await assert.rejects(() => testScenarioObject(clean(), { limits: null }), TypeError)
  await assert.rejects(() => testScenarioObject(clean(), { limits: { maxPage: 3 } }), TypeError)
  await assert.rejects(() => testScenarioObject(clean(), { limits: { maxPages: 0 } }), TypeError)
  await assert.rejects(() => testScenarioObject(clean(), { file: '  ' }), TypeError)
  await assert.rejects(() => testScenarioObject(clean(), { clock: 'now' }), TypeError)
  await assert.rejects(() => testScenarioText(7), TypeError)
})
