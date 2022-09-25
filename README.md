# api-pagination-tester

Walk a cursor-paginated API modelled as an **in-memory mock** and prove what a client would end up
holding.

Pagination bugs are hard to see from inside a client. The page arrives, the records look fine, the
loop moves on — and the defect only shows up in the aggregate: one record appears twice because it
sat on a page boundary, another never appears at all, or the loop never ends because a cursor points
back at itself. This tool takes a scenario that declares both the **corpus** of record identities the
API is supposed to expose and the **pages** it serves, walks the state machine, and reports the
aggregate.

- **Repository:** [edilec/api-pagination-tester](https://github.com/edilec/api-pagination-tester)
- **Area:** API & Integration
- **License:** MIT

## Install and run

```
npx api-pagination-tester --input scenario.json
npx api-pagination-tester --input scenario.json --json > report.json
```

Node 22 or newer. **No runtime dependencies and no development dependencies** — Node built-ins only.

## What it finds

| | |
| --- | --- |
| **Boundary duplicates** | An identity served on two different pages. The client that appends every page to one list ends up holding it twice. |
| **Missing records** | A corpus identity served on no page of a **complete** walk. The usual cause is a strict comparison at the page boundary dropping one row. |
| **Repeated cursors** | A cursor handed out a second time. The walk terminates on a visited set and reports it; a client without one does not terminate at all. |
| **Empty pages vs last pages** | Zero records with a next cursor is an empty page; no next cursor is the end. A client that conflates them truncates the collection or refetches forever. |
| **Ambiguous terminators** | `nextCursor: ""`, which `if (next)` reads as the end and `if (next !== null)` reads as another page. |
| **Page-size drift** | A page over the size the API declares, or short before the last page. |
| **Unreachable pages** | A page the mock declares that nothing the API returns ever leads to, on a **complete** walk. A walk that stopped early never requested the rest of the chain either, so it claims nothing here. |
| **Unknown records** | An identity served that the corpus does not declare. |

## The scenario

```json
{
  "name": "orders",
  "style": "cursor",
  "pageLimit": 2,
  "corpus": ["ord-1", "ord-2", "ord-3", "ord-4", "ord-5"],
  "pages": [
    { "cursor": null,          "records": ["ord-1", "ord-2"], "nextCursor": "after:ord-2" },
    { "cursor": "after:ord-2", "records": ["ord-3", "ord-4"], "nextCursor": "after:ord-4" },
    { "cursor": "after:ord-4", "records": ["ord-5"],          "nextCursor": null }
  ]
}
```

`corpus` is the ground truth: without known identities a walk can only report what it saw, never
whether it saw everything. `cursor: null` is the initial request. `nextCursor` is **required** on
every page — an absent one is exactly the ambiguity this tool exists to find, so it is refused rather
than defaulted.

Three example scenarios ship with the package, one for each exit code:

```
node bin/api-pagination-tester.mjs --input examples/orders-clean.json    # exit 0, pass
node bin/api-pagination-tester.mjs --input examples/orders-broken.json   # exit 1, fail
node bin/api-pagination-tester.mjs --input examples/catalog-cycle.json   # exit 2, incomplete
```

The broken one holds a boundary duplicate, a missing record, an empty page in the middle of the
collection, and a page nothing leads to. The cycle one points a page back at itself: the walk
terminates, says so, and refuses to reach a completeness verdict it did not earn.

## Output

The human report:

```
orders-broken (cursor): 4 page(s) walked, 5 record(s) served, status fail.
walk: ended on last-page; completeness proven; corpus 5, distinct 4, duplicated 1, ...
page  cursor             records  next               note
0     (initial)          2        after:ord-2
1     after:ord-2        2        after:ord-3
2     after:ord-3        0        after:ord-4        empty
3     after:ord-4        1        (none)             last
ERROR   orders-broken.json/records/ord-4 record-missing The record "ord-4" is in the corpus ...
```

`--json` emits the machine-readable report instead. stdout carries the report and nothing else;
diagnostics go to stderr, so a non-empty stderr is normal and correct.

| Exit | Meaning |
| ---: | --- |
| `0` | The walk completed and the pagination contract held. |
| `1` | The walk completed and the contract failed. |
| `2` | Invalid usage or configuration (**stdout is empty**), or evidence that was missing, undecodable or bounded out (stdout carries a report with `status: "incomplete"`). |

## As a library

```js
import { testScenarioFile, walkPages } from 'api-pagination-tester'

const report = await testScenarioFile({ input: 'scenario.json' })

// Or walk your own in-process fake. `fetchPage` is a function, never a URL.
const result = await walkPages({
  fetchPage: async (cursor) => myFakeStore.page(cursor),
  limits: { maxPages: 100, maxRecords: 10000, maxMillis: 1000 },
  clock: () => performance.now(),
})
```

`testScenarioFile`, `testScenarioBytes`, `testScenarioText` and `testScenarioObject` all return the
same report. `walkPages` returns the raw walk — the pages in order, the cursors requested, and why it
stopped — with no verdict attached, which is what makes the state machine testable on its own.

## Limits and non-goals

**What this tool cannot conclude.**

- **It says nothing about a real HTTP API.** It walks the scenario you wrote, in memory. No socket is
  opened: `src/` imports no network module, and a library caller supplies an in-process function, not
  a URL. If the scenario does not match the service, the report describes the scenario — faithfully,
  and about the wrong thing.
- **It does not simulate concurrent writes.** Rows inserted or deleted mid-walk are the most common
  cause of real pagination duplicates and skips, and modelling them needs a timeline this tool does
  not have. A clean report here does not mean a clean walk under write load.
- **It cannot tell a missing record from a withheld one.** Authorisation, soft deletion, filtering
  and a genuine boundary bug all look identical from here: the identity was in the corpus and on no
  page.
- **One style only.** `cursor` is implemented. `offset`, `page-number`, `keyset` and `link-header`
  are recognised by name and reported as unsupported, which makes the run incomplete. An unsupported
  construct is never treated as satisfied.
- **A `pass` is not a stability claim.** It means this scenario's walk is self-consistent. It is not
  evidence that the ordering is stable, that cursors survive a deployment, or that the same walk
  holds tomorrow.
- **No latency, payload-size or rate-limit measurement.** Those need a transport, and there is none.
- **A bounded report, by design.** Every limit (bytes, declared pages, corpus size, pages walked,
  records, identity length, findings, milliseconds) is explicit and enforced. Exceeding one produces
  an `incomplete` report naming the limit — never a quietly shorter answer, and never a pass.

**What it will not do.**

- It never rewrites the scenario. `src/` imports no write API; `--out` goes elsewhere, refuses to be
  the input (identity compared by inode, because a hard link is a second name for one file) and
  refuses to replace an existing file without `--overwrite`.
- It never reports unknown as a pass. A walk that ended on anything but a real last page raises
  `completeness-unknown`, and no record is declared missing on the strength of a walk that never
  reached the end.
- It never guesses an encoding. Scenario bytes are decoded with `TextDecoder('utf-8', { fatal: true })`
  and refused if they are not UTF-8.
- It is deterministic. No `localeCompare`, no `Intl.Collator`, no `Date.now`, no `Math.random`; the
  clock is injected. Two runs over one scenario produce byte-identical stdout.
- It never echoes a control character. Every untrusted string reaching output — record ids and
  cursors included, not only excerpts — has C0, DEL, C1, U+2028/U+2029 and the bidi controls replaced
  with a space. Sanitising happens on the way *out*; identity always uses the raw value, so the guard
  cannot manufacture a duplicate.

## Options

```
--input FILE            The scenario to run (required)
--root DIR              Report paths relative to this root, and refuse a scenario that
                        resolves outside it (default: the scenario's own directory)
--json                  Emit the machine-readable report on stdout
--out FILE              Also write the JSON report to FILE
--overwrite             Allow --out to replace an existing file
-h, --help              Show help

--max-scenario-bytes N  Bytes read from the scenario (default 4194304)
--max-scenario-pages N  Pages a scenario may declare (default 2000)
--max-corpus N          Record identities a corpus may declare (default 100000)
--max-pages N           Pages one walk may fetch (default 1000)
--max-records N         Records one walk may take in (default 100000)
--max-id-length N       Characters in a record id or cursor (default 200)
--max-findings N        Findings collected (default 1000)
--max-millis N          Milliseconds of walking, 0 for none (default 10000)
```

An unknown option is refused and a flag carrying a value may be given only once, so a typo cannot
quietly turn a real failure into a green run.

## Verification

```
npm run check      # lint, tests, the clean example, and a packaging dry run
```

`npm run lint` is `node --check` over every shipped file; `npm test` is `node --test`. There is
nothing to install.

The rule catalog, the limits, the report schema and the ordering rules are documented in
[docs/pagination-rules.md](./docs/pagination-rules.md).

## License

MIT. See [LICENSE](./LICENSE).
