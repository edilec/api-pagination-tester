# Rules, limits and the report

This document is the reference for what `api-pagination-tester` walks, what each rule means, what the
report contains, and what the tool refuses to claim. Rule ids are stable: renaming one is a breaking
change and is recorded in the changelog.

## The four things this tool is built on

**No socket is ever opened.** The mock API is a `Map` lookup inside this process. A pagination
contract is a property of what the responses say, not of how they travelled, and a transport would
only add ways for the run to fail for reasons that are not about pagination. There is no network
import anywhere in `src/`, and a library caller supplying its own fetcher supplies an in-process
function, never a URL.

**Records carry known identities.** The scenario declares the corpus the API is supposed to expose.
That is what makes the two interesting verdicts possible: a record served on two pages is a boundary
duplicate, and a corpus record served on no page is missing. Without ground truth a walk can only
report what it saw, which is why an empty corpus is refused.

**The walk always terminates.** Every requested cursor is remembered. A cursor handed out a second
time ends the walk with a finding, so a mock that points page 3 back at page 2 produces a report
rather than a hung process — and every bound (pages, records, milliseconds) ends the walk with a
named reason rather than a quiet stop.

**Unknown is never a pass.** A walk that ended anywhere but on a real last page proves nothing about
completeness. It says so, the run is `incomplete`, and no record is declared missing on the strength
of a walk that never reached the end.

## The scenario document

A scenario is one JSON object. Every key is checked; an unknown key is refused rather than ignored,
because a one-character typo in `nextCursor` must not quietly turn a broken pagination contract into
a green run.

```json
{
  "name": "orders",
  "style": "cursor",
  "pageLimit": 2,
  "corpus": ["ord-1", "ord-2", "ord-3"],
  "pages": [
    { "cursor": null, "records": ["ord-1", "ord-2"], "nextCursor": "after:ord-2" },
    { "cursor": "after:ord-2", "records": ["ord-3"], "nextCursor": null }
  ]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | no | A label for the report. Defaults to `scenario`. |
| `style` | no | The pagination style. Defaults to `cursor`, the only style implemented. |
| `pageLimit` | no | The page size the API *promises*. When absent, neither page-size rule can fire. |
| `corpus` | yes | Every record identity the API is supposed to expose. Non-empty, no duplicates. |
| `pages` | yes | The pages the mock serves, keyed by the cursor that requests them. |

Each page is an object with exactly three keys:

| Key | Meaning |
| --- | --- |
| `cursor` | The cursor that requests this page, or `null` for the initial request. Exactly one page carries `null`. |
| `records` | The record identities this page serves. `[]` is a legitimate empty page. |
| `nextCursor` | A string to continue, or `null` for the last page. **Required** — an absent `nextCursor` is exactly the ambiguity this tool exists to find, so it is refused rather than defaulted. |

Bytes are decoded with `TextDecoder('utf-8', { fatal: true })`. A scenario that is not UTF-8 is
refused by the decoder, never guessed at, and a leading byte order mark is stripped so `JSON.parse`
does not blame the wrong thing. There is no second, looser decoding path: the CLI, the file entry
point and the in-memory entry points all decode through the same function. Configuration itself
arrives only as command-line flags, each validated before the run starts.

## The bounded subset: what "cursor" means here, and what is not implemented

This tool implements one pagination style, and says so rather than implying more.

| Style | Status |
| --- | --- |
| `cursor` | **Implemented.** The client sends an opaque cursor; the response carries the next one or `null`. |
| `offset` | Not implemented. Its duplicate and skip behaviour depends on concurrent writes, which this tool does not simulate. |
| `page-number` | Not implemented, for the same reason. |
| `keyset` | Not implemented. Its ordering-key semantics are outside this subset. |
| `link-header` | Not implemented. RFC 8288 `Link` headers need a transport, and there is none here. |
| anything else | Not recognised. |

Declaring any style other than `cursor` raises `unsupported-pagination-style`, walks nothing, and
makes the run `incomplete` at exit 2. An unsupported construct is reported as unsupported — it is
never silently treated as satisfied.

## The state machine

From the initial request (cursor `null`), each step is:

1. Stop if the page bound or the time bound is spent.
2. Stop if this cursor has already been requested (`cursor-repeated`).
3. Fetch the page. Stop if no page answers this cursor (`cursor-unknown`).
4. Stop if taking this page in would pass the record bound. The page is not counted.
5. Record the page. If `nextCursor` is `null`, this was the last page and the walk is **complete**.
6. If `nextCursor` is `""`, the terminator is ambiguous — see below.
7. Otherwise continue with that cursor.

### An empty page is not a last page

Zero records is a page like any other. Only `nextCursor: null` ends a collection. A client that
stops on `records.length === 0` truncates the collection at the first empty page; a client that
treats the last page as "just another empty one" refetches it forever. The two states are therefore
tracked separately and reported by two separate rules — `empty-page-not-last` names how many records
a truncating client would miss, and `terminal-page-empty` records that an empty ending was seen and
understood as an ending.

### An empty-string next cursor is neither

`""` is the shape that breaks real clients: `if (next)` reads it as the end of the collection and
`if (next !== null)` requests another page. The walker refuses to guess. It probes the empty cursor
exactly once (that probe is not counted as a walked page) and then:

- if **no** page answers it, the API meant "the end" and wrote it badly: `terminator-ambiguous` is an
  error, and the walk is still complete, so the completeness verdict is reached;
- if a page **does** answer it, the two readings disagree about real records. The walk stops as
  `ambiguous-terminator`, completeness is unknown, and the run is `incomplete`.

## Rule catalog

`ruleId` values are stable. Severity comes from one frozen table in `src/rules.mjs`; this catalog is
asserted against that table in both directions, and every error rule is additionally pinned by a test
that runs the real binary and asserts the process exit code.

### The scenario document

| Rule | Severity | Meaning |
| --- | --- | --- |
| `scenario-unreadable` | error | The scenario could not be resolved, is not a regular file, resolves outside `--root`, or could not be opened. Nothing was walked. |
| `scenario-not-utf8` | error | The bytes are not valid UTF-8. Refused by the decoder rather than guessed at. |
| `scenario-too-large` | error | The scenario is past `maxScenarioBytes`. It was not read. |
| `scenario-invalid` | error | The scenario is not usable: not JSON, not an object, an unknown key, a missing or mistyped field, two pages claiming one cursor, or no initial page. |
| `scenario-too-many-pages` | error | The scenario declares more pages than `maxScenarioPages`. |
| `corpus-too-large` | error | The corpus declares more identities than `maxCorpus`. |
| `corpus-duplicate-id` | error | The corpus lists one identity twice, so "seen once" and "seen twice" cannot be told apart. |
| `record-id-too-long` | error | A record id or cursor is longer than `maxIdLength`, so identity could not be compared reliably. |
| `unsupported-pagination-style` | error | The declared style is not the one this tool implements. Nothing was exercised. |
| `too-many-findings` | error | More findings were raised than `maxFindings`. The list stops early and says so. |

Every rule in this section refuses the scenario outright: nothing is walked, `checked` is 0, the run
is `incomplete`, and the exit code is 2.

### The walk

| Rule | Severity | Meaning |
| --- | --- | --- |
| `cursor-repeated` | error | The API returned a cursor that had already been requested. The walk stopped instead of looping. |
| `cursor-unknown` | error | The API handed out a cursor that no page answers, so the walk could not continue. |
| `terminator-ambiguous` | error | A page ended with `nextCursor: ""` rather than `null`. |
| `page-limit-exceeded` | error | The walk reached `maxPages` with the collection unfinished. |
| `record-limit-exceeded` | error | The next page would have passed `maxRecords`. It was not counted. |
| `time-limit-exceeded` | error | The walk reached `maxMillis`. |
| `no-pages-fetched` | error | The run walked no page at all, so it checked nothing. A `pass` on no evidence is not reachable. |
| `completeness-unknown` | error | The walk ended anywhere but on a last page, so what it did not see is unknown — not missing. |

### The pages

| Rule | Severity | Meaning |
| --- | --- | --- |
| `empty-page-not-last` | warning | A page with no records that still hands out a next cursor. The message names how many records a client that stopped here would miss. |
| `terminal-page-empty` | info | The last page carries no records. A legitimate ending, reported so it is never confused with an empty page in the middle. |
| `page-over-limit` | error | A page carries more records than the declared `pageLimit`. |
| `page-short-before-last` | warning | A non-terminal, non-empty page carries fewer records than the declared `pageLimit`. A client that stops on a short page would end the walk here. |
| `page-unreachable` | warning | The scenario declares a page that the walk never requested, so nothing the API returns leads a client to it. |

### The records

| Rule | Severity | Meaning |
| --- | --- | --- |
| `record-duplicated` | error | One identity was served on two or more different pages — the classic page-boundary duplicate. |
| `record-repeated-in-page` | error | One identity was served twice inside a single page. A different defect from a boundary duplicate, and reported as one. |
| `record-missing` | error | A corpus identity appeared on no page of a **complete** walk. |
| `record-unknown` | error | An identity was served that the corpus does not declare. |

## Limits

Every limit is explicit, overridable, and named in a finding when it is hit. Exceeding one produces
an `incomplete` report — never a silently shorter answer, and never a pass.

| Limit | Flag | Default | Rule when exceeded |
| --- | --- | ---: | --- |
| `maxScenarioBytes` | `--max-scenario-bytes` | 4194304 | `scenario-too-large` |
| `maxScenarioPages` | `--max-scenario-pages` | 2000 | `scenario-too-many-pages` |
| `maxCorpus` | `--max-corpus` | 100000 | `corpus-too-large` |
| `maxPages` | `--max-pages` | 1000 | `page-limit-exceeded` |
| `maxRecords` | `--max-records` | 100000 | `record-limit-exceeded` |
| `maxIdLength` | `--max-id-length` | 200 | `record-id-too-long` |
| `maxFindings` | `--max-findings` | 1000 | `too-many-findings` |
| `maxMillis` | `--max-millis` | 10000 | `time-limit-exceeded` |

`maxMillis` is the only limit that may be 0: the budget is spent once the elapsed time *reaches* it,
so 0 is spent before the first fetch. That is how the wiring between the flag and the clock is
proven rather than assumed. Every other limit has a floor of 1. An unknown limit name, a fractional
value and a repeated flag are all configuration errors.

The clock is injected. `src/` contains no `Date.now`, no `new Date` and no `Math.random`; the default
clock is `performance.now`, and the elapsed time never reaches the report — a clock can only end a
run early, which is a finding of its own.

## The report

```json
{
  "schemaVersion": "1",
  "tool": "api-pagination-tester",
  "status": "pass",
  "summary": { "checked": 3, "errors": 0, "warnings": 0, "info": 0, "...": 0 },
  "walk": { "...": null },
  "findings": []
}
```

`status` is `pass`, `fail` or `incomplete`. `summary.checked` counts pages walked.

`summary.distinctRecords` counts the distinct identities the walk was *served*; `summary.observedCorpus`
counts only those the corpus declares. The two differ exactly when the API serves something the corpus
does not, and only the second one may be subtracted from the corpus size — which is what
`completeness-unknown` reports as never observed, and what the CLI prints on stderr.

`walk` carries what the run observed: the style, the declared page limit, how the walk ended
(`terminatedBy`), whether completeness was proven (`complete`), one entry per page in walk order, the
four record-identity lists, and the declared cursors nothing led to.

`maxFindings` bounds the `findings` array and nothing else. The identity lists under `walk.records`
and `walk.unreachablePages` are complete, and are bounded instead by `maxCorpus` and `maxRecords`,
which are enforced before the walk starts. So a run whose findings were capped still reports every
duplicated, repeated, missing and unknown identity it observed — the two are deliberately asymmetric,
and `too-many-findings` says which of the two stopped early.

A finding carries `ruleId`, `severity`, `message`, `location.file`, `location.pointer`, and
optionally `evidence`, `suggestion` and `page`. `location.file` is relative to `--root` (by default
the scenario's own directory), so an absolute host path never reaches the report.

### Ordering

Findings sort by `(section, page, location.pointer, ruleId)`, where section ranks the scenario before
the walk, the walk before the pages, and the pages before the records. The page index is compared
numerically, because page 9 comes before page 10 to every reader and after it to every string
comparison. Everything textual is compared by UTF-16 code unit — never `localeCompare` and never
`Intl.Collator`, whose ICU data differs between Node builds.

The other ordered outputs are `walk.records.duplicated`, `walk.records.repeatedInPage`,
`walk.records.missing`, `walk.records.unknown` and `walk.unreachablePages`; each is sorted by code
unit at its own call site and each is pinned by a test that asserts the exact emitted sequence for
identities whose code-unit order and collation order genuinely differ (`Z` before `a`, `README`
before `assets`, `a-b` before `a_b`).

Running the tool twice over an identical scenario produces byte-identical stdout.

### Sanitising

Every untrusted string reaching output — record ids, cursors, scenario names, pointers, file labels,
messages and evidence alike — has these code points replaced with a space:

| Class | Range |
| --- | --- |
| C0 | `U+0000`–`U+001F` |
| DEL | `U+007F` |
| C1 | `U+0080`–`U+009F` |
| Line / paragraph separators | `U+2028`, `U+2029` |
| Bidi controls | `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069` |

Sanitising happens on the way *out*. Comparison and identity always use the raw value, so two ids
that differ only in a stripped control character remain two different ids and a duplicate is not
manufactured by the guard that protects the report.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | The walk completed and the pagination contract held. | the report |
| `1` | The walk completed and the contract failed. | the report |
| `2` | Invalid usage or configuration. | **empty** |
| `2` | Evidence missing, undecodable or bounded out. | a report with `status: "incomplete"` |

A configuration error means the run never had a subject, so there is nothing to report about. An
unreadable or unusable scenario means the run had a subject and failed to obtain evidence about it,
which is exactly what `incomplete` exists to say.

## What this tool cannot conclude

- It says nothing about a real HTTP API. It walks the scenario you wrote. If the scenario does not
  match the service, the report describes the scenario.
- It does not simulate concurrent writes. Pagination duplicates and skips caused by rows being
  inserted or deleted mid-walk are exactly the interesting production failure, and modelling them
  needs a timeline this tool does not have.
- It cannot tell a genuinely missing record from one the API declines to serve to this caller.
  Authorisation, soft deletion and filtering all look identical from here.
- A `pass` means the walk this scenario describes is self-consistent. It is not evidence that the
  API's ordering is stable, that the cursors are durable across deployments, or that the same walk
  will hold under load.
- It does not measure latency, payload size or rate limits.
