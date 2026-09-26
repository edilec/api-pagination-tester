/**
 * api-pagination-tester -- the rule catalog, the severity table and the
 * finding collector.
 *
 * This module decides nothing about pagination. It owns the two things that
 * decide whether a run passes: which rules exist, and what severity each one
 * carries. Both live here once so that neither can drift between construction
 * sites.
 */

import { byCodeUnit, excerpt } from './text.mjs'

/**
 * The authoritative rule severity table.
 *
 * Severity is the entire difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and a single rule quietly demoted to `warning` turns a refusal into a green
 * build with every test still passing. Every finding takes its severity from
 * here, an unknown rule id throws, and `docs/pagination-rules.md` is asserted
 * against this table in both directions.
 *
 * The table is the source of truth. It is deliberately *not* the test: a table,
 * a document and a hand-written map in a test file are three declarations that
 * can be edited together in one commit. Every error rule is additionally pinned
 * by `test/severity-behaviour.mjs`, which shares no map with anything, drives
 * the real binary, and asserts literal inline counts, the printed severity word
 * and the process exit code. An exit code cannot be edited.
 */
export const RULE_SEVERITY = Object.freeze({
  'completeness-unknown': 'error',
  'corpus-duplicate-id': 'error',
  'corpus-too-large': 'error',
  'cursor-repeated': 'error',
  'cursor-unknown': 'error',
  'empty-page-not-last': 'warning',
  'no-pages-fetched': 'error',
  'page-limit-exceeded': 'error',
  'page-over-limit': 'error',
  'page-short-before-last': 'warning',
  'page-unreachable': 'warning',
  'record-duplicated': 'error',
  'record-id-too-long': 'error',
  'record-limit-exceeded': 'error',
  'record-missing': 'error',
  'record-repeated-in-page': 'error',
  'record-unknown': 'error',
  'scenario-invalid': 'error',
  'scenario-not-utf8': 'error',
  'scenario-too-large': 'error',
  'scenario-too-many-pages': 'error',
  'scenario-unreadable': 'error',
  'terminal-page-empty': 'info',
  'terminator-ambiguous': 'error',
  'time-limit-exceeded': 'error',
  'too-many-findings': 'error',
  'unsupported-pagination-style': 'error',
})

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

/**
 * Report sections, ranked.
 *
 * Findings about the scenario document come before findings about the walk,
 * which come before findings about individual pages, which come before findings
 * about record identities. A reader wants to know the scenario was unusable
 * before being told which records went missing inside it.
 */
export const SECTIONS = Object.freeze({ scenario: 0, walk: 1, pages: 2, records: 3 })

const MESSAGE_LIMIT = 320
const POINTER_LIMIT = 200
const EVIDENCE_LIMIT = 200
const FILE_LIMIT = 200

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here, not only `evidence`: a JSON pointer
 * built from a record id carrying U+0085 forges a report line exactly as well
 * as a message does, and a file label is no safer than either. Exported so a
 * test can prove the refusal below actually throws.
 */
export function createFinding(row) {
  const severity = Object.hasOwn(RULE_SEVERITY, row.ruleId) ? RULE_SEVERITY[row.ruleId] : undefined
  if (severity === undefined) {
    throw new Error(
      `Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/pagination-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, FILE_LIMIT), pointer: excerpt(row.pointer, POINTER_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence, EVIDENCE_LIMIT)
  if (row.suggestion !== undefined && row.suggestion !== '') {
    finding.suggestion = excerpt(row.suggestion, MESSAGE_LIMIT)
  }
  if (row.page >= 0) finding.page = row.page
  return finding
}

/**
 * Order findings by `(section, page, pointer, ruleId)`.
 *
 * The page index is compared numerically, because page 9 comes before page 10
 * to every reader and after it to every string comparison. The pointer and the
 * rule id are compared by UTF-16 code unit -- never by `localeCompare` or
 * `Intl.Collator`, whose ICU data differs between Node builds. Pointers carry
 * record ids and cursors straight from the scenario, so this is the ordering
 * site an untrusted alphabet actually reaches; it is pinned behaviourally in
 * `test/determinism.test.mjs` with ids whose code-unit order and collation
 * order genuinely differ.
 *
 * Ties keep insertion order, which `Array.prototype.sort` has guaranteed to be
 * stable since ES2019.
 */
export function sortFindings(rows) {
  return [...rows].sort((left, right) => {
    if (left.section !== right.section) return left.section - right.section
    if (left.page !== right.page) return left.page - right.page
    const pointer = byCodeUnit(left.pointer, right.pointer)
    if (pointer !== 0) return pointer
    return byCodeUnit(left.ruleId, right.ruleId)
  })
}

/**
 * The finding collector, and the only place a run is marked incomplete by a
 * findings cap.
 *
 * `maxFindings` is enforced rather than described: once the cap is reached no
 * further finding is recorded, `too-many-findings` is added past the cap, and
 * the run becomes incomplete. That is the difference between a bounded report
 * and a silently shortened one -- the consumer is told the list stops early.
 */
export class FindingSet {
  constructor({ file, maxFindings }) {
    this.file = file
    this.maxFindings = maxFindings
    this.rows = []
    this.capped = false
    this.incomplete = false
  }

  /** Record one finding. Returns false when the cap refused it. */
  add(ruleId, message, options = {}) {
    if (this.capped) return false
    if (this.rows.length >= this.maxFindings) {
      this.capped = true
      // Past the cap on purpose: a report that stops listing without saying so
      // is exactly the silent truncation this tool refuses.
      this.rows.push({
        ruleId: 'too-many-findings',
        message:
          `More than the maxFindings limit of ${this.maxFindings} finding(s) were raised, so the rest were not ` +
          'recorded. This report is a bounded sample of the problems in this scenario, not all of them.',
        suggestion: 'Raise --max-findings, or fix the reported findings and run again.',
        file: this.file,
        section: SECTIONS.scenario,
        page: -1,
        pointer: '',
        evidence: undefined,
      })
      this.incomplete = true
      return false
    }
    this.rows.push({
      ruleId,
      message,
      suggestion: options.suggestion,
      evidence: options.evidence,
      file: this.file,
      section: options.section ?? SECTIONS.walk,
      page: options.page ?? -1,
      pointer: options.pointer ?? '',
    })
    return true
  }

  /** Whether a rule was raised. Used by tests and by the report builder. */
  has(ruleId) {
    return this.rows.some((row) => row.ruleId === ruleId)
  }
}
