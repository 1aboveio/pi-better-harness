# Issue #217 implementation plan

Source: GitHub issue #217 and the rush implement brief. Test seams are the registered Pi tools/lifecycle hooks and the canonical fake remote runner.

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| Preserve explicit-host `remote_bash`, safe mux execution, and local built-in `bash` | characterization | done | `npm test -w packages/pi-better-ssh` passed 10/10 at base; `remote-bash.test.ts` and extension tool-name contract |
| `ssh_profile list/use/status/clear` over parsed `~/.ssh/config` aliases; persist active defaults in the Pi session branch | profile | in-progress | RED extension integration test pending |
| Host-less `remote_bash` resolves active host/workdir/env; no profile still errors clearly | profile execution | todo | Pending service and tool integration tests |
| `ssh_mux status/stop` handles a target and all known current-session masters through fake-runner control argv | mux controls | todo | Pending mux registry/tool integration tests |
| Keyed best-effort footer shows active target/workdir and mux up/down; clears on profile clear/shutdown | footer lifecycle | todo | Pending lifecycle harness tests |
| Package, core consumer, and repository verification are honestly green | closeout | todo | Pending validation and proof artifacts |
