import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/api-pagination-tester.mjs')

const CLEAN = JSON.stringify(
  {
    name: 'orders',
    corpus: ['a', 'b'],
    pages: [
      { cursor: null, records: ['a'], nextCursor: 'p2' },
      { cursor: 'p2', records: ['b'], nextCursor: null },
    ],
  },
  null,
  2,
)

async function invoke(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'api-pagination-tester-readonly-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Every module in `src`, so a new one cannot be added outside the scan below. */
const SRC_MODULES = (await readdir(resolve(projectDirectory, 'src'))).filter((name) => name.endsWith('.mjs'))

/**
 * The refusal itself, not the help text printed under it.
 *
 * A configuration error prints the message and then the whole `--help` output,
 * which describes the destination policy in prose. Matching a phrase against
 * the entire stream would pass whether or not the check that produces it
 * exists; the first line is the tool's answer about this run.
 */
function reason(stderr) {
  return String(stderr).split('\n')[0]
}

test('the scenario file is unchanged by a run', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    await writeFile(target, CLEAN)
    const before = await stat(target)

    await invoke(['--input', target, '--json'])

    assert.equal(await readFile(target, 'utf8'), CLEAN)
    assert.equal((await stat(target)).size, before.size)
    assert.deepEqual(await readdir(base), ['scenario.json'], 'a run without --out creates nothing')
  })
})

test('src imports no write API at all', async () => {
  // The structural half of "read-only by default": there is no code path that
  // could write, whatever a future caller passes.
  for (const name of SRC_MODULES) {
    const source = await readFile(resolve(projectDirectory, 'src', name), 'utf8')
    for (const forbidden of ['writeFile', 'createWriteStream', 'appendFile', 'unlink', 'rename', 'rmdir', 'mkdir']) {
      assert.equal(source.includes(forbidden), false, `src/${name} reaches for ${forbidden}`)
    }
  }
})

test('src opens no socket, and imports nothing that could', async () => {
  for (const name of SRC_MODULES) {
    const source = await readFile(resolve(projectDirectory, 'src', name), 'utf8')
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'fetch(', 'XMLHttpRequest']) {
      assert.equal(source.includes(forbidden), false, `src/${name} reaches for ${forbidden}`)
    }
  }
})

test('--out refuses to be the scenario itself', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    await writeFile(target, CLEAN)

    const { code, stdout, stderr } = await invoke(['--input', target, '--out', target, '--out-root', base])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(reason(stderr), /same file as an input/)
    assert.equal(await readFile(target, 'utf8'), CLEAN, 'the scenario survived')
  })
})

test('--out refuses a symbolic link that points at the scenario', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    const alias = join(base, 'alias.json')
    await writeFile(target, CLEAN)
    await symlink(target, alias)

    // Refused a step earlier than the identity check now: resolving the link
    // is itself the dangerous act, so the link is refused on sight.
    const { code, stderr } = await invoke(['--input', target, '--out', alias, '--out-root', base, '--overwrite'])
    assert.equal(code, 2)
    assert.match(reason(stderr), /symbolic link/)
    assert.equal(await readFile(target, 'utf8'), CLEAN)
  })
})

test('--out refuses a HARD link to the scenario, which no path comparison can catch', async () => {
  /*
   * The defect this test exists for. A symbolic link has a target, so
   * `realpath` resolves it and a path comparison catches it. A hard link has no
   * target at all: two names for one inode resolve to two different real paths,
   * a path comparison says "different file", and the write destroys the input.
   * Hard links are ordinary -- `cp -l`, package stores, backup trees -- so
   * identity here is `dev` and `ino`.
   */
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    const hard = join(base, 'hard.json')
    await writeFile(target, CLEAN)
    await link(target, hard)

    const [one, other] = await Promise.all([stat(target), stat(hard)])
    assert.equal(one.ino, other.ino, 'the two names really are one file')
    assert.notEqual(await resolveReal(target), await resolveReal(hard), 'and their real paths really do differ')

    const { code, stderr } = await invoke(['--input', target, '--out', hard, '--out-root', base, '--overwrite'])
    assert.equal(code, 2)
    assert.match(reason(stderr), /same file as an input/)
    assert.equal(await readFile(target, 'utf8'), CLEAN, 'the scenario survived its own second name')
  })
})

async function resolveReal(path) {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}

test('--out refuses to replace an existing file without --overwrite, and replaces it with', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    const out = join(base, 'report.json')
    await writeFile(target, CLEAN)
    await writeFile(out, 'keep me')

    const refused = await invoke(['--input', target, '--out', out, '--out-root', base])
    assert.equal(refused.code, 2)
    assert.equal(refused.stdout, '')
    assert.match(reason(refused.stderr), /already exists/)
    assert.equal(await readFile(out, 'utf8'), 'keep me')

    const allowed = await invoke(['--input', target, '--out', out, '--out-root', base, '--overwrite'])
    assert.equal(allowed.code, 0)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'pass')
  })
})

test('an --out directory that does not exist is a configuration error, not a crash', async () => {
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    await writeFile(target, CLEAN)

    const { code, stdout, stderr } = await invoke([
      '--input', target,
      '--out', join(base, 'absent', 'report.json'),
      '--out-root', base,
    ])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.match(reason(stderr), /--out names a directory that does not exist/)
  })
})

test('a legitimate --out beside the scenario is allowed', async () => {
  // The other half of the refusals above: a guard that refused everything would
  // pass every test that only checks refusals.
  await withBase(async (base) => {
    const target = join(base, 'scenario.json')
    const out = join(base, 'report.json')
    await writeFile(target, CLEAN)

    const { code } = await invoke(['--input', target, '--out', out, '--out-root', base, '--json'])
    assert.equal(code, 0)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).tool, 'api-pagination-tester')
    assert.equal(await readFile(target, 'utf8'), CLEAN)
  })
})
