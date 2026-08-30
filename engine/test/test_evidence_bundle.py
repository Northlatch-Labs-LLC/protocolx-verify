#!/usr/bin/env python3
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
"""
The evidence bundle's own test suite.

The bundle is the document an enterprise buyer's auditor is handed. If its
numbers can drift from the engine's numbers, or its digest can move when nothing
about the measurement moved, or an unrun gate can serialise as a zero, then the
bundle is worse than nothing — it is a confident, citable, wrong answer. These
tests exist to make each of those three failures impossible to ship.

PROVENANCE OF THE FIXTURES. `fixtures/nested-fixture-gates.log` and
`fixtures/nested-fixture-mutation-report.json` are the VERBATIM, unedited output
of a real gate-battery run against `engine/test/nested-fixture`, executed on
2026-08-30 with `sui 1.77.2-51d177ad7d65` on Darwin:

    bash engine/ci/gates.sh <copy-of-nested-fixture> --mutation-limit 5

They are not hand-written. The absolute paths inside them are the paths of the
machine that produced them and have been left alone, because a fixture edited to
look tidy is no longer evidence of anything. Those paths are inert here: the
bundle takes the package path from its own argument, and the absolute path the
engine recorded lives under `run`, outside the digest.

The derivation half of the suite does not use a fixture at all — it runs the
SHIPPED engine live via `--list`, which needs python3 but not sui, and compares
the bundle's numbers to the numbers the engine prints in that moment.

Run:  python3 engine/test/test_evidence_bundle.py
"""
import argparse
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, os.pardir, os.pardir))
sys.path.insert(0, os.path.join(REPO_ROOT, "engine", "evidence"))

import evidence_bundle as eb

FIX = os.path.join(HERE, "fixtures")
GATES_LOG = os.path.join(FIX, "nested-fixture-gates.log")
MUTATION_REPORT = os.path.join(FIX, "nested-fixture-mutation-report.json")
NESTED_FIXTURE = os.path.join(HERE, "nested-fixture")
ENGINE = os.path.join(REPO_ROOT, "engine", "move-mutate", "move-mutate.sh")


def args(**over):
    """A default argument set; every test overrides only what it is about."""
    base = dict(out="", repository="Northlatch-Labs-LLC/nested-fixture",
                commit="0123456789abcdef0123456789abcdef01234567",
                package_path="sui-contracts", gates_log=GATES_LOG,
                mutation_report=MUTATION_REPORT, derive_log="", mutation_limit=5,
                generated_at="2026-08-30T00:00:00Z")
    base.update(over)
    return argparse.Namespace(**base)


def build(**over):
    return eb.build_manifest(args(**over), REPO_ROOT)


def engine_list_output():
    """Run the SHIPPED engine's derivation on the nested fixture, live."""
    p = subprocess.run(["bash", ENGINE, NESTED_FIXTURE, "--list"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    text = p.stdout.decode("utf-8", "replace")
    if p.returncode != 0:
        raise AssertionError("the shipped engine failed its own --list:\n" + text)
    return text


class TestNumbersMatchTheEngine(unittest.TestCase):
    """(a) Every number in the manifest is the engine's number."""

    @classmethod
    def setUpClass(cls):
        cls.list_text = engine_list_output()
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False,
                                         encoding="utf-8") as fh:
            fh.write(cls.list_text)
            cls.derive_log = fh.name
        cls.manifest = build(derive_log=cls.derive_log)
        cls.counts = cls.manifest["gates"]["mutation-smoke"]["counts"]
        with open(GATES_LOG, encoding="utf-8") as fh:
            cls.raw_log = fh.read()

    @classmethod
    def tearDownClass(cls):
        os.unlink(cls.derive_log)

    def test_live_engine_derivation_matches_the_manifest(self):
        """The unlimited derivation the engine printed just now is what we published."""
        m = re.search(r"^derived (\d+) mutations, (\d+) multi-line skipped, "
                      r"(\d+) test-internal asserts excluded, "
                      r"(\d+) in-sources test files excluded$",
                      self.list_text, re.M)
        self.assertIsNotNone(m, "the shipped engine printed no derivation line:\n"
                             + self.list_text)
        self.assertEqual(self.counts["derivable"], int(m.group(1)))
        # The nested fixture's four production guards — the same number app-path.sh
        # pins. If this moves, the fixture changed and the bundle followed it.
        self.assertEqual(self.counts["derivable"], 4)

    def test_gate_verdicts_are_the_engines_verdicts(self):
        g = self.manifest["gates"]
        self.assertEqual(g["build"]["status"], "pass")
        self.assertEqual(g["tests"]["status"], "pass")
        self.assertEqual(g["digest"]["status"], "skipped")
        self.assertIn("no ci-expected-digest", g["digest"]["reason"])
        self.assertEqual(g["pin"]["status"], "skipped")
        self.assertEqual(g["mutation-smoke"]["status"], "fail")

    def test_outcome_counts_are_the_engines_counts(self):
        # Read independently out of the raw log, so a bug in the module's parser
        # cannot rubber-stamp itself.
        self.assertIn("executed: 4  killed: 0  survived: 4  invalid(no compile): 0",
                      self.raw_log)
        self.assertEqual(self.counts["executed"], 4)
        self.assertEqual(self.counts["killed"], 0)
        self.assertEqual(self.counts["survived"], 4)
        self.assertEqual(self.counts["invalidDidNotCompile"], 0)
        self.assertEqual(self.counts["derived"], 4)

    def test_exclusions_carry_the_engines_own_reasons(self):
        self.assertIn("3 test-internal asserts excluded", self.raw_log)
        self.assertIn("1 in-sources test files excluded", self.raw_log)
        by = self.counts["excluded"]["byReason"]
        self.assertEqual(by[eb.REASON_TEST_INTERNAL], 3)
        self.assertEqual(by[eb.REASON_IN_SOURCES_TEST_FILE], 1)
        self.assertEqual(self.counts["excluded"]["total"], 4)

    def test_skipped_is_a_measured_zero_here(self):
        """Zero IS the right answer when the engine measured zero — and only then."""
        self.assertIn("0 multi-line skipped", self.raw_log)
        self.assertEqual(self.counts["skipped"]["total"], 0)
        self.assertEqual(self.counts["skipped"]["byReason"], {})
        self.assertNotIn("skipped", self.counts["unavailable"])

    def test_limit_truncation_is_stated(self):
        self.assertEqual(self.counts["limit"], 5)
        self.assertEqual(self.counts["truncatedByLimit"], 0)

    def test_mutation_set_hash_is_the_engines_hash(self):
        ms = self.manifest["gates"]["mutation-smoke"]
        with open(MUTATION_REPORT, encoding="utf-8") as fh:
            report = json.load(fh)
        self.assertEqual(ms["mutationSetSha256"]["value"],
                         report["manifest"]["mutation_set_sha256"])
        # The log prints only 16 hex characters; it is published AS a prefix, never
        # as if it were the whole hash.
        self.assertTrue(ms["mutationSetSha256"]["value"].startswith(
            ms["mutationSetSha256Prefix"]["value"]))
        self.assertEqual(len(ms["mutationSetSha256Prefix"]["value"]), 16)

    def test_engine_identity_is_recorded(self):
        tree = self.manifest["engine"]["treeSha"]
        self.assertIsNotNone(tree["value"],
                             "engine tree sha absent: %s" % tree["reason"])
        self.assertRegex(tree["value"], r"^[0-9a-f]{40}$")


class TestDigest(unittest.TestCase):
    """(b) Stable across runs; moves when a result moves."""

    def test_two_builds_of_the_same_inputs_agree(self):
        self.assertEqual(build()["bundleDigest"], build()["bundleDigest"])

    def test_the_timestamp_is_not_in_the_digest(self):
        """The reproducibility property, stated as a test.

        Two runs of the same commit are minutes or months apart. If the generation
        timestamp reached the digest, no re-run could ever reproduce it and the
        digest would report a change on every comparison — which is the same as
        reporting nothing.
        """
        a = build(generated_at="2026-08-30T00:00:00Z")
        b = build(generated_at="2027-01-01T23:59:59Z")
        self.assertNotEqual(a["run"]["generatedAtUtc"], b["run"]["generatedAtUtc"])
        self.assertEqual(a["bundleDigest"], b["bundleDigest"])

    def test_nothing_under_run_is_in_the_digest(self):
        base = build()
        mutated = copy.deepcopy(base)
        mutated["run"]["workflow"]["runId"] = "9999999999"
        mutated["run"]["startedUtc"] = "1999-01-01T00:00:00Z"
        mutated["run"]["mutationReportPackageAbsolutePath"] = "/somewhere/else"
        self.assertEqual(eb.compute_digest(mutated), base["bundleDigest"])

    def test_a_changed_result_changes_the_digest(self):
        """The load-bearing direction: evidence changed, digest changed."""
        base = build()
        with open(GATES_LOG, encoding="utf-8") as fh:
            log = fh.read()
        flipped = log.replace("   tests: PASS", "   tests: FAIL")
        self.assertNotEqual(flipped, log)
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False,
                                         encoding="utf-8") as fh:
            fh.write(flipped)
            path = fh.name
        try:
            changed = build(gates_log=path)
        finally:
            os.unlink(path)
        self.assertEqual(changed["gates"]["tests"]["status"], "fail")
        self.assertNotEqual(changed["bundleDigest"], base["bundleDigest"])

    def test_a_changed_count_changes_the_digest(self):
        base = build()
        mutated = copy.deepcopy(base)
        mutated["gates"]["mutation-smoke"]["counts"]["survived"] = 3
        self.assertNotEqual(eb.compute_digest(mutated), base["bundleDigest"])

    def test_a_changed_commit_changes_the_digest(self):
        self.assertNotEqual(build(commit="deadbeef" * 5)["bundleDigest"],
                            build()["bundleDigest"])

    def test_digest_is_not_inside_its_own_preimage(self):
        base = build()
        mutated = copy.deepcopy(base)
        mutated["bundleDigest"] = "sha256:" + "0" * 64
        self.assertEqual(eb.compute_digest(mutated), base["bundleDigest"])

    def test_the_manifest_states_its_own_exclusion_rule(self):
        d = build()["digest"]
        self.assertEqual(d["algorithm"], "sha256")
        self.assertEqual(d["excludes"], ["run", "bundleDigest"])


class TestAbsenceIsNeverZero(unittest.TestCase):
    """(c) An unrun gate serialises as null with a reason."""

    def test_no_gates_log_at_all(self):
        m = build(gates_log="/nonexistent/gates.log")
        for gate in eb.GATES:
            self.assertEqual(m["gates"][gate]["status"], "not-run", gate)
            self.assertTrue(m["gates"][gate]["reason"], gate)
        ms = m["gates"]["mutation-smoke"]
        self.assertIsNone(ms["counts"])
        self.assertTrue(ms["countsReason"])

    def test_the_gate_died_mid_battery(self):
        """The real shape of a runner that ran out of time: build passed, silence after."""
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False,
                                         encoding="utf-8") as fh:
            fh.write("── gate: build\n   build: PASS\n")
            path = fh.name
        try:
            m = build(gates_log=path, mutation_report="")
        finally:
            os.unlink(path)
        self.assertEqual(m["gates"]["build"]["status"], "pass")
        self.assertEqual(m["gates"]["tests"]["status"], "not-run")
        ms = m["gates"]["mutation-smoke"]
        self.assertEqual(ms["status"], "not-run")
        self.assertIsNone(ms["counts"])
        self.assertIn("no verdict", ms["countsReason"])

    def test_null_is_serialised_as_null_and_never_as_zero(self):
        """The check that actually protects the reader of the JSON file."""
        m = build(gates_log="/nonexistent/gates.log")
        blob = json.dumps(m["gates"]["mutation-smoke"], sort_keys=True)
        self.assertIn('"counts": null', json.dumps(m["gates"]["mutation-smoke"],
                                                   indent=2, sort_keys=True))
        self.assertNotIn(": 0", blob)

    def test_a_skipped_gate_is_not_a_pass_and_not_a_zero(self):
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False,
                                         encoding="utf-8") as fh:
            fh.write("── gate: build\n   build: PASS\n"
                     "── gate: mutation-smoke — skipped by flag\n")
            path = fh.name
        try:
            m = build(gates_log=path, mutation_report="")
        finally:
            os.unlink(path)
        ms = m["gates"]["mutation-smoke"]
        self.assertEqual(ms["status"], "skipped")
        self.assertIsNone(ms["counts"])
        self.assertIn("skipped", ms["countsReason"])

    def test_a_missing_derivation_is_null_with_a_reason_not_zero(self):
        """Counts that the engine DID report survive; the one it did not goes null."""
        m = build(derive_log="")
        counts = m["gates"]["mutation-smoke"]["counts"]
        self.assertIsNone(counts["derivable"])
        self.assertIsNone(counts["truncatedByLimit"])
        self.assertIn("derivable", counts["unavailable"])
        self.assertIn("truncatedByLimit", counts["unavailable"])
        self.assertEqual(counts["survived"], 4)

    def test_a_missing_toolchain_is_named_not_blank(self):
        m = build()
        for key in ("sui", "python3", "os"):
            field = m["toolchain"][key]
            self.assertTrue(field["value"] or field["reason"],
                            "%s is neither a value nor a reason" % key)


class TestHumanReport(unittest.TestCase):
    def setUp(self):
        self.manifest = build()
        self.text = eb.build_report(self.manifest)

    def test_the_mandatory_line_is_present_verbatim(self):
        self.assertIn(
            "Internal review of the code as committed at %s — measured evidence, "
            "not an audit" % self.manifest["subject"]["commitSha"], self.text)

    def test_the_independence_clause_is_present(self):
        self.assertIn(eb.INDEPENDENCE_CLAUSE, self.text)

    def test_survivors_are_named_as_untested_invariants(self):
        self.assertIn("names an invariant that no test exercises", self.text)

    def test_the_report_uses_no_severity_language(self):
        lowered = self.text.lower()
        for term in eb.FORBIDDEN_REPORT_TERMS:
            self.assertNotIn(term, lowered,
                             "REPORT.md says %r — a surviving mutation is an untested "
                             "invariant and carries no rating" % term)

    def test_counts_appear_as_numbers_not_adjectives(self):
        self.assertIn("- survived: **4**", self.text)
        self.assertIn("- killed: **0**", self.text)
        self.assertIn("- executed: **4**", self.text)

    def test_an_unmeasured_count_is_spelled_out_not_printed_as_zero(self):
        text = eb.build_report(build(gates_log="/nonexistent/gates.log"))
        self.assertIn("No counts.", text)
        self.assertNotIn("- survived: **0**", text)

    def test_the_digest_and_its_exclusions_are_documented_in_the_report(self):
        self.assertIn(self.manifest["bundleDigest"], self.text)
        self.assertIn("Excluded: everything under `run`", self.text)
        self.assertIn("generation timestamp", self.text)


class TestWritesBothFiles(unittest.TestCase):
    def test_main_writes_manifest_and_report(self):
        with tempfile.TemporaryDirectory() as out:
            rc = eb.main(["--out", out, "--repository", "o/r", "--commit", "a" * 40,
                          "--package-path", "pkg", "--gates-log", GATES_LOG,
                          "--mutation-report", MUTATION_REPORT, "--mutation-limit", "5",
                          "--generated-at", "2026-08-30T00:00:00Z"])
            self.assertEqual(rc, 0)
            with open(os.path.join(out, "manifest.json"), encoding="utf-8") as fh:
                manifest = json.load(fh)
            self.assertEqual(manifest["schema"], eb.SCHEMA)
            self.assertTrue(manifest["bundleDigest"].startswith("sha256:"))
            self.assertTrue(os.path.getsize(os.path.join(out, "REPORT.md")) > 0)

    def test_the_writer_never_vetoes_the_run(self):
        """A recorder that can fail the job it records is a recorder nobody trusts."""
        with tempfile.TemporaryDirectory() as out:
            self.assertEqual(eb.main(["--out", out, "--gates-log", "/nonexistent"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
