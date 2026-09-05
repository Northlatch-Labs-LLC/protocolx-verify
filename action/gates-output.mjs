// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// gates-output — read the gate battery's own stdout back into per-gate verdicts.
//
// WHY THIS FILE EXISTS AS A SEPARATE FILE. action/summary.mjs used to import this
// logic from a module outside the action's own directories. That module does not ship
// with the composite action, so in a tree without it the last step of every run died
// with ERR_MODULE_NOT_FOUND: no verdicts, no summary, no outputs — the run failed for a
// reason that had nothing to do with the client's code, after doing all the work.
// Measured on a hosted runner against a tree that omitted it, which is the only way
// that class of defect is ever found.
//
// So the action's runtime closure now reaches only into action/, runner/ and engine/,
// and this file is the copy it reaches.
//
// THE COST, STATED. Two implementations of one parser can drift, and a drifted parser
// reports a gate verdict differently from the one that reads the same lines elsewhere.
// A mirror test runs both against the same inputs — including a real captured
// gates.log — and fails if they ever disagree.
//
// The formats matched here are the engine's own echo lines, verbatim:
//   "── gate: build"       then "   build: PASS" | "   build: FAIL"
//   "── gate: digest — skipped (…)"          (a skipped gate never gets a PASS/FAIL line)

export const GATES = ['build', 'digest', 'tests', 'pin', 'mutation-smoke'];

export function parseGatesOutput(text) {
  const results = {};
  for (const gate of GATES) {
    const skipped = text.match(new RegExp(`^── gate: ${gate} — skipped ?(.*)$`, 'm'));
    if (skipped) {
      results[gate] = { conclusion: 'neutral', note: (skipped[1] || 'skipped').trim() };
      continue;
    }
    if (new RegExp(`^   ${gate}: PASS$`, 'm').test(text)) {
      results[gate] = { conclusion: 'success', note: 'pass' };
      continue;
    }
    if (new RegExp(`^   ${gate}: FAIL$`, 'm').test(text)) {
      results[gate] = { conclusion: 'failure', note: 'fail' };
    }
    // A gate with no line at all stays absent — the caller turns silence into an
    // explicit failure, because "never ran" must not read as "passed".
  }
  return results;
}
