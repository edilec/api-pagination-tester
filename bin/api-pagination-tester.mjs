#!/usr/bin/env node

import { lstat, writeFile } from 'node:fs/promises'

import { DestinationError, assertWritableDestination, excerpt, formatReport, testScenarioFile } from '../src/index.mjs'

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
  --out-root DIR          Tree --out must resolve inside (default: the working
                          directory)
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

--out is checked before the scenario is opened. A symbolic link at the
destination, a symlinked directory on the way to it, a path that resolves
outside --out-root and a hard link to the scenario are each refused: every one
of them writes the report over a file this tool was never asked to touch.

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
  const options = { input: null, root: null, out: null, outRoot: null, overwrite: false, json: false, limits: {} }
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
    } else if (argument === '--out-root') {
      once('--out-root')
      options.outRoot = takeValue('--out-root')
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
  if (options.outRoot !== null && options.out === null) {
    throw new Error('--out-root has no meaning without --out')
  }
  if (options.overwrite && options.out === null) {
    throw new Error('--overwrite has no meaning without --out')
  }
  return options
}

/**
 * Decide where a report may be written.
 *
 * The first version of this function resolved the destination and compared the
 * result with the scenario. That caught a symbolic link pointing AT the
 * scenario and a hard link to it, and missed the case that actually destroys
 * files: a symbolic link pointing anywhere else. `realpath` resolved it, the
 * resolved path was not the scenario, and `writeFile` went through the link.
 * Measured here, with `--overwrite`: a 9-byte file outside the tree became a
 * 1241-byte report at exit 0. Without an existing target to resolve -- a link
 * whose target does not exist yet -- the report was created out there instead,
 * and `--overwrite` was not even needed. A symlinked parent directory did the
 * same thing one level up.
 *
 * `assertWritableDestination` carries the reasoning for all three holes, and
 * the identity comparison that answers the hard link lives inside it now: the
 * inode is the only thing two names for one file share.
 *
 * `--overwrite` is a separate question and is asked afterwards. The guard has
 * already established that the destination is the file the caller named; this
 * refuses replacing a file the caller named but did not mean to lose.
 */
async function resolveOutput(outPath, inputPath, overwrite, outRoot) {
  let target
  try {
    target = await assertWritableDestination(outPath, {
      inputs: [inputPath],
      root: outRoot,
      label: '--out',
      rootLabel: '--out-root',
    })
  } catch (error) {
    if (!(error instanceof DestinationError)) throw error
    throw new Error(error.message)
  }
  const exists = await lstat(target).then(() => true, () => false)
  if (exists && !overwrite) {
    throw new Error(`--out already exists: ${quote(outPath)} (pass --overwrite to replace it)`)
  }
  return target
}

async function main(argv) {
  let options
  let outTarget = null
  try {
    options = parseArguments(argv)
    if (!options.help && options.out !== null) {
      outTarget = await resolveOutput(
        options.out,
        options.input,
        options.overwrite,
        options.outRoot ?? process.cwd(),
      )
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
