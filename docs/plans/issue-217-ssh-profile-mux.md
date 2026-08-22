# Issue #217 implementation plan

Source: GitHub issue #217 and the rush implement brief. Test seams are the registered Pi tools/lifecycle hooks and the canonical fake remote runner.

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| Preserve explicit-host `remote_bash`, safe mux execution, and local built-in `bash` | characterization | done | `npm test -w packages/pi-better-ssh` passed 10/10 at base; `remote-bash.test.ts` and extension tool-name contract |
| `ssh_profile list/use/status/clear` over parsed `~/.ssh/config` aliases; persist active defaults in the Pi session branch | profile | done | `packages/pi-better-ssh/src/e2e.test.ts:65`; focused extension suite passed 4/4 |
| Host-less `remote_bash` resolves active host/workdir/env; no profile still errors clearly | profile execution | done | `packages/pi-better-ssh/src/remote-bash.test.ts:104` and `e2e.test.ts:65`; focused suites passed |
| `ssh_mux status/stop` handles a target and all known current-session masters through fake-runner control argv | mux controls | done | `packages/pi-better-ssh/src/e2e.test.ts:190`; target/all control argv and missing-scope paths pass |
| Keyed best-effort footer shows active target/workdir and mux up/down; clears on profile clear/shutdown | footer lifecycle | done | `packages/pi-better-ssh/src/e2e.test.ts:66`; focused extension suite passed and asserts no `bash` override |
| Package, core consumer, and repository verification are honestly green | closeout | done | SSH 14/14, core 11/11, background 98/98, full workspace 606/606, typecheck and pack passed; lint/scan clean, ledger unavailable without inherited inventory |
