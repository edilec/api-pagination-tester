import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

const CLEAN = {
  name: 'orders',
  corpus: ['a', 'b'],
  pages: [
    { cursor: null, records: ['a'], nextCursor: 'p2' },
    { cursor: 'p2', records: ['b'], nextCursor: null },
  ],
}

async function invoke(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory, ...options })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-cli-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('--help prints usage on stdout and exits 0', async () => {
  const { code, stdout } = await invoke(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /^api-pagination-tester/)
  assert.match(stdout, /--input FILE/)
  assert.match(stdout, /An empty page is not a last page/)
  assert.match(stdout, /No socket is opened/)
  assert.equal((await invoke(['-h'])).stdout, stdout)
})

test('an unknown option is a configuration error: stdout stays empty', async () => {
  const { code, stdout, stderr } = await invoke(['--input', 'examples/orders-clean.json', '--jsonn'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /Unknown option "--jsonn"/)
})

test('a missing --input is a configuration error', async () => {
  const { code, stdout, stderr } = await invoke(['--json'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /--input is required/)
})

test('a flag that carries a value refuses to be given twice', async () => {
  const { code, stdout, stderr } = await invoke([
    '--input',
    'examples/orders-clean.json',
    '--input',
    'examples/orders-broken.json',
  ])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /--input was given more than once/)
})

test('--json puts a parseable report on stdout and diagnostics on stderr', async () => {
  const { code, stdout, stderr } = await invoke(['--input', 'examples/orders-clean.json', '--json'])
  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.tool, 'api-pagination-tester')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.status, 'pass')
  assert.equal(stderr.length > 0, true, 'a non-empty stderr is correct; it carries the diagnostics')
  assert.equal(stderr.includes('{'), false, 'no report ever reaches stderr')
})

test('the human report names the file, the walk and every finding', async () => {
  const { code, stdout } = await invoke(['--input', 'examples/orders-broken.json'])
  assert.equal(code, 1)
  assert.match(stdout, /^orders-broken \(cursor\): 4 page\(s\) walked/)
  assert.match(stdout, /ended on last-page/)
  assert.match(stdout, /ERROR\s+orders-broken\.json\/records\/ord-2 record-duplicated/)
  assert.match(stdout, /ERROR\s+orders-broken\.json\/records\/ord-4 record-missing/)
  assert.match(stdout, /WARNING\s+orders-broken\.json\/pages\/2\/records empty-page-not-last/)
})

test('the three exit codes are reachable from the shipped examples', async () => {
  assert.equal((await invoke(['--input', 'examples/orders-clean.json'])).code, 0)
  assert.equal((await invoke(['--input', 'examples/orders-broken.json'])).code, 1)
  assert.equal((await invoke(['--input', 'examples/catalog-cycle.json'])).code, 2)
})

test('an absolute host path never reaches the report', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    await writeFile(target, JSON.stringify(CLEAN))
    const { stdout } = await invoke(['--input', target, '--json'])
    const report = JSON.parse(stdout)
    assert.equal(stdout.includes(base), false, 'the temporary directory must not appear anywhere in the report')
    assert.equal(report.summary.checked, 2)
  })
})

test('--root makes the reported path relative to the declared root', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'fixtures'), { recursive: true })
    const target = join(base, 'fixtures', 'scenario.json')
    await writeFile(target, JSON.stringify({ ...CLEAN, corpus: ['a', 'b', 'c'] }))
    const { code, stdout } = await invoke(['--input', target, '--root', base, '--json'])
    assert.equal(code, 1)
    const report = JSON.parse(stdout)
    assert.equal(report.findings[0].location.file, 'fixtures/scenario.json')
  })
})

test('a symlink out of the declared root is refused, resolved rather than spelled', async () => {
  await withBase(async (base) => {
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.json'), JSON.stringify(CLEAN))
    // Nothing about this path spells a traversal; only the resolved path does.
    await symlink(join(outside, 'secret.json'), join(root, 'scenario.json'))

    const { code, stdout } = await invoke(['--input', join(root, 'scenario.json'), '--root', root, '--json'])
    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'scenario-unreadable')
    assert.match(report.findings[0].message, /outside the declared root/)
  })
})

test('a root that is itself a symlink still accepts the files inside it', async () => {
  // The over-correction: comparing a real root against an unresolved path
  // refuses files that genuinely are inside the root. A false refusal is a bug
  // too, so both sides are resolved.
  await withBase(async (base) => {
    const real = join(base, 'real')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'scenario.json'), JSON.stringify(CLEAN))
    const linked = join(base, 'linked')
    await symlink(real, linked)

    const { code, stdout } = await invoke(['--input', join(linked, 'scenario.json'), '--root', linked, '--json'])
    assert.equal(code, 0)
    assert.equal(JSON.parse(stdout).status, 'pass')
  })
})

test('a root that cannot be read is a configuration error, even when the input is missing too', async () => {
  await withBase(async (base) => {
    const { code, stdout, stderr } = await invoke([
      '--input',
      join(base, 'absent.json'),
      '--root',
      join(base, 'no-such-root'),
    ])
    assert.equal(code, 2)
    assert.equal(stdout, '', 'a misspelled root must not be reported as an ordinary unreadable input')
    assert.match(stderr, /Root could not be read/)
  })
})

test('a directory given as --input is reported, not crashed on', async () => {
  await withBase(async (base) => {
    const { code, stdout } = await invoke(['--input', base, '--json'])
    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.findings[0].ruleId, 'scenario-unreadable')
    assert.match(report.findings[0].message, /not a regular file/)
  })
})

test('--out writes the same JSON the --json flag prints', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    const out = join(base, 'report.json')
    await writeFile(target, JSON.stringify(CLEAN))

    const written = await invoke(['--input', target, '--out', out, '--out-root', base])
    assert.equal(written.code, 0)
    const printed = await invoke(['--input', target, '--json'])
    assert.equal(await readFile(out, 'utf8'), printed.stdout)
  })
})
