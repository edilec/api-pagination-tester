#!/usr/bin/env node

import { realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { excerpt, formatReport, testScenarioFile } from '../src/index.mjs'

const HELP = `api-pagination-tester

Exercise a pagination state machine against an in-memory mock API and report
what a client walking that API would end up holding.

The scenario declares the corpus of record identities the API is supposed to
expose and the exact pages it serves, keyed by cursor. The walk follows cursors
from the initial request and proves three things a client cannot prove for
itself: that no record was served on two pages, that no corpus record was served
on none, and that the walk terminates.

An empty page is not a last page. Zero records with a next cursor is an empty
page in the middle of a collection; no next cursor is the end. Clients that
conflate the two either truncate at the first empty page or refetch forever, so
the two states are reported by separate rules.

No socket is opened. The mock is a lookup in this process.

Usage:
  api-pagination-tester --input SCENARIO.json [--json] [--out FILE] [--root DIR]
                        [limits]

Options:
  --input FILE            The scenario to run (required)
  --root DIR              Report paths relative to this root, and refuse a
                          scenario that resolves outside it (default: the
                          scenario's own directory)
  --json                  Emit the machine-readable report on stdout
  --out FILE              Also write the JSON report to FILE. Never the input,
                          and never over an existing file without --overwrite
  --overwrite             Allow --out to replace an existing file
  -h, --help              Show this help

Limits (exceeding one is a finding and an incomplete report, never a silent cut):
  --max-scenario-bytes N  Bytes read from the scenario (default 4194304)
  --max-scenario-pages N  Pages a scenario may declare (default 2000)
  --max-corpus N          Record identities a corpus may declare (default 100000)
  --max-pages N           Pages one walk may fetch (default 1000)
  --max-records N         Records one walk may take in (default 100000)
  --max-id-length N       Characters in a record id or cursor (default 200)
  --max-findings N        Findings collected (default 1000)
  --max-millis N          Milliseconds of walking, 0 for none (default 10000)

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

Exit codes:
  0  the walk completed and the pagination contract held
  1  the walk completed and the pagination contract failed
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

/**
 * A value from argv, bounded and stripped of anything that forges a line.
 *
 * An argument is as untrusted as the file it names: paths arrive from directory
 * listings, CI variables and globs. ESC opens a terminal escape sequence and
 * U+2028 is a line break to a great many readers, so a diagnostic that quoted
 * either back verbatim could be made to read as something else -- the same
 * forgery the report path already refuses to let the scenario commit.
 */
const quote = (value) => excerpt(String(value), 200)

const LIMIT_FLAGS = new Map([
  ['--max-corpus', 'maxCorpus'],
  ['--max-findings', 'maxFindings'],
  ['--max-id-length', 'maxIdLength'],
  ['--max-millis', 'maxMillis'],
  ['--max-pages', 'maxPages'],
  ['--max-records', 'maxRecords'],
  ['--max-scenario-bytes', 'maxScenarioBytes'],
  ['--max-scenario-pages', 'maxScenarioPages'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { input: null, root: null, out: null, overwrite: false, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--input a --input b` walks a scenario nobody named and
   * `--max-pages 5 --max-pages 1` enforces a limit nobody asked for. That is
   * the same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--overwrite') options.overwrite = true
    else if (argument === '--input') {
      once('--input')
      options.input = takeValue('--input')
    } else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const floor = argument === '--max-millis' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < floor) {
        throw new Error(`${argument} requires an integer of at least ${floor}`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${quote(argument)}"`)
  }

  if (options.input === null) throw new Error('--input is required')
  return options
}

/**
 * Whether two existing paths name the same file.
 *
 * Identity is the inode, not the resolved path. `realpath` answers this for a
 * symbolic link, which has a target to resolve, and for nothing else: a hard
 * link has no target, so two names for one inode resolve to two different real
 * paths. A path comparison then says "different file" and the write destroys
 * the scenario. Hard links are ordinary -- `cp -l`, package stores, backup
 * trees -- so the destination is compared by `dev` and `ino`.
 */
async function sameFile(left, right) {
  const [one, other] = await Promise.all([stat(left).catch(() => null), stat(right).catch(() => null)])
  if (one === null || other === null) return false
  return one.dev === other.dev && one.ino === other.ino
}

/**
 * Decide where a report may be written.
 *
 * Two refusals, both about not destroying the subject of the run: the report
 * never goes to the scenario itself, compared on the inode so that neither a
 * symbolic link nor a hard link can launder one into the other, and it never
 * replaces an existing file unless the caller said so.
 */
async function resolveOutput(outPath, inputPath, overwrite) {
  const target = resolve(outPath)
  const inputReal = await realpath(resolve(inputPath)).catch(() => null)
  // An existing target is compared by its own real path, so a symlink pointing
  // at the scenario is caught; one that does not exist yet is composed from its
  // real directory, because there is nothing to resolve.
  const existingReal = await realpath(target).catch(() => null)
  const directory = await realpath(dirname(target)).catch(() => null)
  if (directory === null) throw new Error(`--out directory does not exist: ${quote(dirname(outPath))}`)
  const targetReal = existingReal ?? join(directory, basename(target))
  const identical = existingReal !== null && inputReal !== null && (await sameFile(existingReal, inputReal))
  if (inputReal !== null && (targetReal === inputReal || identical)) {
    throw new Error('--out must not be the scenario file; this tool never rewrites what it runs')
  }
  if (existingReal !== null && !overwrite) {
    throw new Error(`--out already exists: ${quote(outPath)} (pass --overwrite to replace it)`)
  }
  return targetReal
}

async function main(argv) {
  let options
  let outTarget = null
  try {
    options = parseArguments(argv)
    if (!options.help && options.out !== null) {
      outTarget = await resolveOutput(options.out, options.input, options.overwrite)
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await testScenarioFile({
      input: options.input,
      limits: options.limits,
      ...(options.root === null ? {} : { root: options.root }),
    })
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  let writeFailed = false
  if (outTarget !== null) {
    try {
      await writeFile(outTarget, json)
    } catch (error) {
      writeFailed = true
      process.stderr.write(`The report could not be written to --out: ${quote(error.code ?? error.message)}\n`)
    }
  }

  process.stdout.write(options.json ? json : formatReport(report))

  if (writeFailed) return 2
  if (report.status === 'incomplete') {
    // `observedCorpus`, not `distinctRecords`: the walk may have served ids the
    // corpus never declared, and counting those as known records observed
    // overstates the evidence in the one line that exists to say how little of
    // it there is.
    const { checked, corpus, observedCorpus } = report.summary
    process.stderr.write(
      `incomplete: ${checked} page(s) were walked and ${observedCorpus} of ${corpus} known record(s) were ` +
        'observed. The findings say what was not examined. Unknown is not a pass.\n',
    )
    return 2
  }
  if (report.status === 'fail') {
    process.stderr.write(`failed: ${report.summary.errors} error(s) in the pagination contract.\n`)
    return 1
  }
  process.stderr.write(
    `ok: ${report.summary.pages} page(s) walked, ${report.summary.observedCorpus} of ${report.summary.corpus} ` +
      'known record(s) observed exactly once.\n',
  )
  return 0
}

process.exitCode = await main(process.argv.slice(2))
