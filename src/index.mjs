/**
 * api-pagination-tester
 *
 * Exercises a pagination state machine against an in-memory mock API built from
 * a scenario document, and reports what a client walking that API would end up
 * holding.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **No socket is ever opened.** The mock is a `Map` lookup in this process.
 *    A pagination contract is a property of what the responses say, and a
 *    transport would only add ways for the test to fail for reasons that are
 *    not about pagination. There is no network import in this package.
 * 2. **Records carry known identities.** The scenario declares the corpus the
 *    API is supposed to expose, which is what makes the two interesting
 *    verdicts possible at all: a record served on two pages is a boundary
 *    duplicate, and a corpus record served on no page is missing.
 * 3. **The walk always terminates.** Every requested cursor is remembered, so a
 *    cursor handed out twice ends the walk with a finding instead of spinning.
 * 4. **Unknown is never a pass.** A walk that stopped early -- a loop, a
 *    dangling cursor, a bound -- proves nothing about completeness, so it says
 *    so and the run is incomplete. Reporting unreached records as missing would
 *    be an assertion about evidence nobody obtained.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import { analyzeWalk } from './analyze.mjs'
import { FindingSet, SECTIONS, createFinding, sortFindings } from './rules.mjs'
import { ScenarioError, createMockApi, validateScenario } from './scenario.mjs'
import { cursorLabel, decodeUtf8, excerpt, parseFailureDetail } from './text.mjs'

import { walkPages } from './walk.mjs'

export { DestinationError, assertWritableDestination } from './write-guard.mjs'

export const TOOL_ID = 'api-pagination-tester'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A scenario is ordinary untrusted input, and a pagination walk is the one
 * shape of work that famously does not stop on its own. Every limit below is
 * explicit, overridable from the CLI, and named in a finding when it is hit.
 * Exceeding one produces an `incomplete` report -- never a quietly shorter
 * answer, and never a pass.
 *
 * `maxMillis` is the one limit that may be zero: the budget is spent once the
 * elapsed time reaches it, so zero is spent before the first fetch, which is
 * how the wiring between the flag and the clock is proven rather than assumed.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxCorpus: 100000,
  maxFindings: 1000,
  maxIdLength: 200,
  maxMillis: 10000,
  maxPages: 1000,
  maxRecords: 100000,
  maxScenarioBytes: 4194304,
  maxScenarioPages: 2000,
})

const ZERO_ALLOWED_LIMITS = Object.freeze(['maxMillis'])

const FILE_OPTIONS = Object.freeze(['clock', 'input', 'limits', 'root'])
const MEMORY_OPTIONS = Object.freeze(['clock', 'file', 'limits'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function rejectUnknownOptions(options, allowed) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
}

/**
 * Only an absent `limits` means "use the defaults".
 *
 * `null` is a value the caller computed and lost, not an omission, and
 * accepting it as `{}` is the same silent ignore this tool refuses everywhere
 * else: an unknown limit name and a fractional limit are both errors, so a
 * limits object that turned out to be null cannot be the one thing waved
 * through. A misspelled limit must not quietly leave the default in place.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    const floor = ZERO_ALLOWED_LIMITS.includes(name) ? 0 : 1
    if (!Number.isInteger(value) || value < floor) {
      throw new TypeError(`Limit "${name}" must be an integer of at least ${floor}`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

function validateClock(clock) {
  if (clock === undefined) return () => performance.now()
  if (typeof clock !== 'function') throw new TypeError('Clock must be a function returning milliseconds')
  return clock
}

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. Both sides of this comparison have been through
 * `realpath` before they arrive -- comparing a real root against a path that
 * was not resolved is the over-correction, and it refuses scenarios that
 * genuinely are inside a root reached through a symlink. A false refusal is a
 * bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

const EMPTY_VERDICT = Object.freeze({
  duplicated: [],
  missing: [],
  repeatedInPage: [],
  unknown: [],
  unreachablePages: [],
  distinct: 0,
  observedCorpus: 0,
})

const EMPTY_WALK = Object.freeze({
  pages: [],
  requested: [],
  served: 0,
  terminatedBy: null,
  repeatedCursor: null,
  danglingCursor: null,
  ambiguousTerminator: false,
  ambiguousFollows: false,
  probedEmptyCursor: false,
  complete: false,
})

/** Every id and cursor in the report is sanitised and bounded on the way out. */
const label = (value) => excerpt(value, 120)

function buildReport({ findings, scenario, result, verdict, bytes }) {
  const rows = sortFindings(findings.rows).map(createFinding)
  const errors = rows.filter((finding) => finding.severity === 'error').length
  const warnings = rows.filter((finding) => finding.severity === 'warning').length
  const status = findings.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: result.pages.length,
      errors,
      warnings,
      info: rows.length - errors - warnings,
      pages: result.pages.length,
      records: result.served,
      distinctRecords: verdict.distinct,
      observedCorpus: verdict.observedCorpus,
      corpus: scenario === null ? 0 : scenario.corpus.length,
      duplicated: verdict.duplicated.length,
      repeatedInPage: verdict.repeatedInPage.length,
      missing: verdict.missing.length,
      unknown: verdict.unknown.length,
      unreachablePages: verdict.unreachablePages.length,
      bytes,
    },
    walk: {
      scenario: scenario === null ? null : label(scenario.name),
      style: scenario === null ? null : label(scenario.style),
      pageLimit: scenario === null ? null : scenario.pageLimit,
      terminatedBy: result.terminatedBy,
      complete: result.complete,
      pages: result.pages.map((page) => ({
        index: page.index,
        cursor: page.cursor === null ? null : label(page.cursor),
        records: page.records.length,
        nextCursor: page.nextCursor === null ? null : label(page.nextCursor),
        empty: page.empty,
        terminal: page.terminal,
      })),
      records: {
        duplicated: verdict.duplicated.map(label),
        repeatedInPage: verdict.repeatedInPage.map(label),
        missing: verdict.missing.map(label),
        unknown: verdict.unknown.map(label),
      },
      unreachablePages: verdict.unreachablePages.map(label),
    },
    findings: rows,
  }
}

/**
 * A report for a scenario this tool refused to run.
 *
 * The single place where a scenario-level refusal marks the run incomplete.
 * Every such refusal arrives here, so none of them can acquire a different idea
 * of what "we obtained no evidence" means, and deleting this one assignment
 * changes the exit code of every one of them.
 */
function refusedReport(error, file, bytes) {
  const findings = new FindingSet({ file, maxFindings: DEFAULT_LIMITS.maxFindings })
  findings.add(error.ruleId, error.message, {
    section: SECTIONS.scenario,
    pointer: error.pointer,
    suggestion: error.suggestion,
    evidence: error.evidence,
  })
  findings.incomplete = true
  return buildReport({ findings, scenario: null, result: EMPTY_WALK, verdict: EMPTY_VERDICT, bytes })
}

/**
 * Run a scenario that is already a JavaScript object.
 *
 * The innermost entry point: every other one decodes, parses and then arrives
 * here, so the validation, the walk and the verdict cannot differ between them.
 */
export async function testScenarioObject(document, options = {}) {
  rejectUnknownOptions(options, MEMORY_OPTIONS)
  const file = options.file === undefined ? 'scenario.json' : options.file
  if (typeof file !== 'string' || file.trim() === '') throw new TypeError('File label must be a non-empty string')
  const limits = validateLimits(options.limits)
  const clock = validateClock(options.clock)
  return runScenario(document, { file: excerpt(file, 200), limits, clock, bytes: 0 })
}

async function runScenario(document, { file, limits, clock, bytes }) {
  let scenario
  try {
    scenario = validateScenario(document, limits)
  } catch (error) {
    if (error instanceof ScenarioError) return refusedReport(error, file, bytes)
    throw error
  }

  const findings = new FindingSet({ file, maxFindings: limits.maxFindings })
  const api = createMockApi(scenario)
  const result = await walkPages({ fetchPage: (cursor) => api.fetchPage(cursor), limits, clock })
  const verdict = analyzeWalk({ scenario, result, findings })
  return buildReport({ findings, scenario, result, verdict, bytes })
}

/**
 * Run a scenario from bytes.
 *
 * Decoding is strict and happens here, once, for every caller that has bytes:
 * a scenario that is not UTF-8 is refused by the decoder rather than inferred
 * from decoded text afterwards. There is no second, looser path -- the CLI, the
 * file entry point and this one all decode through `decodeUtf8`.
 */
export async function testScenarioBytes(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Bytes must be a Uint8Array')
  rejectUnknownOptions(options, MEMORY_OPTIONS)
  const file = options.file === undefined ? 'scenario.json' : options.file
  if (typeof file !== 'string' || file.trim() === '') throw new TypeError('File label must be a non-empty string')
  const limits = validateLimits(options.limits)
  const clock = validateClock(options.clock)
  const fileLabel = excerpt(file, 200)

  if (bytes.byteLength > limits.maxScenarioBytes) {
    return refusedReport(
      new ScenarioError(
        'scenario-too-large',
        `The scenario is ${bytes.byteLength} byte(s), past the maxScenarioBytes limit of ` +
          `${limits.maxScenarioBytes}. It was not read, so nothing was exercised.`,
        { suggestion: 'Raise --max-scenario-bytes, or split the scenario.' },
      ),
      fileLabel,
      bytes.byteLength,
    )
  }

  let text
  try {
    text = decodeUtf8(bytes)
  } catch {
    return refusedReport(
      new ScenarioError(
        'scenario-not-utf8',
        'The scenario is not valid UTF-8, so it was refused by the decoder rather than guessed at. Nothing in it ' +
          'was read.',
        { suggestion: 'Re-save the scenario as UTF-8. A scenario read through the wrong encoding describes an API nobody has.' },
      ),
      fileLabel,
      bytes.byteLength,
    )
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return refusedReport(
      new ScenarioError('scenario-invalid', `The scenario is not valid JSON: ${excerpt(parseFailureDetail(error), 160)}`, {
        suggestion: 'Check the scenario against docs/pagination-rules.md.',
      }),
      fileLabel,
      bytes.byteLength,
    )
  }

  return runScenario(document, { file: fileLabel, limits, clock, bytes: bytes.byteLength })
}

/** Run a scenario from text that does not live on disk. No filesystem access. */
export async function testScenarioText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Scenario text must be a string')
  return testScenarioBytes(new TextEncoder().encode(text), options)
}

/**
 * Run a scenario from a file.
 *
 * The file is opened read-only and never written to: this module imports no
 * write API at all. The reported `location.file` is relative to the declared
 * root, so an absolute host path never reaches the report.
 */
export async function testScenarioFile(options = {}) {
  rejectUnknownOptions(options, FILE_OPTIONS)
  if (typeof options.input !== 'string' || options.input.trim() === '') {
    throw new TypeError('An input path is required')
  }
  if (options.root !== undefined && (typeof options.root !== 'string' || options.root.trim() === '')) {
    throw new TypeError('Root must be a non-empty string')
  }
  const limits = validateLimits(options.limits)
  const clock = validateClock(options.clock)

  /**
   * The root is resolved before the input.
   *
   * A root that cannot be read is a configuration error whatever the input
   * turns out to be, and a configuration error is a run that never had a
   * subject. Resolving the input first would let a missing input turn a
   * misspelled root into an ordinary incomplete report, which is the quieter
   * and more misleading of the two answers.
   */
  let rootReal = null
  if (options.root !== undefined) {
    try {
      rootReal = await realpath(resolve(options.root))
    } catch (error) {
      throw new TypeError(`Root could not be read: ${error.code ?? 'unknown error'}`)
    }
  }

  let inputReal
  try {
    inputReal = await realpath(resolve(options.input))
  } catch (error) {
    return refusedReport(
      new ScenarioError(
        'scenario-unreadable',
        `The scenario could not be read: the path could not be resolved (${error.code ?? 'unknown error'}).`,
        { suggestion: 'Check the path and its permissions.' },
      ),
      excerpt(basename(options.input), 200),
      0,
    )
  }
  if (rootReal === null) rootReal = dirname(inputReal)

  const fileLabel = excerpt(relative(rootReal, inputReal) || basename(inputReal), 200)

  if (!isInside(rootReal, inputReal)) {
    return refusedReport(
      new ScenarioError(
        'scenario-unreadable',
        'The scenario resolves outside the declared root, so it was refused unread. A symbolic link inside a root ' +
          'is still a path out of it.',
        { suggestion: 'Point --root at the tree the scenario really lives in, or move the file inside it.' },
      ),
      excerpt(basename(inputReal), 200),
      0,
    )
  }

  const info = await stat(inputReal).catch(() => null)
  if (info === null || !info.isFile()) {
    return refusedReport(
      new ScenarioError('scenario-unreadable', 'The scenario could not be read: the path is not a regular file.', {
        suggestion: 'Point --input at a scenario file.',
      }),
      fileLabel,
      0,
    )
  }
  if (info.size > limits.maxScenarioBytes) {
    return refusedReport(
      new ScenarioError(
        'scenario-too-large',
        `The scenario is ${info.size} byte(s), past the maxScenarioBytes limit of ${limits.maxScenarioBytes}. It ` +
          'was not read, so nothing was exercised.',
        { suggestion: 'Raise --max-scenario-bytes, or split the scenario.' },
      ),
      fileLabel,
      info.size,
    )
  }

  let bytes
  try {
    bytes = await readFile(inputReal)
  } catch (error) {
    return refusedReport(
      new ScenarioError('scenario-unreadable', `The scenario could not be read: ${error.code ?? error.message}.`, {
        suggestion: 'Check the path and its permissions.',
      }),
      fileLabel,
      0,
    )
  }

  return testScenarioBytes(new Uint8Array(bytes), { file: fileLabel, limits: { ...limits }, clock })
}

const SEVERITY_WIDTH = 7
const CURSOR_WIDTH = 18

/** The human summary. Every id, cursor and message in it has been sanitised. */
export function formatReport(report) {
  const { summary, walk } = report
  const lines = [
    `${walk.scenario ?? 'scenario'} (${walk.style ?? 'unknown style'}): ${summary.pages} page(s) walked, ` +
      `${summary.records} record(s) served, status ${report.status}.`,
    `walk: ended on ${walk.terminatedBy ?? 'nothing (the scenario was refused)'}; completeness ` +
      `${walk.complete ? 'proven' : 'not proven'}; corpus ${summary.corpus}, distinct ${summary.distinctRecords}, ` +
      `duplicated ${summary.duplicated}, repeated-in-page ${summary.repeatedInPage}, missing ${summary.missing}, ` +
      `unknown ${summary.unknown}, unreachable pages ${summary.unreachablePages}.`,
  ]

  if (walk.pages.length > 0) {
    lines.push(`page  ${'cursor'.padEnd(CURSOR_WIDTH)} records  ${'next'.padEnd(CURSOR_WIDTH)} note`)
    for (const page of walk.pages) {
      const note = page.terminal ? (page.empty ? 'last, empty' : 'last') : page.empty ? 'empty' : ''
      const next = page.nextCursor === null ? '(none)' : cursorLabel(page.nextCursor)
      lines.push(
        `${String(page.index).padEnd(5)} ${cursorLabel(page.cursor).padEnd(CURSOR_WIDTH)} ` +
          `${String(page.records).padEnd(8)} ${next.padEnd(CURSOR_WIDTH)} ${note}`.trimEnd(),
      )
    }
  }

  for (const finding of report.findings) {
    const place = `${finding.location.file}${finding.location.pointer}`
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}${quoted}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { analyzeWalk, indexRecords } from './analyze.mjs'
export { FindingSet, RULE_SEVERITY, SECTIONS, SEVERITY_VALUES, createFinding, sortFindings } from './rules.mjs'
export {
  KNOWN_UNSUPPORTED_STYLES,
  SUPPORTED_STYLES,
  ScenarioError,
  createMockApi,
  validateScenario,
} from './scenario.mjs'
export {
  EXCERPT_LIMIT,
  FORGEABLE_RANGES,
  byCodeUnit,
  cursorLabel,
  decodeUtf8,
  excerpt,
  isForgeable,
  parseFailureDetail,
  sanitize,
} from './text.mjs'
export { TERMINATIONS, walkPages } from './walk.mjs'
