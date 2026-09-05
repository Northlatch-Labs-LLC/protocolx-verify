#!/usr/bin/env python3
# Built-by: @projectx.sui
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
"""
The instrument's own test suite.

move-mutate exists to say that a passing suite is not evidence. A tool making
that claim while being itself untested would be self-refuting, so these tests
are a deliverable, not a courtesy. The test-internal fixtures pin exact line
numbers, so a refactor that silently re-admits test-internal asserts — or
silently drops a production guard — fails here rather than in the field.

Run:  python3 test/test_movemutate.py
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
FIX = os.path.join(HERE, "fixtures")

import movelex
import operators
import apply as apply_mod
import derive
import report
import deps


def fixture(name):
    with open(os.path.join(FIX, name), encoding="utf-8", errors="replace") as fh:
        return fh.read()


def assert_lines(text):
    return sorted(movelex.line_of(text, a["start"]) for a in movelex.find_asserts(text))


class TestMask(unittest.TestCase):
    def test_line_comment_is_not_code(self):
        m = movelex.mask('let a = 1; // assert!(x, E);\n')
        self.assertNotIn("assert", m)

    def test_block_comment_is_not_code(self):
        m = movelex.mask('/* assert!(x, E); */ let a = 1;')
        self.assertNotIn("assert", m)
        self.assertIn("let a = 1;", m)

    def test_nested_block_comment(self):
        m = movelex.mask('/* a /* b */ assert!(x, E); */ ok')
        self.assertNotIn("assert", m)
        self.assertIn("ok", m)

    def test_string_literal_is_not_code(self):
        m = movelex.mask('let s = b"assert!(fake, E);"; assert!(real, E);')
        self.assertEqual(m.count("assert"), 1)

    def test_mask_preserves_length_and_lines(self):
        src = fixture("synthetic.move")
        m = movelex.mask(src)
        self.assertEqual(len(m), len(src))
        self.assertEqual(m.count("\n"), src.count("\n"))


class TestFindAsserts(unittest.TestCase):
    def setUp(self):
        self.src = fixture("synthetic.move")

    def test_finds_only_real_asserts(self):
        # Comments and string literals must contribute nothing.
        lines = assert_lines(self.src)
        self.assertEqual(len(lines), 8)

    def test_multiline_assert_is_found_and_spans(self):
        spans = [(movelex.line_of(self.src, a["start"]),
                  movelex.line_of(self.src, a["end"] - 1))
                 for a in movelex.find_asserts(self.src)]
        multi = [s for s in spans if s[1] > s[0]]
        self.assertEqual(len(multi), 1, "the 3-line assert must be found as one span")

    def test_semicolonless_tail_assert_is_found(self):
        """The class the `);` predicate cannot see: an assert that is the last
        expression of a function, so Move permits no trailing semicolon. Seen in
        the wild as an authorisation guard, and invisible to the naive
        predicate every mutation tool starts with."""
        tail = [a for a in movelex.find_asserts(self.src)
                if "tail_guard" in (movelex.enclosing_function(
                    movelex.find_functions(self.src), a["start"]) or {}).get("name", "")]
        self.assertEqual(len(tail), 1)


class TestTestInternalExclusion(unittest.TestCase):
    """Pinned regression fixtures for the test-region lexer.

    Every phantom line below is an assertion inside an inline `#[test]` /
    `#[test_only]` declaration, which no test run can ever fail. Scored as a
    surviving mutant it inflates the survivor count in the direction that
    flatters us. Every production line below is the mirror-image failure:
    excluding one would silently shrink our own numbers.

    The fixtures are authored, not captured — annotation-forms.move enumerates
    the declaration shapes, production-guards.move the guards that must survive
    them — so the intended answer is the file, and no third party's source is
    redistributed to ask the question.
    """
    PHANTOMS = {
        "annotation-forms.move": [43, 50, 58, 59, 65, 71, 78, 86, 93, 99],
        "production-guards.move": [41],
    }
    # Production guards in the same files. Excluding one of these would be the
    # mirror-image failure: silently shrinking our own numbers.
    PRODUCTION = {
        "annotation-forms.move": [29, 104],
        "production-guards.move": [17, 21, 27, 32, 45, 50],
    }
    # Authored intent: 11 phantoms across the two fixtures, and not one more.
    # A lexer change that starts governing a declaration it should not moves
    # this number up; one that stops governing a test body moves it down.
    TOTAL_PHANTOMS = 11

    def _excluded(self, fn):
        text = fixture(fn)
        regions = movelex.find_test_regions(text)
        return {movelex.line_of(text, a["start"])
                for a in movelex.find_asserts(text)
                if movelex.in_regions(regions, a["start"])}

    def test_every_known_phantom_is_excluded(self):
        for fn, lines in self.PHANTOMS.items():
            excluded = self._excluded(fn)
            for ln in lines:
                self.assertIn(ln, excluded, "%s:%d must be excluded as test-internal" % (fn, ln))

    def test_total_phantom_count_is_exact(self):
        """Over-exclusion and under-exclusion are both wrong, so the count is
        pinned rather than bounded."""
        total = sum(len(self._excluded(fn)) for fn in self.PHANTOMS)
        self.assertEqual(total, self.TOTAL_PHANTOMS)

    def test_no_production_guard_is_excluded(self):
        for fn, lines in self.PRODUCTION.items():
            excluded = self._excluded(fn)
            for ln in lines:
                self.assertNotIn(ln, excluded,
                                 "%s:%d is production code and must NOT be excluded" % (fn, ln))

    def test_every_assert_is_accounted_for(self):
        """No assert in either fixture may be unclassified: the two pinned sets
        must together name every assert the lexer finds."""
        for fn in self.PHANTOMS:
            text = fixture(fn)
            found = sorted(movelex.line_of(text, a["start"])
                           for a in movelex.find_asserts(text))
            named = sorted(self.PHANTOMS[fn] + self.PRODUCTION[fn])
            self.assertEqual(found, named,
                             "%s: the fixture and the pinned line sets have drifted" % fn)

    def test_non_test_attribute_does_not_open_a_region(self):
        """`#[allow(lint(...))]` carries nested parentheses. Reading it as a
        test annotation would swallow the guard that follows it."""
        self.assertNotIn(29, self._excluded("annotation-forms.move"))

    def test_annotated_use_declaration_ends_at_its_semicolon(self):
        """`#[test_only] use ...;` has no body. A region that brace-matched from
        there would govern the next function instead."""
        text = fixture("annotation-forms.move")
        regions = movelex.find_test_regions(text)
        use_line = [i + 1 for i, ln in enumerate(text.splitlines())
                    if ln.strip() == "use sui::test_scenario;"][0]
        offset = sum(len(ln) + 1 for ln in text.splitlines()[:use_line])
        self.assertFalse(movelex.in_regions(regions, offset + 1),
                         "the declaration after an annotated `use` must not be governed")

    def test_synthetic_annotation_forms(self):
        text = fixture("synthetic.move")
        regions = movelex.find_test_regions(text)
        excluded = sorted(movelex.line_of(text, a["start"])
                          for a in movelex.find_asserts(text)
                          if movelex.in_regions(regions, a["start"]))
        # #[test], #[test_only] on a public fun, and #[test, expected_failure]
        self.assertEqual(len(excluded), 3)

    def test_module_label_form_governs_rest_of_file(self):
        src = ('#[test_only]\nmodule a::b;\n\n'
               'public fun f() {\n    assert!(x, E);\n}\n')
        regions = movelex.find_test_regions(src)
        asserts = movelex.find_asserts(src)
        self.assertEqual(len(asserts), 1)
        self.assertTrue(movelex.in_regions(regions, asserts[0]["start"]),
                        "Move 2024 `module x;` label form must govern the rest of the file")

    def test_module_braced_form(self):
        src = ('#[test_only]\nmodule a::b {\n'
               '    public fun f() { assert!(x, E); }\n}\n'
               'module a::c {\n    public fun g() { assert!(y, E); }\n}\n')
        regions = movelex.find_test_regions(src)
        got = [movelex.in_regions(regions, a["start"]) for a in movelex.find_asserts(src)]
        self.assertEqual(got, [True, False])


class TestOperators(unittest.TestCase):
    def derive_one(self, src, classes):
        masked = movelex.mask(src)
        fns = movelex.find_functions(src)
        a = movelex.find_asserts(src)[0]
        return operators.derive_for_assert(src, masked, a, classes, fns)

    def test_cmp_swaps_are_distinct_and_identified(self):
        muts = self.derive_one("fun f() { assert!(a >= b, E); }", ["CMP"])
        self.assertEqual([m["rule_id"] for m in muts], ["CMP.GE_TO_GT"])
        self.assertEqual(muts[0]["edit_replacement"], ">")

    def test_eq_becomes_ne(self):
        muts = self.derive_one("fun f() { assert!(a == b, E); }", ["CMP"])
        self.assertEqual(muts[0]["rule_id"], "CMP.EQ_TO_NE")

    def test_generic_brackets_are_not_comparisons(self):
        """`vector::length<T>(v)` must not be read as two comparisons."""
        src = "fun f() { assert!(std::vector::length<T>(v) > 0, E); }"
        muts = self.derive_one(src, ["CMP"])
        self.assertEqual([m["rule_id"] for m in muts], ["CMP.GT_TO_GE"])

    def test_boundary_shift_both_directions(self):
        muts = self.derive_one("fun f() { assert!(a > 100, E); }", ["BND"])
        self.assertEqual(sorted(m["rule_id"] for m in muts), ["BND.DEC", "BND.INC"])

    def test_negation_wraps_condition(self):
        muts = self.derive_one("fun f() { assert!(a > b, E); }", ["NEG"])
        self.assertEqual(muts[0]["edit_replacement"], "!(a > b)")

    def test_arg_swap_on_symmetric_op_is_flagged_equivalent(self):
        muts = self.derive_one("fun f() { assert!(a == b, E); }", ["ARG"])
        self.assertTrue(muts[0]["note"], "an == operand swap is equivalent by construction "
                                         "and must carry that note")

    def test_return_injection_only_in_unit_functions(self):
        unit = self.derive_one("fun f() { assert!(a, E); }", ["RET"])
        self.assertEqual(len(unit), 1)
        valued = self.derive_one("fun f(): u64 { assert!(a, E); 1 }", ["RET"])
        self.assertEqual(valued, [], "early return is not legal in a value-returning function")

    def test_deletion_preserves_line_count(self):
        src = "fun f() {\n    assert!(\n        a > b,\n        E\n    );\n}\n"
        muts = self.derive_one(src, ["DEL"])
        out = apply_mod.apply_one(src, dict(muts[0], id="x"))
        self.assertEqual(out.count("\n"), src.count("\n"),
                         "line numbers derived before mutation must stay valid after it")
        self.assertNotIn("assert!", out)

    def test_every_operator_preserves_line_count(self):
        src = fixture("synthetic.move")
        masked = movelex.mask(src)
        fns = movelex.find_functions(src)
        regions = movelex.find_test_regions(src)
        for a in movelex.find_asserts(src):
            if movelex.in_regions(regions, a["start"]):
                continue
            for m in operators.derive_for_assert(src, masked, a, operators.CLASSES, fns):
                out = apply_mod.apply_one(src, dict(m, id="x"))
                self.assertEqual(out.count("\n"), src.count("\n"),
                                 "%s changed the line count" % m["rule_id"])


class TestApply(unittest.TestCase):
    def test_apply_changes_the_file(self):
        src = "fun f() { assert!(a >= b, E); }"
        masked = movelex.mask(src)
        a = movelex.find_asserts(src)[0]
        m = operators.derive_for_assert(src, masked, a, ["CMP"],
                                        movelex.find_functions(src))[0]
        out = apply_mod.apply_one(src, dict(m, id="x"))
        self.assertIn("a > b", out)
        self.assertNotEqual(out, src)

    def test_out_of_range_edit_is_refused(self):
        with self.assertRaises(ValueError):
            apply_mod.apply_one("short", {"edit_offset": 0, "edit_length": 999,
                                          "edit_replacement": "", "id": "x"})


class TestDeterminism(unittest.TestCase):
    """Built in a temp directory, not in the repo: a test that leaves artifacts
    behind makes the working tree lie about what changed."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "sources"))
        with open(os.path.join(self.tmp, "Move.toml"), "w") as fh:
            fh.write("[package]\nname='fx'\n")
        with open(os.path.join(self.tmp, "sources", "a.move"), "w") as fh:
            fh.write(fixture("synthetic.move"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_same_input_same_hash_and_order(self):
        pkg = self.tmp
        files = derive.iter_sources(pkg)
        runs = []
        for _ in range(3):
            muts, _s, _e = derive.derive_parsed(pkg, files, operators.CLASSES)
            muts = derive.finalize(derive.preclassify(muts, pkg))
            runs.append((derive.set_hash(muts), [m["id"] for m in muts]))
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[1], runs[2])

    def test_sources_are_sorted_not_filesystem_ordered(self):
        pkg = self.tmp
        self.assertEqual(derive.iter_sources(pkg), sorted(derive.iter_sources(pkg)))

    def test_ids_are_stable_and_unique(self):
        pkg = self.tmp
        files = derive.iter_sources(pkg)
        muts, _s, _e = derive.derive_parsed(pkg, files, operators.CLASSES)
        muts = derive.finalize(derive.preclassify(muts, pkg))
        ids = [m["id"] for m in muts]
        self.assertEqual(len(ids), len(set(ids)), "mutation ids must be unique")


class TestScoring(unittest.TestCase):
    def test_invalid_mutants_leave_the_denominator(self):
        results = ([{"outcome": "killed"}] * 4 + [{"outcome": "survived"}] * 2 +
                   [{"outcome": "invalid"}] * 4)
        s = report.score(results)
        self.assertEqual(s["executed"], 10)
        self.assertEqual(s["denominator"], 6)
        self.assertAlmostEqual(s["mutation_score_pct"], 66.7, places=1)

    def test_formula_is_stated(self):
        s = report.score([{"outcome": "killed"}])
        self.assertIn("killed / (executed", s["formula"])

    def test_zero_denominator_is_not_a_hundred_percent(self):
        s = report.score([{"outcome": "invalid"}])
        self.assertIsNone(s["mutation_score_pct"],
                          "an undefined score must be undefined, never 100%")


class TestSarifSeverity(unittest.TestCase):
    """A surviving mutant is an untested invariant, not a vulnerability.

    SARIF consumed by GitHub code scanning renders as security alerts, so
    `error` must be unreachable by any code path — not merely unused.
    """
    def test_safe_level_never_returns_error(self):
        for req in ["error", "ERROR", "critical", "high", None, "", "note", "warning"]:
            self.assertIn(report._safe_level(req), ("note", "warning"))

    def test_error_is_not_in_the_allowed_set(self):
        self.assertNotIn("error", report._ALLOWED_LEVELS)

    def _sarif(self):
        manifest = {"package": "/tmp/p", "derived": 2, "operator_classes": ["DEL"]}
        results = [{"id": "a", "file": "sources/a.move", "line": 3, "rule_id": "DEL",
                    "original": "assert!(x, E);", "outcome": "survived", "proposals": []}]
        return report.build_sarif(manifest, results)

    def test_emitted_sarif_contains_no_error_level(self):
        blob = json.dumps(self._sarif())
        self.assertNotIn('"error"', blob)

    def test_results_and_rules_are_note_level(self):
        s = self._sarif()
        run = s["runs"][0]
        for rule in run["tool"]["driver"]["rules"]:
            self.assertEqual(rule["defaultConfiguration"]["level"], "note")
        for res in run["results"]:
            self.assertEqual(res["level"], "note")

    def test_rule_description_carries_the_distinction(self):
        s = self._sarif()
        for rule in s["runs"][0]["tool"]["driver"]["rules"]:
            self.assertIn("not, by itself, an exploit or a finding of vulnerability",
                          rule["fullDescription"]["text"])

    def test_independence_clause_is_verbatim_in_every_format(self):
        clause = ("This is an internal review by the party that wrote the code. It is "
                  "evidence, not an audit: no claim of independence is made, and none "
                  "should be inferred.")
        manifest = {"package": "/tmp/p", "derived": 1, "operator_classes": ["DEL"]}
        results = [{"id": "a", "file": "a.move", "line": 1, "rule_id": "DEL",
                    "original": "assert!(x, E);", "outcome": "survived", "proposals": []}]
        self.assertIn(clause, json.dumps(report.build_sarif(manifest, results)))
        self.assertIn(clause, json.dumps(report.build_json(manifest, results)))
        self.assertIn(clause, report.build_markdown(manifest, results, [], []))


class TestPreclassification(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "sources"))
        with open(os.path.join(self.tmp, "Move.toml"), "w") as fh:
            fh.write("[package]\nname='fx'\n")
        with open(os.path.join(self.tmp, "sources", "a.move"), "w") as fh:
            fh.write(fixture("synthetic.move"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_proposals_are_proposals_not_verdicts(self):
        pkg = self.tmp
        files = derive.iter_sources(pkg)
        muts, _s, _e = derive.derive_parsed(pkg, files, ["ARG"])
        muts = derive.finalize(derive.preclassify(muts, pkg))
        for m in muts:
            for p in m["proposals"]:
                self.assertIn("classification", p)
                self.assertIn("evidence", p)
                self.assertIn("confidence", p)

    def test_nothing_is_auto_dismissed(self):
        """A proposal must never remove a mutation from the set."""
        pkg = self.tmp
        files = derive.iter_sources(pkg)
        raw, _s, _e = derive.derive_parsed(pkg, files, operators.CLASSES)
        n_before = len(raw)
        after = derive.preclassify(raw, pkg)
        self.assertEqual(len(after), n_before)




class TestDelta(unittest.TestCase):
    """The two-pass delta must not manufacture findings out of equivalent mutants."""

    def _docs(self):
        base = {"manifest": {"package": "/tmp/p", "operator_classes": ["DEL"]},
                "score": {"executed": 2, "killed": 2, "survived": 0},
                "results": [
                    {"id": "1", "file": "a.move", "line": 10, "rule_id": "DEL",
                     "original": "assert!(a == b, E);", "outcome": "killed", "proposals": []},
                    {"id": "2", "file": "a.move", "line": 20, "rule_id": "DEL",
                     "original": "assert!(a > b, E);", "outcome": "killed", "proposals": []},
                ]}
        wide = {"manifest": {"package": "/tmp/p", "operator_classes": ["DEL", "ARG", "CMP"]},
                "score": {"executed": 4, "killed": 2, "survived": 2},
                "results": [
                    {"id": "3", "file": "a.move", "line": 10, "rule_id": "ARG.EQ",
                     "original": "assert!(a == b, E);", "outcome": "survived",
                     "proposals": [{"classification": "structurally untestable",
                                    "confidence": "high",
                                    "evidence": "symmetric comparison"}]},
                    {"id": "4", "file": "a.move", "line": 20, "rule_id": "CMP.GT_TO_GE",
                     "original": "assert!(a > b, E);", "outcome": "survived",
                     "proposals": []},
                ]}
        return base, wide

    def test_equivalent_mutants_are_not_headline_findings(self):
        base, wide = self._docs()
        md = report.build_delta_markdown(base, wide)
        head, _, tail = md.partition("equivalent by construction — not findings")
        self.assertIn("a.move:20", head, "a real new finding belongs in the headline")
        self.assertNotIn("a.move:10", head,
                         "an operand swap on `==` cannot change behaviour and is not a finding")
        self.assertIn("a.move:10", tail)

    def test_delta_carries_the_independence_clause(self):
        base, wide = self._docs()
        self.assertIn("evidence, not an audit", report.build_delta_markdown(base, wide))


class TestLocalDependencyClosure(unittest.TestCase):
    """A package whose local dependencies live outside it cannot be copied alone.

    Getting this wrong does not fail loudly: the worker copy simply cannot
    build, every mutant is classified `invalid`, and the run reports a full
    set of results that measured nothing. Observed on a real package —
    84 of 84 invalid, exit code 0.
    """

    def _mk(self, root, name, deps_paths=()):
        d = os.path.join(root, name)
        os.makedirs(os.path.join(d, "sources"), exist_ok=True)
        lines = ["[package]", "name = \"%s\"" % name.replace("/", "_"), ""]
        for i, dep in enumerate(deps_paths):
            lines += ["[dependencies.D%d]" % i, 'local = "%s"' % dep, ""]
        with open(os.path.join(d, "Move.toml"), "w") as fh:
            fh.write("\n".join(lines))
        return d

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_self_contained_package_copies_only_itself(self):
        pkg = self._mk(self.tmp, "solo")
        self.assertEqual(deps.copy_root(pkg), os.path.abspath(pkg),
                         "a package with no local deps must keep the cheap fast path")

    def test_sibling_dependency_lifts_the_copy_root(self):
        self._mk(self.tmp, "libs_math")
        pkg = self._mk(self.tmp, "protocol", ["../libs_math"])
        self.assertEqual(deps.copy_root(pkg), os.path.abspath(self.tmp))

    def test_transitive_local_dependencies_are_followed(self):
        self._mk(self.tmp, "deep")
        self._mk(self.tmp, "mid", ["../deep"])
        pkg = self._mk(self.tmp, "top", ["../mid"])
        self.assertEqual(len(deps.closure(pkg)), 3)

    def test_dev_dependencies_count(self):
        self._mk(self.tmp, "testcoin")
        d = self._mk(self.tmp, "p2")
        with open(os.path.join(d, "Move.toml"), "a") as fh:
            fh.write('\n[dev-dependencies.TestCoin]\nlocal = "../testcoin"\n')
        self.assertEqual(len(deps.closure(d)), 2,
                         "dev-dependencies are needed for `sui move test` and must be copied")

    def test_commented_out_dependency_is_not_followed(self):
        d = self._mk(self.tmp, "p3")
        with open(os.path.join(d, "Move.toml"), "a") as fh:
            fh.write('\n# [dependencies.Ghost]\n# local = "../ghost"\n')
        self.assertEqual(deps.copy_root(d), os.path.abspath(d))

    def test_cycles_terminate(self):
        a = self._mk(self.tmp, "a", ["../b"])
        self._mk(self.tmp, "b", ["../a"])
        self.assertEqual(len(deps.closure(a)), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
