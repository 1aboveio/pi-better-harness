# Integration tests

Real, end-to-end smoke tests that a tool-scoped subagent can actually do work.
Each test runs the **same child invocation `subagent_spawn` builds** in
`index.ts` (`pi -p --mode json`, tool allowlist, the extension set derived from
that allowlist, closed stdin, positional prompt) and parses the result the way
`parse.ts` does. `lib.sh`'s `ext_args` calls the product resolver
(`extensions.mjs` + `config.json`) rather than restating the flags, so the tests
cannot drift from what ships.

| Test | Proves |
|------|--------|
| `test_sandbox_applied.sh` | macOS: the same `sandbox-exec` profile subagents use is applied — writes **inside** `sandbox_dir` succeed (deterministic, no model). |
| `test_sandbox_deny_outside.sh` | macOS: under that profile, writes **outside** `sandbox_dir` are denied and create no file (deterministic, no model). |
| `test_sandbox_wrapper_argv.sh` | macOS: the real product-selected sandbox wrapper preserves every `pi` argv token, including embedded newlines. |
| `sandbox_profile.test.mjs` | Unit: `sandbox.ts` retains the macOS profile and proves Linux builder selection, canonical workdir binding, small writable allowlist, and fail-closed policy. |
| `linux_bubblewrap.integration.mjs` | Linux queue lane: real product-built bubblewrap children prove inside writes, outside and symlink denial, canonical aliases, outside reads, read-only `~/.pi`, host `/tmp`, `/dev/null`, and host-local HTTP. Missing `bwrap` fails this test. |
| `test_web_fetch.sh` | An extension-provided tool (`web_fetch`) works in a scoped child: fetch the repo page, report a word count. |
| `test_gh_issues.sh` | A `bash`-scoped child can drive an external CLI: `gh issue list` against this repo. |
| `test_env_inherit.sh` | The foreground environment (e.g. `GH_TOKEN`) reaches the subagent **through the OS sandbox**, and the child returns the exact inherited marker — credential passing. |
| `test_headless_isolation.sh` | A child survives a parallel `bash` + `read` batch: every `tool_execution_start` has an end, a terminal agent event is reached, and `web_fetch` still works ([#17](https://github.com/1aboveio/pi-better-subagents/issues/17)). |
| `extensions.test.mjs` | Unit: only packages backing a requested tool are loaded; nothing the model passes can widen the runtime. |
| `health_reconcile.test.mjs` | Unit (fake process probes, process-group-only): supervised/orphaned/lost/pid-recycled/old-metadata reconciliation, no-descendant-evidence contract, durability of `orphaned`/`lost`, identity capture, monitoring predicate ([#63](https://github.com/1aboveio/pi-better-subagents/issues/63)). |
| `extension_health_lifecycle.test.mjs` | Extension-level (real extension + fake ExtensionAPI + PATH-injected fake `pi`, real child processes): AC1 spawn→meta.json identity persistence, AC9 fake-clock health-ticker lifecycle (start / persist / self-stop), exit-supersedes-provisional-orphaned/lost interleavings (#63). |
| `registry_identity.test.mjs` | Unit: meta.json round-trips process identity fields, old metadata reads without migration, `orphaned` non-final vs `lost` terminal for result behavior. |
| `smoke_health_reconcile.mjs` | Runtime smoke (real OS processes, not a `.test.mjs`): supervised→orphaned→lost against the kernel — `node tests/smoke_health_reconcile.mjs`. |

## Run

```bash
tests/run_all.sh                                      # full local suite
tests/run_queue.sh                                    # merge-queue suite (sandbox + web_fetch + gh)
PI_SUBAGENT_TEST_MODEL=minimax-cn/MiniMax-M3 tests/run_queue.sh
PI_SUBAGENT_TEST_TIMEOUT=400 tests/run_all.sh         # slower models
tests/test_sandbox_applied.sh                         # one test (macOS)
tests/test_sandbox_deny_outside.sh                    # one test (macOS)
tests/test_sandbox_wrapper_argv.sh                    # one test (macOS)
node --test tests/linux_bubblewrap.integration.mjs    # required Linux bwrap boundary proof
node --test tests/*.test.mjs                          # unit (incl. sandbox profile)
```

Default model is `minimax-cn/MiniMax-M3` (same as local `~/.pi/agent/models.json`).
Needs `MINIMAX_API_KEY` in the environment.

## CI / merge queue

Two-step gate (see `.mergify.yml`):

| Step | Workflow | When | Check name |
|------|----------|------|------------|
| 1. PR gate | `.github/workflows/ci.yml` | every PR | `ci` |
| 2. Queue gate | `.github/workflows/integration-tests.yml` | `mergify/merge-queue/*` only | `integration` |

The Ubuntu queue lane first installs and probes `bwrap`, then runs
`linux_bubblewrap.integration.mjs` as a required real-filesystem boundary test.
It runs `test_env_inherit.sh`, `test_web_fetch.sh`, `test_gh_issues.sh`, and
`test_headless_isolation.sh` through the selected Linux sandbox command. The
PR gate's `macos-sandbox` job runs the existing deterministic macOS
`sandbox-exec` scripts with their unchanged assertions. Linux write-sandbox:
[#5](https://github.com/1aboveio/pi-better-subagents/issues/5).

## What to expect

These make **real model calls and hit the network**, and `test_gh_issues.sh`
needs `gh` authenticated (`gh auth status` or `GH_TOKEN`). A run can be **cut
off** if the model is slow. A cut-off run reports `INCOMPLETE` (exit 2), which is
distinct from a wrong answer (`FAIL`, exit 1) and a pass (exit 0). On
`INCOMPLETE`, just re-run or raise `PI_SUBAGENT_TEST_TIMEOUT`.

Exit codes: `0` pass · `1` finished but assertion failed · `2` incomplete (flake).

## Notes / gotchas baked in

- **stdin must be closed** for the child. `pi -p --mode json` reads stdin as an
  event stream and hangs forever if it stays open; `lib.sh` runs the child with
  `< /dev/null`, mirroring how the extension spawns with stdin `"ignore"`.
- Shell integration tests write under `$TMPDIR/pi-better-subagents-tests`.
  The Linux boundary test uses a temporary directory beneath the checkout so an
  outside probe is not accidentally covered by the approved host `/tmp` mount;
  it removes that directory after every run. It also creates a unique denied-write candidate beneath
  `~/.pi`; it asserts that bubblewrap creates no such host file. Linux children
  can read `~/.pi` but must keep writable pi state in their work directory or
  host `/tmp`.
- **`gh` needs `GH_TOKEN`.** `gh` authenticates via the macOS keychain by
  default; a spawned child touching the keychain can hang on a prompt it can't
  answer. `test_gh_issues.sh` exports `GH_TOKEN` (from `gh auth token`) to bypass
  it. **Product implication:** real subagents using `gh` want `GH_TOKEN` in the
  foreground pi's env — the child inherits it (see `test_env_inherit.sh`).
- **Empty command output confuses the model.** `gh issue list` prints *nothing*
  when a repo has no issues; the model reads the empty result as an error and
  loops. Ask for output that's always non-empty — here `--json number --jq
  length` prints `0`. General lesson for bash-driving subagents.
- **Don't let a prompt's punctuation leak into a command.** "run: `<cmd>`." can
  make the model append the trailing `.` as a literal argument. Put the command
  on its own line and say "no trailing punctuation."
- **Process hygiene.** The watchdog kills the whole run (`pkill -f "$id"`), not
  just the parent — pi spawns detached children that otherwise pile up and cause
  contention (and flaky timeouts). If runs mysteriously slow down, check for
  stray `pi -p` / `sandbox-exec` processes.
