import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/text.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

/**
 * A scenario that does not parse must not be quoted back.
 *
 * `JSON.parse` has a failure message that embeds the input --
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- so a
 * scenario file short enough to be only a credential is reproduced in full by
 * its own error message, and a longer one is reproduced ten characters at a
 * time. That message used to be interpolated straight into the
 * `scenario-invalid` finding, which reaches stdout in both output modes.
 *
 * Sanitising and excerpting do not help: the quoted span sits at the *front*
 * of the message, so both leave it intact and cut the position off the end.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */
const CANARY = 'AKIAIOSFODNN7EXAMPLE'

// Longer than V8's ten-character window, so the leak is a prefix rather than
// the whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple'

async function invoke(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-parse-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const MIN_RUN = 8

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: V8 quotes a *window* around the offending
 * character, so a secret in the middle of a document leaks from its middle. An
 * assertion on the whole string alone would pass against a report that echoed
 * `AKIAIOSF` and called that truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join('\n')
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const run_ = secret.slice(start, start + length)
      assert.equal(haystack.includes(run_), false, `the output echoed ${JSON.stringify(run_)}`)
    }
  }
}

test('an unparseable scenario is not quoted back into the human report', async () => {
  await withBase(async (base) => {
    const input = join(base, 'scenario.json')
    await writeFile(input, CANARY)

    const { code, stdout, stderr } = await invoke(['--input', input])
    assert.equal(code, 2)
    assert.match(stdout, /scenario-invalid/)
    assertNoLeak(CANARY, stdout, stderr)
  })
})

test('an unparseable scenario is not quoted back into the JSON report', async () => {
  await withBase(async (base) => {
    const input = join(base, 'scenario.json')
    await writeFile(input, CANARY)

    const { code, stdout, stderr } = await invoke(['--input', input, '--json'])
    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.findings[0].ruleId, 'scenario-invalid')
    assertNoLeak(CANARY, stdout, stderr)
  })
})

test("a secret longer than V8's quoting window does not leak its prefix either", async () => {
  await withBase(async (base) => {
    const input = join(base, 'scenario.json')
    await writeFile(input, LONG_SECRET)

    const { stdout, stderr } = await invoke(['--input', input, '--json'])
    assertNoLeak(LONG_SECRET, stdout, stderr)
    assert.equal(stdout.includes('password=h'), false)
  })
})

test('a secret sitting mid-document does not leak through the windowed form', async () => {
  await withBase(async (base) => {
    // V8 answers this one with `Unexpected token '}', "[ }AKIAIOSFO"...`, the
    // shape that quotes a window rather than a prefix.
    const input = join(base, 'scenario.json')
    await writeFile(input, `[ }${CANARY}]`)

    const { stdout, stderr } = await invoke(['--input', input, '--json'])
    assertNoLeak(CANARY, stdout, stderr)
  })
})

test('the position, line and column of a parse failure survive', async () => {
  await withBase(async (base) => {
    const input = join(base, 'scenario.json')
    await writeFile(input, '{"corpus": ["a"] "pages": []}')

    const { stdout } = await invoke(['--input', input, '--json'])
    const [finding] = JSON.parse(stdout).findings
    assert.equal(finding.ruleId, 'scenario-invalid')
    assert.match(finding.message, /at position 17 \(line 1 column 18\)/)
  })
})

test('a parse failure still says something: an empty detail would be a defect of its own', async () => {
  await withBase(async (base) => {
    const input = join(base, 'scenario.json')
    await writeFile(input, CANARY)

    const { stdout } = await invoke(['--input', input, '--json'])
    const [finding] = JSON.parse(stdout).findings
    assert.match(finding.message, /unexpected token 'A'/)
  })
})

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text)
      throw new Error('that text parsed')
    } catch (error) {
      return parseFailureDetail(error)
    }
  }

  // The position form carries no input and is kept whole.
  assert.equal(
    detail('{"corpus": ["a"] "pages": []}'),
    "Expected ',' or '}' after property value in JSON at position 17 (line 1 column 18)",
  )
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)')
  assert.equal(detail(''), 'Unexpected end of JSON input')
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input')

  // All three windowed shapes: whole input, leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start of the document")
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start of the document")
  assert.equal(detail(`[ }${CANARY}]`), "unexpected token '}' near the start of the document")
  assert.equal(detail(`{"aaaaaaaaaaaaaa": [ }${CANARY} ]}`), "unexpected token '}' in the document")
})

test('parseFailureDetail refuses a document whose own text imitates a position', () => {
  // The position branch runs second on purpose. A document whose bytes read
  // "at position 12" would otherwise be sliced after its own quoted copy.
  let detail
  try {
    JSON.parse(`at position 12 ${CANARY}`)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assertNoLeak(CANARY, detail)
  assert.equal(detail.includes('at position 12'), false)
})

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'the document could not be parsed as JSON')
})
