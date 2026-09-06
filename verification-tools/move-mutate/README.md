# move-mutate

Systematic mutation testing for Sui Move packages.

A passing suite is not evidence. This tool derives mutations from a package's own
sources, applies each in turn, and proves the suite notices. A mutation that survives
names an invariant nothing tests.

Feeds **Layer 1** of the [ProtocolX Verification Standard](../standard/PVS.md).

> This is an internal review by the party that wrote the code. It is evidence, not an
> audit: no claim of independence is made, and none should be inferred.

## Requirements

- `bash` 3.2 or newer (macOS stock bash is fine)
- `sui` on `PATH`
- **`python3` 3.8 or newer — required.** The derivation and reporting stages are
  Python 3, standard library only; there are no pip dependencies. The driver checks
  for `python3` at startup and exits with a named error if it is missing, rather than
  producing a stack trace or a silently empty mutation set.

Derivation and reporting are Python because both are correctness-critical parsing
problems — finding where a multi-line `assert!` ends, and emitting well-formed SARIF —
and a hand-rolled lexer or JSON emitter in bash is where a silent wrong number would
hide. The driver, the estate laws, and the entry point remain bash.

## Usage

```
move-mutate.sh <package-dir> [options]
```

The bare invocation is **frozen**: deletion-only, single-line only. A published report
must stay reproducible from the tool's own defaults, so widened reach is always opt-in.

| option | effect |
|---|---|
| `--list` | print the derived mutation set and exit; runs no tests |
| `--limit N` | run only the first N mutations |
| `--filter S` | only mutate files whose path contains S |
| `--operators SET` | `delete` (default), `standard`, `all`, or an explicit `CLS,CLS` list |
| `--multiline` | derive multi-line asserts too (implies parse derivation) |
| `--jobs N` | parallel workers, each in an isolated package copy (default 1) |
| `--shared-move-home` | do not give each worker its own Move cache (see Parallelism) |
| `--test-filter` | run only tests matching the mutated module — faster, less sound |
| `--out DIR` | where reports are written (default: the package dir) |
| `--delta-base FILE` | a previous run's `mutation-report.json`; also emit `MUTATION-DELTA.md` |

## Mutation operators

Deletion alone measures less than it appears to: a suite that catches a deleted
assertion routinely misses a flipped comparison. Every mutation carries a stable rule
id so a report can name **which** operator survived **where**.

| class | mutation |
|---|---|
| `DEL` | the guard is deleted entirely |
| `CMP` | relational swap — `>=`→`>`, `==`→`!=`, and the rest |
| `BND` | boundary shift — an integer literal moves by one |
| `NEG` | the condition is negated |
| `ARI` | arithmetic swap — `+`→`-`, `*`→`/` |
| `ARG` | the two sides of a comparison are exchanged |
| `RET` | early return injected, in unit-returning functions only |

Sets: `delete` = `DEL` · `standard` = `DEL,CMP,BND,NEG` · `all` = every class.

**`RET` is weak and known to be.** It injects `return` in place of the assertion. Where
the assertion is not the last statement in its block this leaves unreachable statements
after the `return` and the mutant does not compile — measured at 3 of 6 RET mutants on
one small package. Those are correctly classified `invalid` and excluded from the score,
so they do not distort the number, but they do cost a full suite run each for nothing.
Prefer `standard` over `all` unless you specifically want RET. Restricting RET to
assertions in tail position would fix this and has not been done yet.

## Outputs

Written to the package directory, or `--out`:

- `MUTATION-REPORT.md` — human-readable, survivors named, independence clause verbatim
- `mutation-report.json` — the full run, machine-readable
- `mutation-report.sarif` — SARIF 2.1.0, for GitHub code scanning and security platforms
- `MUTATION-DELTA.md` — with `--delta-base`, what the wider operator set caught that
  deletion missed

### SARIF severity is capped in code

SARIF consumed by GitHub code scanning renders as **security alerts**. A surviving
mutant is an untested invariant; it is **not** a vulnerability. Results are emitted at
`note`, never above `warning`, and `error` is unreachable by any code path — the level
passes through a clamp, and the test suite asserts that no emitted document can contain
it. Every rule's `fullDescription` carries the distinction, and the independence clause
sits in the run-level properties.

Shipping SARIF that lights a client's dashboard red for untested asserts would be
exactly the overclaim this standard exists to refuse.

## Scoring

```
mutation score = killed / (executed − did-not-compile − confirmed-equivalent)
```

The denominator is stated on every report rather than implied. Mutants that fail to
**compile** are classified `invalid` and excluded: the suite was never given them, so
counting them as kills would credit it for a failure it had no part in, and counting
them as misses would understate it. Confirmed-equivalent mutants leave the denominator
only when a human has confirmed them — the tool proposes, it never self-certifies.

## Shadow triage — why a survivor survived

A mutation score cannot distinguish two very different survivors:

- **nothing tests this guard at all** — no input ever violates the condition; or
- **something does, but the oracle cannot see it** — deleting the guard hands the
  abort to something *else* on the same path (a native division, an integer cast,
  `table::add` on a duplicate key), so a bare `#[expected_failure]` still sees "an
  abort" and still passes.

Every survivor is annotated with a static read of the code **after** the guard,
inside the same function:

| label | meaning |
|---|---|
| `no-fallback-abort` | Nothing after the guard can abort under any input. Deleting it makes the call return **normally**, so any test reaching this path would notice. The cheapest gaps to close. |
| `fallback-abort-correlated` | Something after the guard can abort **and** involves the same values the guard tests. A bare `#[expected_failure]` here can pass without testing anything; this guard needs `abort_code = …`. |
| `fallback-abort-present` | Something after the guard can abort, but is not tied to the guard's condition. Unproven either way. |
| `unknown` | Not determined — typically a call this analysis does not follow. |

**These labels describe the shape of the code, not the cause of the survival, and
never the safety of the guard.** Only `no-fallback-abort` is sound: it is emitted
solely when the tail is provably abort-free. The others record that an abort is
*possible*, never that it fires — that depends on runtime values. Anything
unmodelled is `unknown`; the analysis never guesses, because a wrong "shadowed"
label would tell a team a guard is fine when it is not.

**Triage annotates; it never suppresses.** A survivor is reported in full at every
label. An untested guard is an untested guard, whatever sits behind it.

Measured across the three packages this was built against (52 mutations), the label
is informative but **not** a predictor of survival: `no-fallback-abort` ran 11 killed
to 3 survived, `fallback-abort-correlated` 8 killed to 19 survived. The three
`no-fallback-abort` **survivors** were the sharpest findings in the whole set —
guards with nothing masking them that no test reached.

### A clean number is not assurance

An `#[expected_failure(abort_code = …)]` pinned to the **wrong constant** looks
precise to every grep and still fails to test what it names. No static score — not
this one, not a count of bare annotations, not line coverage — can see that; only
running the mutation can. Static counts are triage. They are never assurance, and a
repo that scores well on them has not thereby been shown to be sound.

## What is excluded, and why it is always printed

Every excluded or skipped item is counted and printed. Silent truncation reads as
"covered everything" when it did not.

- **Test-internal asserts.** Assertions inside `#[test]` / `#[test_only]` declarations
  are excluded — detected by annotation and brace matching, not by directory. They are
  not production code, never reach deployed bytecode, and an assertion inside a `#[test]`
  body cannot be killed at all: weakening a test never fails that test, so every such
  mutation is a guaranteed phantom survivor. Left in, they inflate the survivor count
  and deflate the kill rate — in the direction that flatters the vendor. Measured on one
  real client package: 24 of 108 derived mutations were phantoms of exactly this kind.
- **Multi-line asserts**, unless `--multiline`. Counted and listed.
- **In-sources test directories** (`*/test/*`, `*/tests/*`). Counted.

## A known blind spot in the frozen default

An `assert!` that is the **final expression of a function** carries no trailing
semicolon — Move permits it, because the assert is the function's tail expression. The
frozen `legacy-line` predicate matches on `);`, so it never sees one. It lands in the
skipped bucket, where it is counted and listed but **labelled multi-line, which is
wrong**.

This class matters more than its frequency suggests. A function whose entire body is a
single assert is almost always a validation or authorisation helper — which is exactly
where a blind spot is least acceptable. The instance that surfaced it in real client
code:

```move
public fun assert_authorized_witness<Witness: drop>(
  authorized_witness_list: &AuthorizedWitnessList,
) {
  let is_authorized = vec_set::contains(&authorized_witness_list.witness_list, ...);
  assert!(is_authorized, ERROR_NOT_AUTHORIZED)   // <- invisible to the `);` predicate
}
```

Measured incidence: 1 of 17 skips on one package, 0 of 12 on another. Rare, and
concentrated in guards.

`--multiline` derives it correctly. The default is left alone deliberately: changing it
would move a published number, and the standing rule is that widened reach is opt-in
and stated rather than retrofitted into a frozen default.

## Parallelism

`sui move test` locks the shared Move package cache (`MOVE_HOME`, default `~/.move`),
so concurrent runs serialise completely. Measured on this estate:

| configuration | wall time, 4 runs |
|---|---|
| one run alone | 8.3 s |
| 4 concurrent, shared cache | 32.0 s — exactly 4×, no gain |
| 4 concurrent, cache cloned per worker | 10.4 s, 484% CPU |

### Local dependencies

A Move package routinely declares `local = "../libs/math"` dependencies that live
outside it. A worker handed a copy of only the package cannot resolve them, so every
build fails and every mutant is classified `invalid` — a run that measured nothing,
presented as a full set of results. `--jobs N` therefore copies the smallest tree
containing the package and its whole transitive local closure, dev-dependencies
included, and runs the worker in the corresponding subdirectory. A package with no
local dependencies keeps the cheap path of copying only itself.

### Worker sanity check

Before any mutation is applied, every worker must build and pass on a **pristine**
copy. A worker that cannot build an unmutated package would classify its entire slice
as `invalid`, and the run would report results it never measured. If any worker fails
this check the run aborts and says so, rather than producing a number.

So `--jobs N` clones the cache per worker (an APFS clone: metadata, not gigabytes)
unless `--shared-move-home` is passed. Setup costs roughly 20 s per worker and does not
pay for itself on short runs, which is why `--jobs` defaults to **1**. In parallel mode
each worker mutates its own copy and the package under test is never modified.

## The laws

- **Green baseline** before the first mutation. A red baseline "kills" everything and
  proves nothing; it is reported as the finding it is, never worked around by weakening
  the suite.
- **Byte-verified restore** — every source hashed before and after; a mismatch fails
  loudly.
- **Applied-mutation check** — if an edit changed nothing, the run aborts rather than
  reporting a phantom kill.
- **Deterministic ordering** — sources are sorted, not taken in filesystem order, so the
  same inputs produce the same mutation set in the same order on any machine.
- **Nothing dropped silently.**

## How an outcome is classified

| outcome | condition |
|---|---|
| `survived` | `sui move test` exited 0 — the suite did not notice the change |
| `killed` | the build succeeded, the tests ran, and the suite failed |
| `invalid` | the mutant never compiled, so the suite was never given it |

The distinction between `killed` and `invalid` is read from whether the test runner
reached the point of running tests at all. It is deliberately a plain substring test on
the captured output rather than a pipeline: written as `echo "$out" | grep -q MARKER`
under `set -o pipefail`, `grep` exits at the first match, `echo` takes SIGPIPE, and the
pipeline reports 141 *even though the pattern matched* — so every genuine kill is
recorded as a mutant that never compiled. That failure is output-size dependent, so it
is invisible on small packages and inverts the headline on real ones. It did exactly
that once here: a run reported 0 killed / 13 invalid where the truth was 13 killed /
0 invalid. `engine/test/classify.sh` in the App repository guards it.

## Exit codes

| code | meaning |
|---|---|
| 0 | every executed, valid mutation was killed; sources restored byte-identical |
| 1 | survivors, red baseline, restore mismatch, nothing to mutate, or **no mutant compiled** |
| 2 | usage error, missing `python3`, or a worker that cannot build a pristine copy |

The "no mutant compiled" case is called out deliberately. An earlier revision exited 0
on a run where all 84 mutants failed to build, because it checked only "were there
survivors?" — zero survivors out of zero valid mutants read as a clean pass. A run that
measured nothing is not a pass, and the tool now says so and exits 1. Where some but
not all mutants fail to compile, the count and percentage are printed, and above 20%
the score is flagged provisional on the grounds that an environment fault is more
likely than an operator property.

## Reproducibility

Every report carries a manifest: repo URL, commit SHA, working-tree dirty count,
toolchain version, tool version, derivation mode, operator set, **mutation-set SHA-256**,
job count, whether test filtering was on, and start/finish timestamps. Two runs quoting
the same mutation-set hash mutated exactly the same things in exactly the same way.

## Tests

```
python3 test/test_movemutate.py
```

39 tests, no dependencies. The suite pins the test-internal exclusion to real line
numbers from real client code, so a refactor that silently re-admits test-internal
asserts fails here rather than in a client engagement. It also asserts that no emitted
SARIF can carry `error` severity.

A tool whose thesis is that a passing suite is not evidence has no standing to ship
untested.
