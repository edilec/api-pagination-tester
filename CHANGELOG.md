# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface. Renaming one, or changing the severity of one, is a
breaking change and is recorded here.

## [Unreleased]

### Fixed

- `--out` accepted a destination that destroyed a file the tool was never asked to touch. The check
  resolved the destination and compared the result with the scenario, which caught a symbolic link
  pointing AT the scenario and a hard link to it, and missed the case that actually loses data: a
  symbolic link pointing anywhere else. `realpath` resolved it, the resolved path was not the
  scenario, and the write went through the link. Measured with `--overwrite` — the flag whose whole
  purpose is to say "replace that file" — a 9-byte file outside the tree became a 1241-byte report
  at exit 0. A link whose target did not exist yet needed no `--overwrite` at all: the report was
  created outside the tree. A symlinked parent directory did the same thing one level up.
  `assertWritableDestination` now refuses all three before the scenario is opened, and the hard-link
  identity comparison lives inside the same guard. `test/destination.test.mjs` has one case per hole
  and one per allowed shape.

- A scenario that does not parse is no longer quoted back into the report. `JSON.parse` embeds the
  input in one of its two error messages — `Unexpected token 'A', "AKIA..." is not valid JSON` —
  so a scenario file short enough to be only a credential was reproduced in full by the
  `scenario-invalid` finding, on stdout, in both output modes. `parseFailureDetail` in `src/text.mjs`
  now removes the quoted window and keeps the position, line and column, which are the diagnostic
  half and carry no input. Sanitising and excerpting did not catch this: the quoted span is at the
  front of the message and both cut from the back.

### Added

- `--out-root`, declaring the tree `--out` may resolve inside. It defaults to the working
  directory and has no meaning without `--out`; `--overwrite` without `--out` is now a usage error
  too, rather than a flag with no effect.
- `assertWritableDestination` and `DestinationError`, exported for a caller writing its own
  destination logic.
- The pagination walker (`src/walk.mjs`): follows cursors from the initial request, remembers every
  cursor it has requested, and always terminates. Empty pages, last pages and the empty-string
  terminator are three separate states, not one.
- The in-memory mock API (`src/scenario.mjs`): a `Map` lookup in this process. No socket is opened
  and no port is bound, and `src/` imports no network module.
- Strict scenario validation: unknown keys refused rather than ignored, `nextCursor` required
  explicitly, exactly one initial page, no duplicate cursors, and a non-empty corpus of unique
  identities.
- The record-identity verdict: boundary duplicates, repeats inside one page, records the corpus does
  not declare, and — only for a walk that reached a real last page — records that are missing and
  declared pages nothing leads to. Both of those are inferences from having seen the whole chain, so
  a walk stopped by a loop, a dangling cursor or a bound claims neither.
- `completeness-unknown`: a walk that ended on a cycle, a dangling cursor or a bound proves nothing
  about completeness, so it says so and the run is incomplete rather than declaring unreached records
  missing.
- The rule catalog: 27 rules, each with its severity taken from one frozen table
  (`RULE_SEVERITY` in `src/rules.mjs`), asserted against `docs/pagination-rules.md` in both
  directions and pinned behaviourally by exit codes and literal inline counts.
- Eight explicit limits — scenario bytes, declared pages, corpus size, pages walked, records walked,
  identity length, findings and milliseconds — each enforced, each named in a finding when exceeded,
  and each tested from both sides of its bound. Exceeding one is an `incomplete` report, never a
  silent truncation.
- CLI `api-pagination-tester` with `--help`, `--json`, `--input`, `--root`, `--out`, `--overwrite`
  and a flag for every limit. Repeated value-carrying flags and unknown options are configuration
  errors, and a configuration error leaves stdout empty.
- `--out` refuses to be the scenario file, comparing `dev` and `ino` rather than resolved paths so
  that a hard link — which has no target for `realpath` to resolve — cannot launder the input into
  the output, and refuses to replace an existing file without `--overwrite`.
- Path confinement on real paths: both the root and the input are resolved before they are compared,
  so a symlink out of the root is refused and a root that is itself a symlink is not.
- Strict UTF-8 decoding of every scenario, through one function shared by every entry point.
- Output sanitising of C0, DEL, C1, U+2028/U+2029 and all twelve Unicode `Bidi_Control` characters
  (U+061C included) from every untrusted string, identifiers included. Sanitising is an output step;
  identity always uses the raw value.
- Determinism: ordering by UTF-16 code unit at every site, an injected clock, and byte-identical
  stdout over identical input.
- Three example scenarios, one for each exit code, and `docs/pagination-rules.md`.

No release has been published.
