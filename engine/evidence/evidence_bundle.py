#!/usr/bin/env python3
# Built-by: @projectx.sui
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
"""
evidence_bundle — the artifact an auditor asks for, emitted by every run.

WHY THIS EXISTS. Until now a verification run produced check-run text: five
coloured rows in a pull request, readable for as long as GitHub keeps the page
and unreadable by anything else. An enterprise buyer's auditor cannot cite a
coloured row. They ask for a file: what was measured, on which commit, with
which tools, and what the numbers were. This module writes that file — twice,
once for a machine (`manifest.json`) and once for a person (`REPORT.md`) — from
the engine's own output and nothing else.

THREE RULES, AND ALL THREE ARE THE POINT.

  1. NO NUMBER IS INVENTED. Every count here is read out of the gate battery's
     stdout or out of the mutation engine's own `mutation-report.json`. There is
     no default, no fallback constant, and no arithmetic that fills a hole.

  2. A GATE THAT DID NOT RUN IS NOT A ZERO. Absence is modelled explicitly: a
     count that was not measured serialises as `null` with the reason recorded
     beside it. `0 survivors` and `survivors not measured` are different facts
     about a contract, and a bundle that renders them identically is worse than
     no bundle, because it is confidently wrong.

  3. A SURVIVING MUTATION IS AN UNTESTED INVARIANT, NOT A DEFECT IN THE
     CONTRACT. Nothing in this module assigns severity, and the human-readable
     report is checked by the test suite against a list of words it may not
     contain.

Standard library only. The engine's constraint is bash + python3 stdlib, and an
evidence writer that needed pip to run would be the first thing to fail on a
client's air-gapped runner.

Usage:
  evidence_bundle.py --out evidence
                     --repository owner/name --commit <sha> --package-path <dir>
                     --gates-log gates.log
                     [--mutation-report client/<pkg>/mutation-report.json]
                     [--derive-log derive.log] [--mutation-limit N]
                     [--generated-at 2026-08-30T00:00:00Z]
"""
import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import datetime

SCHEMA = "protocolx-verify/evidence-manifest"
SCHEMA_VERSION = 1

# The five gates, in the exact order and spelling of engine/ci/gates.sh. These names
# are a contract with every parser that reads the gate battery's output — they must
# all agree, because a gate this file cannot see is a gate that silently vanishes
# from the evidence while still showing a verdict in the pull request.
GATES = ["build", "digest", "tests", "pin", "mutation-smoke"]

# ---------------------------------------------------------------------------
# WHAT THE BUNDLE DIGEST COVERS, AND WHY IT LEAVES THINGS OUT
#
# `bundleDigest` is sha256 over the canonicalised manifest MINUS the keys named
# below. It exists so two people can compare one string instead of diffing two
# JSON files, and so a re-run of the same commit on the same toolchain proves
# itself by producing the same string.
#
# That last property is the whole reason for the exclusions. A digest taken over
# the entire manifest could never reproduce: `run.generatedAtUtc` differs by
# construction on the second run, so every re-run would disagree with the first
# and the digest would signal "something changed" on every single comparison —
# which is the same as signalling nothing.
#
# So volatile data does not get an exclusion list of its own scattered through
# the manifest. It all lives under ONE top-level key, `run`, and that key is
# excluded whole. The structural rule is deliberate: a field added to the
# manifest later is INSIDE the digest unless its author consciously files it
# under `run`. Defaulting new facts into the digest keeps the digest strong; a
# deny-list of individual field names would default them out and quietly weaken
# it over time.
#
# EXCLUDED (all under `run`), and why each one cannot be in the digest:
#   - generatedAtUtc, startedUtc, finishedUtc, durationSeconds — wall-clock time
#     is different on every run of identical inputs.
#   - workflow.{runId, runAttempt, runnerRepoCommit, url} — identifiers of THIS
#     execution, not of what was measured. `runnerRepoCommit` in particular is
#     the ProtocolX Verify repository's HEAD: if it were inside the digest, every
#     unrelated commit to our own repo would change every client's digest, and
#     the digest would stop meaning "the measurement changed".
#   - mutationReportPackageAbsolutePath — an absolute filesystem path from the
#     machine that ran the engine (`/home/runner/work/...`). It says nothing
#     about the code and differs between any two machines.
#
# INCLUDED, and why each one must be:
#   - subject.{repository, commitSha, packagePath} — what was measured.
#   - engine.{treeSha, mutationToolVersion} — WHICH instrument measured it. A
#     changed engine can change the numbers, so it must change the digest.
#     `treeSha` is the git tree object of `engine/`, not the repository HEAD,
#     precisely so that commits which do not touch the engine do not move it.
#   - toolchain.{sui, python3, os} — a different compiler compiles different
#     code and a different interpreter derives differently. Two runs on
#     different runner images are NOT expected to share a digest; that
#     difference is the signal, not a defect.
#   - gates.* — every verdict and every count, including the `null`s and the
#     reasons recorded beside them. An unrun gate changes the digest exactly as
#     much as a failed one, which is correct: both are different evidence.
#   - digest.* — the algorithm and the exclusion rule itself, so a bundle cannot
#     silently change how it was hashed while keeping the same shape.
#
# `bundleDigest` is excluded for the arithmetic reason: a value cannot be inside
# its own preimage.
# ---------------------------------------------------------------------------
DIGEST_EXCLUDED_TOP_LEVEL_KEYS = ("run", "bundleDigest")

CANONICALIZATION = (
    "JSON of the manifest with the keys named in digest.excludes removed, "
    "UTF-8 encoded, object keys sorted, separators ',' and ':', no whitespace, "
    "non-ASCII escaped"
)

# The engine's own reason strings, reproduced verbatim. When mutation-report.json
# is present these are read out of it; when only the gate battery's stdout is
# available the same constants are used, so the two paths produce the same keys
# and therefore the same digest for the same run.
REASON_TEST_INTERNAL = "test-internal (enclosing #[test]/#[test_only])"
REASON_IN_SOURCES_TEST_FILE = "in-sources test file (excluded by directory path)"
REASON_MULTILINE = "multi-line assert (legacy-line derivation)"

INDEPENDENCE_CLAUSE = (
    "This is an internal review by the party that wrote the code. It is evidence, "
    "not an audit: no claim of independence is made, and none should be inferred."
)

# What a survivor is, phrased so that the sentence itself passes the forbidden-word
# check below. The obvious wording — "not a vulnerability, not an exploit" — puts
# exactly the words we are policing into the document, which makes the check
# unenforceable. Saying what a survivor IS carries the same meaning and needs none
# of them.
SURVIVOR_MEANING = (
    "A surviving mutation names an invariant that no test exercises. It is a gap in "
    "the test suite. It is not a defect found in the contract and must not be read "
    "as one, and it carries no rating of any kind."
)

ABSENCE_CONVENTION = (
    "Every count in this bundle is an integer or null. Null never means zero: it "
    "means the number was not measured, and the reason is recorded beside it."
)

# Words REPORT.md may not contain. This tool publishes numbers; a survivor is an
# untested invariant, and the moment a report reaches for security language it has
# made a claim the measurement does not support. The test suite asserts on this
# list, which is why it lives here rather than in the test: one source of truth.
FORBIDDEN_REPORT_TERMS = (
    "vulnerabilit", "exploit", "severity", "critical", "cvss", "cve-",
    "high risk", "attack vector", "0-day", "zero-day",
)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_capture(cmd, cwd=None):
    """Run a command, return (stdout-first-line, None) or (None, reason).

    Never raises: a missing tool is a fact to record, not a crash. The reason is
    written into the manifest so a reader knows WHY a version is absent instead of
    seeing an empty string and guessing.
    """
    try:
        p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=60)
    except FileNotFoundError:
        return None, "%s is not on PATH" % cmd[0]
    except subprocess.TimeoutExpired:
        return None, "%s did not answer within 60s" % " ".join(cmd)
    except OSError as exc:
        return None, "%s could not be executed: %s" % (cmd[0], exc)
    if p.returncode != 0:
        return None, "%s exited %d" % (" ".join(cmd), p.returncode)
    out = p.stdout.decode("utf-8", "replace").strip().split("\n")
    return (out[0].strip() if out and out[0].strip() else None,
            None if out and out[0].strip() else "%s printed nothing" % cmd[0])


def valued(value, reason):
    """A field that is either a value or an explicit absence with a reason."""
    if value is not None:
        return {"value": value, "reason": None}
    return {"value": None, "reason": reason or "not measured; no reason recorded"}


# --- reading the engine's output -------------------------------------------

def parse_gate_verdicts(text):
    """Read gates.sh output back into per-gate verdicts.

    The formats matched here are the engine's own echo lines, verbatim:
      "── gate: build"                then "   build: PASS" | "   build: FAIL"
      "── gate: digest — skipped (…)" (a skipped gate never gets a PASS/FAIL line)

    A gate with no line at all is reported as "not-run" rather than omitted. The
    runner's own sweep step already refuses to let silence read as a pass in the
    pull request; the bundle refuses the same way, on paper.
    """
    verdicts = {}
    for gate in GATES:
        skipped = re.search(r"^── gate: %s — skipped ?(.*)$" % re.escape(gate), text, re.M)
        if skipped:
            detail = skipped.group(1).strip().strip("()")
            verdicts[gate] = {"status": "skipped",
                              "reason": detail or "skipped; the engine gave no detail"}
            continue
        if re.search(r"^   %s: PASS$" % re.escape(gate), text, re.M):
            verdicts[gate] = {"status": "pass", "reason": None}
            continue
        if re.search(r"^   %s: FAIL$" % re.escape(gate), text, re.M):
            verdicts[gate] = {"status": "fail", "reason": None}
            continue
        verdicts[gate] = {
            "status": "not-run",
            "reason": "the gate battery produced no verdict line for this gate; it "
                      "never ran, or the run ended before it reported",
        }
    return verdicts


DERIVED_LINE = re.compile(
    r"^derived (\d+) mutations, (\d+) multi-line skipped, "
    r"(\d+) test-internal asserts excluded, (\d+) in-sources test files excluded$", re.M)
OUTCOME_LINE = re.compile(
    r"^executed: (\d+)\s+killed: (\d+)\s+survived: (\d+)\s+invalid\(no compile\): (\d+)$", re.M)
SETHASH_LINE = re.compile(r"^derivation: (\S+) · operators: (\S+) · set sha256: ([0-9a-f]+)$", re.M)


def parse_mutation_from_log(text):
    """Pull the mutation engine's printed numbers out of the gate battery's log."""
    out = {}
    m = DERIVED_LINE.search(text)
    if m:
        out["derived"] = int(m.group(1))
        out["skipped_multiline"] = int(m.group(2))
        out["excluded_test_internal"] = int(m.group(3))
        out["excluded_test_files"] = int(m.group(4))
    m = OUTCOME_LINE.search(text)
    if m:
        out["executed"] = int(m.group(1))
        out["killed"] = int(m.group(2))
        out["survived"] = int(m.group(3))
        out["invalid"] = int(m.group(4))
    m = SETHASH_LINE.search(text)
    if m:
        out["derivation_mode"] = m.group(1)
        out["operator_classes"] = m.group(2)
        # The log prints only the first 16 hex characters. The full hash lives in
        # mutation-report.json; recording the prefix AS a prefix keeps the two
        # distinguishable instead of publishing a truncated hash as if it were whole.
        out["set_sha256_prefix"] = m.group(3)
    if "nothing to mutate" in text:
        out["blocked"] = "the engine derived no mutations from this package"
    if "BASELINE IS NOT GREEN" in text:
        out["blocked"] = ("the test suite was not green before the first mutation, so "
                          "the engine refused to measure it")
    if "NO MUTANT COMPILED" in text:
        out["blocked"] = ("no mutant compiled, so the run measured nothing about the "
                          "test suite")
    return out


def parse_derive_log(text):
    """Read the unlimited `--list` derivation: how many mutations EXIST.

    The per-pull-request smoke gate runs with `--limit N`, so the number the gate
    reports is the number it RAN, not the number the package contains. Publishing
    the first as if it were the second would understate the work left undone.
    """
    m = DERIVED_LINE.search(text)
    if not m:
        return None
    return {"derivable": int(m.group(1)), "skipped_multiline": int(m.group(2)),
            "excluded_test_internal": int(m.group(3)),
            "excluded_test_files": int(m.group(4))}


def load_mutation_report(path):
    if not path or not os.path.exists(path):
        return None, "the mutation engine wrote no mutation-report.json at %s" % (
            path or "(no path given)")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except (OSError, ValueError) as exc:
        return None, "mutation-report.json could not be read: %s" % exc


# --- the mutation-smoke counts block ---------------------------------------

def mutation_counts(verdict, log_facts, derive_facts, report, report_reason, limit):
    """Build the counts block for the mutation-smoke gate.

    Returns (counts_or_None, reason_when_None). Every field is filled from the
    engine or left null with its own reason in `unavailable` — there is no branch
    in this function that writes a zero it did not read.
    """
    if verdict["status"] == "not-run":
        return None, ("the mutation-smoke gate produced no verdict, so nothing about "
                      "the mutation set was measured")
    if verdict["status"] == "skipped":
        return None, "the mutation-smoke gate was skipped: %s" % verdict["reason"]

    unavailable = {}

    # Prefer the engine's structured report: it carries the exclusion REASONS, not
    # just their totals. Fall back to the numbers the engine printed.
    score = (report or {}).get("score") or {}
    rmanifest = (report or {}).get("manifest") or {}

    derived = rmanifest.get("derived", log_facts.get("derived"))
    if derived is None:
        unavailable["derived"] = ("the engine printed no derivation line and wrote no "
                                  "report; the mutation set size is unknown")

    executed = score.get("executed", log_facts.get("executed"))
    killed = score.get("killed", log_facts.get("killed"))
    survived = score.get("survived", log_facts.get("survived"))
    invalid = score.get("invalid_did_not_compile", log_facts.get("invalid"))
    for name, value in (("executed", executed), ("killed", killed),
                        ("survived", survived), ("invalidDidNotCompile", invalid)):
        if value is None:
            unavailable[name] = (
                log_facts.get("blocked")
                or "the engine reported no outcome line; the run did not reach the "
                   "mutation loop")

    # Excluded, broken down by the engine's own reason strings.
    excluded_by_reason = None
    excluded_total = None
    if report is not None:
        by = {}
        for entry in report.get("excluded_test_internal") or []:
            reason = entry.get("reason") or REASON_TEST_INTERNAL
            by[reason] = by.get(reason, 0) + 1
        files = rmanifest.get("excluded_test_files")
        if files:
            by[REASON_IN_SOURCES_TEST_FILE] = files
        excluded_by_reason = by
        excluded_total = sum(by.values())
    elif "excluded_test_internal" in log_facts:
        by = {}
        if log_facts["excluded_test_internal"]:
            by[REASON_TEST_INTERNAL] = log_facts["excluded_test_internal"]
        if log_facts.get("excluded_test_files"):
            by[REASON_IN_SOURCES_TEST_FILE] = log_facts["excluded_test_files"]
        excluded_by_reason = by
        excluded_total = sum(by.values())
    else:
        unavailable["excluded"] = ("the engine printed no derivation line; exclusions "
                                   "were not measured")

    # Skipped, likewise.
    skipped_by_reason = None
    skipped_total = None
    if report is not None:
        by = {}
        for entry in report.get("skipped") or []:
            reason = entry.get("reason") or REASON_MULTILINE
            by[reason] = by.get(reason, 0) + 1
        skipped_by_reason = by
        skipped_total = sum(by.values())
    elif "skipped_multiline" in log_facts:
        by = {}
        if log_facts["skipped_multiline"]:
            by[REASON_MULTILINE] = log_facts["skipped_multiline"]
        skipped_by_reason = by
        skipped_total = sum(by.values())
    else:
        unavailable["skipped"] = ("the engine printed no derivation line; skipped "
                                  "asserts were not measured")

    # How much of the package the smoke gate did NOT reach.
    derivable = None
    truncated = None
    if derive_facts is not None:
        derivable = derive_facts["derivable"]
        if derived is not None:
            truncated = derivable - derived
    else:
        unavailable["derivable"] = (
            "no unlimited derivation was recorded for this run, so the total number "
            "of mutations the package contains is unknown")
        unavailable["truncatedByLimit"] = (
            "unknown without the unlimited derivation above")

    if limit is None:
        unavailable["limit"] = "the runner did not record the --mutation-limit it used"

    counts = {
        "derivable": derivable,
        "limit": limit,
        "truncatedByLimit": truncated,
        "derived": derived,
        "executed": executed,
        "killed": killed,
        "survived": survived,
        "invalidDidNotCompile": invalid,
        "excluded": {"total": excluded_total, "byReason": excluded_by_reason},
        "skipped": {"total": skipped_total, "byReason": skipped_by_reason},
        "unavailable": unavailable,
    }
    return counts, None


# --- the manifest -----------------------------------------------------------

def engine_tree_sha(repo_root):
    """The git tree object of engine/ — the identity of the instrument.

    Not the repository HEAD: HEAD moves when the README changes, and an evidence
    digest that moves because a README changed is a digest that cries wolf.
    """
    sha, reason = run_capture(["git", "rev-parse", "HEAD:engine"], cwd=repo_root)
    if sha and re.fullmatch(r"[0-9a-f]{40}", sha):
        return sha, None
    return None, reason or "git did not return a tree object for engine/"


def collect_toolchain():
    sui, sui_reason = run_capture(["sui", "--version"])
    py, py_reason = run_capture([sys.executable, "--version"])
    try:
        osver = "%s %s %s" % (platform.system(), platform.release(), platform.machine())
        os_reason = None
    except Exception as exc:  # pragma: no cover - platform never raises in practice
        osver, os_reason = None, "the OS could not be identified: %s" % exc
    return {
        # The OS string IS inside the digest. A different kernel or architecture is
        # a different measurement environment, so two runs on different runner
        # images are not expected to agree — that disagreement is information.
        "sui": valued(sui, sui_reason),
        "python3": valued(py, py_reason),
        "os": valued(osver, os_reason),
    }


def canonical_bytes(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def compute_digest(manifest):
    payload = {k: v for k, v in manifest.items()
               if k not in DIGEST_EXCLUDED_TOP_LEVEL_KEYS}
    return "sha256:" + hashlib.sha256(canonical_bytes(payload)).hexdigest()


def build_manifest(args, repo_root):
    gates_text, gates_reason = "", None
    if args.gates_log and os.path.exists(args.gates_log):
        with open(args.gates_log, encoding="utf-8", errors="replace") as fh:
            gates_text = fh.read()
    else:
        gates_reason = ("no gate battery log was produced at %s; the runner ended "
                        "before the gates wrote anything"
                        % (args.gates_log or "(no path given)"))

    verdicts = parse_gate_verdicts(gates_text)
    if gates_reason:
        for gate in GATES:
            verdicts[gate] = {"status": "not-run", "reason": gates_reason}

    log_facts = parse_mutation_from_log(gates_text)
    report, report_reason = load_mutation_report(args.mutation_report)

    derive_facts = None
    if args.derive_log and os.path.exists(args.derive_log):
        with open(args.derive_log, encoding="utf-8", errors="replace") as fh:
            derive_facts = parse_derive_log(fh.read())

    counts, counts_reason = mutation_counts(
        verdicts["mutation-smoke"], log_facts, derive_facts, report, report_reason,
        args.mutation_limit)

    gates = {}
    for gate in GATES:
        entry = dict(verdicts[gate])
        if gate == "mutation-smoke":
            entry["counts"] = counts
            entry["countsReason"] = counts_reason
            rmanifest = (report or {}).get("manifest") or {}
            entry["mutationSetSha256"] = valued(
                rmanifest.get("mutation_set_sha256"),
                report_reason or "the engine wrote no mutation set hash")
            entry["mutationSetSha256Prefix"] = valued(
                log_facts.get("set_sha256_prefix"),
                "the engine printed no derivation header")
            entry["derivationMode"] = valued(
                rmanifest.get("derivation_mode") or log_facts.get("derivation_mode"),
                "the engine printed no derivation header")
            entry["restoreVerified"] = valued(
                rmanifest.get("restore_verified"),
                report_reason or "the engine wrote no restore verdict")
            entry["survivorMeaning"] = SURVIVOR_MEANING
        gates[gate] = entry

    tree_sha, tree_reason = engine_tree_sha(repo_root)
    runner_head, runner_head_reason = run_capture(["git", "rev-parse", "HEAD"], cwd=repo_root)
    rmanifest = (report or {}).get("manifest") or {}

    manifest = {
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "absenceConvention": ABSENCE_CONVENTION,
        "independenceClause": INDEPENDENCE_CLAUSE,
        "digest": {
            "algorithm": "sha256",
            "canonicalization": CANONICALIZATION,
            "excludes": list(DIGEST_EXCLUDED_TOP_LEVEL_KEYS),
            "excludesWhy": (
                "Everything that differs between two runs of the same commit on the "
                "same toolchain lives under `run` and is excluded, so a re-run can "
                "reproduce the digest. Timestamps, workflow run identifiers, the "
                "ProtocolX Verify repository's own HEAD, and absolute filesystem "
                "paths are all under `run` for that reason. `bundleDigest` is "
                "excluded because a value cannot be inside its own preimage."),
        },
        "subject": {
            "repository": args.repository,
            "commitSha": args.commit,
            "packagePath": args.package_path,
        },
        "engine": {
            "treeSha": valued(tree_sha, tree_reason),
            "treeShaSource": "git rev-parse HEAD:engine — the git tree object of engine/",
            "mutationToolVersion": valued(
                rmanifest.get("tool_version"),
                report_reason or "the engine wrote no tool version"),
        },
        "toolchain": collect_toolchain(),
        "gates": gates,
        "run": {
            "generatedAtUtc": args.generated_at or utc_now(),
            "startedUtc": rmanifest.get("started_utc"),
            "finishedUtc": rmanifest.get("finished_utc"),
            "mutationReportPackageAbsolutePath": rmanifest.get("package"),
            "workflow": {
                "runId": os.environ.get("GITHUB_RUN_ID"),
                "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
                "runnerRepository": os.environ.get("GITHUB_REPOSITORY"),
                "runnerRepoCommit": runner_head if not runner_head_reason else None,
            },
        },
    }
    manifest["bundleDigest"] = compute_digest(manifest)
    return manifest


# --- the human-readable half ------------------------------------------------

def _count(value):
    """Render a count. Null is spelled out, never rendered as a number."""
    return str(value) if value is not None else "not measured"


def build_report(manifest):
    m = manifest
    sha = m["subject"]["commitSha"] or "(commit not recorded)"
    L = []
    a = L.append
    a("# Evidence bundle — %s" % (m["subject"]["repository"] or "(repository not recorded)"))
    a("")
    # The mandatory line. It says three things at once: who reviewed, what exactly
    # was reviewed, and what the reader is allowed to conclude from it.
    a("Internal review of the code as committed at %s — measured evidence, not an audit"
      % sha)
    a("")
    a("> " + INDEPENDENCE_CLAUSE)
    a("")
    a(ABSENCE_CONVENTION)
    a("")
    a("## Subject")
    a("")
    a("| field | value |")
    a("|---|---|")
    a("| repository | `%s` |" % (m["subject"]["repository"] or "not recorded"))
    a("| commit | `%s` |" % sha)
    a("| package | `%s` |" % (m["subject"]["packagePath"] or "not recorded"))
    a("| engine tree | `%s` |" % (m["engine"]["treeSha"]["value"]
                                  or "not recorded — " + str(m["engine"]["treeSha"]["reason"])))
    a("| generated (UTC) | `%s` |" % m["run"]["generatedAtUtc"])
    a("")
    a("## Toolchain")
    a("")
    a("| tool | version |")
    a("|---|---|")
    for key, label in (("sui", "sui"), ("python3", "python3"), ("os", "os")):
        field = m["toolchain"][key]
        a("| %s | `%s` |" % (label, field["value"] or "not recorded — " + str(field["reason"])))
    a("")
    a("## Gates")
    a("")
    a("| gate | result | detail |")
    a("|---|---|---|")
    for gate in GATES:
        g = m["gates"][gate]
        a("| %s | %s | %s |" % (gate, g["status"], g["reason"] or "—"))
    a("")
    a("A gate marked `not-run` produced no verdict. It is not a pass and it is not a "
      "failure of the code: it is a measurement that did not happen, and the reason "
      "is in the detail column.")
    a("")
    a("## Mutation smoke — counts")
    a("")
    ms = m["gates"]["mutation-smoke"]
    counts = ms["counts"]
    if counts is None:
        a("No counts. %s" % (ms["countsReason"] or "no reason recorded"))
        a("")
    else:
        a("- mutations the package contains (unlimited derivation): **%s**"
          % _count(counts["derivable"]))
        a("- limit this run applied: **%s**" % _count(counts["limit"]))
        a("- not reached because of that limit: **%s**" % _count(counts["truncatedByLimit"]))
        a("- derived for this run: **%s**" % _count(counts["derived"]))
        a("- executed: **%s**" % _count(counts["executed"]))
        a("- killed: **%s**" % _count(counts["killed"]))
        a("- survived: **%s**" % _count(counts["survived"]))
        a("- did not compile, excluded from the score: **%s**"
          % _count(counts["invalidDidNotCompile"]))
        a("")
        a("### Excluded from derivation")
        a("")
        if counts["excluded"]["byReason"] is None:
            a("Not measured. %s" % counts["unavailable"].get("excluded", ""))
        elif not counts["excluded"]["byReason"]:
            a("None: total **0**.")
        else:
            a("Total **%s**, by the engine's own reason:" % _count(counts["excluded"]["total"]))
            a("")
            for reason, n in sorted(counts["excluded"]["byReason"].items()):
                a("- %s: **%d**" % (reason, n))
        a("")
        a("### Skipped")
        a("")
        if counts["skipped"]["byReason"] is None:
            a("Not measured. %s" % counts["unavailable"].get("skipped", ""))
        elif not counts["skipped"]["byReason"]:
            a("None: total **0**.")
        else:
            a("Total **%s**, by the engine's own reason:" % _count(counts["skipped"]["total"]))
            a("")
            for reason, n in sorted(counts["skipped"]["byReason"].items()):
                a("- %s: **%d**" % (reason, n))
        a("")
        if counts["unavailable"]:
            a("### Not measured")
            a("")
            for field, reason in sorted(counts["unavailable"].items()):
                a("- `%s`: %s" % (field, reason))
            a("")
    a("### What a survivor means")
    a("")
    a(SURVIVOR_MEANING)
    a("")
    a("## Bundle digest")
    a("")
    a("`%s`" % m["bundleDigest"])
    a("")
    a("The digest is sha256 over the manifest with the %s keys removed, the remainder "
      "serialised as %s."
      % (" and ".join("`%s`" % k for k in DIGEST_EXCLUDED_TOP_LEVEL_KEYS),
         CANONICALIZATION))
    a("")
    a("Included: the repository, the commit, the package path, the engine tree, the "
      "toolchain versions, and every gate verdict and count — including the counts "
      "that are null and the reasons recorded beside them.")
    a("")
    a("Excluded: everything under `run` — the generation timestamp, the engine's "
      "start and finish times, the workflow run identifiers, the ProtocolX Verify "
      "repository's own HEAD, and the absolute filesystem path of the package on the "
      "machine that ran the engine. Those differ on every run of identical inputs; "
      "hashing them would mean the digest never reproduced and therefore never "
      "signalled anything.")
    a("")
    a("Re-running the same commit on the same toolchain reproduces this digest. A "
      "different digest means the code, the engine, the toolchain, or a result "
      "changed — and the manifest says which.")
    a("")
    return "\n".join(L)


def main(argv):
    p = argparse.ArgumentParser(prog="evidence_bundle.py")
    p.add_argument("--out", default="evidence")
    p.add_argument("--repository", default="")
    p.add_argument("--commit", default="")
    p.add_argument("--package-path", default="")
    p.add_argument("--gates-log", default="")
    p.add_argument("--mutation-report", default="")
    p.add_argument("--derive-log", default="")
    p.add_argument("--mutation-limit", type=int, default=None)
    p.add_argument("--generated-at", default="",
                   help="override the generation timestamp; used by the test suite to "
                        "prove the digest does not depend on it")
    args = p.parse_args(argv)

    repo_root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                             os.pardir, os.pardir))
    manifest = build_manifest(args, repo_root)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    with open(os.path.join(args.out, "REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write(build_report(manifest))

    print("evidence bundle: %s/manifest.json · %s/REPORT.md" % (args.out, args.out))
    print("bundleDigest: %s" % manifest["bundleDigest"])
    for gate in GATES:
        print("  %-15s %s" % (gate, manifest["gates"][gate]["status"]))
    # Writing the bundle never fails the run. The verdicts are the gates' job; this
    # step's job is to record them, and a recorder that can veto the thing it records
    # is a recorder nobody should trust.
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
