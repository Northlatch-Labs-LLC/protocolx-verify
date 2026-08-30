#!/usr/bin/env python3
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
"""
workflow-audit — read .github/workflows/verify-run.yml and prove key distance from its
own text.

This is the half of the secret-distance proof that a runtime test cannot give you. The
runtime test proves that the sandbox wrapper scrubs an environment; this proves that the
workflow actually PUTS the client's code behind that wrapper, and that no credential is
in scope when it does. Those are different claims, and the second one is the one a future
edit is most likely to break — someone adds `env: TOKEN: ...` to the gates step for a
"quick fix" and nothing complains.

Two families of assertion, all derived from the file rather than from a list we maintain
by hand.

SECRET DISTANCE — the property this file was written for:

  1. No step both holds a credential and executes client code.
  2. Every invocation of the gate battery goes through runner/sandbox.sh.
  3. No `run:` block contains a `${{ }}` expression. GitHub substitutes those into the
     script text before bash ever sees it, so a client-controlled value there is command
     injection. Values reach the shell as environment variables or not at all.
  4. No credential is ever interpolated into a URL.
  5. Every credentialed step executes tooling from the staged copy, not the workspace —
     the workspace is the tree the client's package sits beside.

MEASUREMENT RESILIENCE — an orthogonal property, asserted here so that hardening this
file can never quietly cost it. Delivery must never be a precondition of measurement:

  6. Marking check runs in progress is continue-on-error. It is a liveness signal, not
     evidence, and a GitHub API hiccup must cost a colour rather than a gate.
  7. The evidence bundle is built and uploaded in always() steps, so a run that died
     half way through still leaves the record naming what never reported.
  8. The one deliberate withholding — a tripped tamper tripwire — is wired to the
     tripwire's own output and to nothing else, so nobody can widen it into a general
     "skip reporting when something upstream failed".

The two families never trade against each other. A resolution that weakens one to satisfy
the other is wrong, and this file is where that gets caught.

Stdlib only, and a deliberately small hand-rolled parser: PyYAML is not in the standard
library, and adding a dependency to a file whose whole subject is trust would be funny in
the wrong way.
"""
import re
import sys

WORKFLOW = ".github/workflows/verify-run.yml"

STEP_RE = re.compile(r"^      - (.*)$")
KEY_RE = re.compile(r"^        ([A-Za-z_-]+):\s?(.*)$")
ENVVAR_RE = re.compile(r"^          ([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$")


def parse_steps(text):
    """Return a list of {name, uses, env: {k: v}, run: str, raw: str}."""
    steps = []
    lines = text.split("\n")
    i = 0
    # Walk to the verify job's step list.
    while i < len(lines) and lines[i].strip() != "steps:":
        i += 1
    i += 1
    cur = None
    mode = None          # None | "run" | "env"
    while i < len(lines):
        line = lines[i]
        if line.strip() and not line.startswith("      "):
            break        # left the steps list
        m = STEP_RE.match(line)
        if m:
            if cur:
                steps.append(cur)
            cur = {"name": "", "uses": "", "env": {}, "run": "", "raw": ""}
            mode = None
            first = m.group(1)
            km = re.match(r"^([A-Za-z_-]+):\s?(.*)$", first)
            if km:
                key, value = km.group(1), km.group(2)
                if key == "run" and value.strip() in ("|", ">", "|-", ">-"):
                    mode = "run"
                elif key == "env" and value.strip() == "":
                    mode = "env"
                else:
                    cur[key] = value.strip() if key in ("name", "uses") else value
                    if key == "run":
                        cur["run"] = value
            cur["raw"] += line + "\n"
            i += 1
            continue
        if cur is None:
            i += 1
            continue
        cur["raw"] += line + "\n"
        km = KEY_RE.match(line)
        if km:
            key, value = km.group(1), km.group(2)
            mode = None
            if key == "run":
                if value.strip() in ("|", ">", "|-", ">-"):
                    mode = "run"
                else:
                    cur["run"] += value + "\n"
            elif key == "env" and value.strip() == "":
                mode = "env"
            elif key in ("name", "uses"):
                cur[key] = value.strip()
            i += 1
            continue
        if mode == "env":
            em = ENVVAR_RE.match(line)
            if em:
                cur["env"][em.group(1)] = em.group(2)
                i += 1
                continue
            if line.strip():
                mode = None
        if mode == "run":
            if line.strip() == "" or line.startswith("          "):
                cur["run"] += line[10:] if len(line) > 10 else ""
                cur["run"] += "\n"
                i += 1
                continue
            mode = None
        i += 1
    if cur:
        steps.append(cur)
    return steps


def uncommented(run):
    """The run block with whole-line shell comments removed."""
    return "\n".join(l for l in run.split("\n") if not l.lstrip().startswith("#"))


CREDENTIAL_MARKERS = ("secrets.", "steps.mint.outputs.token")

CRED_NAME_RE = re.compile(
    r"(^|_)(TOKEN|TOKENS|SECRET|SECRETS|KEY|KEYS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL"
    r"|CREDENTIALS|PRIVATE|AUTH|SESSION|COOKIE|SIGNATURE|APIKEY|BEARER)(_|$)",
    re.I,
)


def main():
    with open(WORKFLOW, encoding="utf-8") as fh:
        text = fh.read()
    steps = parse_steps(text)
    # An audit that cannot read the file must not pass it. Cross-check the parse against a
    # raw count of step markers, so parser drift shows up as a failure rather than as
    # silently auditing three steps and declaring victory.
    declared = sum(1 for l in text.split("\n") if STEP_RE.match(l))
    if len(steps) < 10 or len(steps) != declared:
        print(f"FAIL: parsed {len(steps)} steps from {WORKFLOW} but the file declares "
              f"{declared} — the parser is out of step with the file.", file=sys.stderr)
        return 1

    failures = []
    checked = 0

    for step in steps:
        label = step["name"] or step["uses"] or "<unnamed>"
        env_text = "\n".join(f"{k}={v}" for k, v in step["env"].items())
        credentialed = any(m in env_text for m in CREDENTIAL_MARKERS)
        body = uncommented(step["run"])
        runs_engine = ("engine/ci/gates.sh" in body) or ("move-mutate/move-mutate.sh" in body)
        sandboxed = "sandbox.sh" in body

        # 1. disjoint sets
        if credentialed and (runs_engine or sandboxed):
            failures.append(
                f'step "{label}" both carries a credential in its env and executes client '
                f"code. These must be disjoint."
            )
        checked += 1

        # 2. the gate battery only runs behind the sandbox
        if runs_engine and not sandboxed:
            failures.append(
                f'step "{label}" invokes the gate battery without runner/sandbox.sh.'
            )

        # 3. no expression substitution into a shell
        for expr in re.findall(r"\$\{\{[^}]*\}\}", step["run"]):
            failures.append(
                f'step "{label}" interpolates {expr.strip()} into its run block. GitHub '
                f"substitutes that into the script text before bash parses it; pass the "
                f"value through env: instead."
            )

        # 4. no credential in a URL. A URL may interpolate ordinary values (a pinned
        #    release version, an owner/name), but never a credential-shaped variable and
        #    never a userinfo field — that is the form git writes into .git/config.
        for m in re.finditer(r"https?://[^\s\"']*", body):
            url = m.group(0)
            for var in re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)", url):
                if CRED_NAME_RE.search(var):
                    failures.append(
                        f'step "{label}" interpolates the credential-shaped variable '
                        f"${var} into a URL ({url!r}). A credential in a URL is written "
                        f"into .git/config and into every log that echoes the remote."
                    )
            if re.search(r"//[^/\s\"']*\$[^/\s\"']*@", url):
                failures.append(
                    f'step "{label}" puts a shell variable in a URL userinfo field: {url!r}.'
                )

        # 5. credentialed steps run the staged tooling copy
        if credentialed and body.strip():
            for m in re.finditer(r"node\s+(\S+)", body):
                target = m.group(1)
                if "pvs-tooling" not in target:
                    failures.append(
                        f'step "{label}" holds a credential but executes {target} from the '
                        f"workspace. Credentialed steps must run the copy staged outside it."
                    )

    # --- measurement resilience -------------------------------------------------------
    by_name = {s["name"]: s for s in steps if s["name"]}

    def need(name):
        if name not in by_name:
            failures.append(f'no step named "{name}" — the audit cannot check it, and a '
                            f"renamed step is an untested step")
            return None
        return by_name[name]

    marking = need("Mark gates in progress")
    if marking and "continue-on-error: true" not in marking["raw"]:
        failures.append(
            '"Mark gates in progress" is not continue-on-error. Colouring five rows '
            "yellow is delivery; it must never be able to stop a measurement."
        )

    for name in ("Build the evidence bundle", "Upload the evidence bundle",
                 "Extract the measurement from the sandbox"):
        st = need(name)
        if st is None:
            continue
        cond = ""
        m = re.search(r"^ {8}if: (.*)$", st["raw"], re.M)
        if m:
            cond = m.group(1)
        if "always()" not in cond:
            failures.append(
                f'"{name}" is not always()-conditioned. A run that died half way through '
                f"must still leave its record."
            )

    # The tamper tripwire is the ONLY thing allowed to withhold a verdict, and it must be
    # wired to the tripwire's own output rather than to some broader notion of "upstream
    # went wrong" — that is how a narrow, justified exception turns into a lost gate.
    TRIPWIRE = "steps.integrity.outputs.intact != '0'"
    for name in ("Report gate verdicts", "Build the evidence bundle"):
        st = need(name)
        if st and TRIPWIRE not in st["raw"]:
            failures.append(
                f'"{name}" does not decline on a tripped tamper tripwire '
                f"({TRIPWIRE}). It would publish from a tree we cannot vouch for."
            )
    upload = need("Upload the evidence bundle")
    if upload and TRIPWIRE in upload["raw"]:
        failures.append(
            '"Upload the evidence bundle" must NOT decline on the tripwire — if the '
            "sandbox was breached, the record of the run is the most useful thing to keep."
        )

    # The wiring tests in runner/test/wiring.test.mjs address steps by exact name.
    # Renaming one does not fail those tests, it un-tests them.
    for name in ("Run the gates", "Install Sui CLI (pinned)",
                 "Verify the mutation engine before touching client code",
                 "Report gate verdicts", "Sweep unfinished check runs"):
        need(name)

    # checkout must not leave the job token in the workspace .git/config
    checkout = [s for s in steps if s["uses"].startswith("actions/checkout")]
    if not checkout:
        failures.append("no actions/checkout step found")
    elif "persist-credentials: false" not in checkout[0]["raw"]:
        failures.append("actions/checkout does not set persist-credentials: false")

    print(f"workflow-audit: {checked} steps read from {WORKFLOW}")
    for step in steps:
        label = step["name"] or step["uses"] or "<unnamed>"
        env_text = "\n".join(f"{k}={v}" for k, v in step["env"].items())
        cred = any(m in env_text for m in CREDENTIAL_MARKERS)
        body = uncommented(step["run"])
        client = ("engine/ci/gates.sh" in body) or ("move-mutate/move-mutate.sh" in body)
        mark = "CREDENTIALED" if cred else ("CLIENT-CODE  " if client else "neutral      ")
        print(f"  {mark}  {label}")

    if failures:
        print("", file=sys.stderr)
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print("workflow-audit: credentialed steps and client-executing steps are disjoint")
    print("workflow-audit: measurement resilience intact — marking is continue-on-error, "
          "the bundle is always(), and only the tamper tripwire withholds a verdict")
    return 0


if __name__ == "__main__":
    sys.exit(main())
