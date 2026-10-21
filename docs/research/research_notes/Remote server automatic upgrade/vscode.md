# VS Code automatic remote server installation and upgrade: evidence

Research date: **2026-10-21 UTC**. Scope: official documentation, public Microsoft source, and explicitly qualified firsthand issue evidence. No SSH, production operations, credential access, implementation, or commits were performed. Only this research note was written.

## Finding

**Automatic installation and update on connection is documented Remote-SSH behavior.** Manual server staging or a manual restart is not the normal workflow described by Microsoft. However, the sources reviewed do **not** establish a universal Remote-SSH guarantee that an upgrade never interrupts existing connections or jobs, or that failed upgrades automatically roll back. Versioned installation directories establish separate binary locations; they do not establish safe concurrent ownership of an application's mutable state.

The [Remote Development FAQ](https://code.visualstudio.com/docs/remote/faq.md#can-vs-code-server-be-installed-or-used-on-its-own) says the client installs and updates its server automatically when connecting. Its lifecycle section says VS Code starts and stops the server without login or startup scripts. The [SSH connection instructions](https://code.visualstudio.com/docs/remote/ssh.md#connect-to-a-remote-host) describe selecting a host and waiting while VS Code connects and sets itself up.

## Evidence versions and limits

Read first: [existing VS Code lifecycle evidence](../Remote%20server%20lifecycle%20policy/vscode.md) and [existing lifecycle report](../../reports/Remote%20server%20lifecycle%20policy.md). The report's Pi recommendations are not external evidence and are not adopted here.

- **Stable snapshot:** Microsoft's [Linux x64 stable update endpoint](https://update.code.visualstudio.com/api/update/linux-x64/stable/latest) returned version **1.143.0**, commit **`2d0b7506a36c1d6db9a466440131a8e01eab2289`** during this research. The [commit record](https://api.github.com/repos/microsoft/vscode/commits/2d0b7506a36c1d6db9a466440131a8e01eab2289) dates it **2026-10-20T21:31:47Z**. “Stable source” below means public source at that revision, not an audit of the proprietary Remote-SSH extension or every packaged binary.
- **Earlier main snapshot:** the existing note pins **`caf4fe387393f704f7eb94578e48dcff65bf8032`**, dated **2026-10-19T14:29:23Z** by the [commit record](https://api.github.com/repos/microsoft/vscode/commits/caf4fe387393f704f7eb94578e48dcff65bf8032). Two source references below use that revision and are labeled accordingly.
- Official documentation URLs are mutable, retrieved on the research date. The [FAQ](https://code.visualstudio.com/docs/remote/faq.md#why-arent-the-remote-development-extensions-or-their-components-open-source) expressly says the Remote Development extensions and related components are not currently open source. Public server/CLI source must not be presented as the complete Remote-SSH resolver.

## Build identity and current CLI paths

| Claim | Primary evidence | What the evidence supports |
| --- | --- | --- |
| Build compatibility includes commit identity. | [Stable server handshake](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/src/vs/server/node/remoteExtensionHostAgentServer.ts#L351) | When both renderer and server commits are defined, differing commits cause `Client refused: version mismatch`. This is not a broad semver compatibility promise. |
| Downloads can address an exact commit, platform, and quality. | [Main-snapshot update service](https://github.com/microsoft/vscode/blob/caf4fe387393f704f7eb94578e48dcff65bf8032/cli/src/update_service.rs) | `get_download_stream` constructs `/commit:{commit}/{download_segment}/{quality}`. Semantic version resolution returns a commit; CLI, headless server, and web server are distinct target kinds. |
| CLI server installations are versioned by quality and commit. | [Stable paths](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/tunnels/paths.rs), [stable quality names](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/options.rs), [stable launcher paths](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/state.rs) | For launcher root `R`, a stable headless installation is `R/servers/Stable-<commit>/server/`. Its executable is under `server/bin/<product server entrypoint>`, with `log.txt` and `pid.txt` beside `server/`. Web variants add `-web` to the installation folder. |
| Remote-SSH has used the CLI layout under `.vscode-server`. | [Firsthand Remote-SSH issue #11856, 2026-09-14](https://github.com/microsoft/vscode-remote-release/issues/11856) | The reporter identifies VS Code 1.137.0, commit `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`, and `~/.vscode-server/cli/servers/Stable-645f29cc…`, with `remote.SSH.useExecServer` enabled. This is observed product evidence, not a maintainer guarantee for all modes. |
| The Remote-SSH root and standalone CLI default must not be conflated. | [Official remote cleanup documentation](https://code.visualstudio.com/docs/remote/troubleshooting.md#cleaning-up-the-vs-code-server-on-the-remote), [stable launcher paths](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/state.rs), [stable constants](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/constants.rs#L104) | Official SSH docs name `~/.vscode-server` and `~/.vscode-server-insiders`. Public CLI defaults use a build-configured parent directory and accept an explicit root; portable mode also changes it. `.vscode-server/cli` is not a universal standalone CLI default. |

For Remote-SSH using the observed CLI root, the source-derived stable layout is therefore `~/.vscode-server/cli/servers/Stable-<commit>/server/`. Do not rely only on older `~/.vscode-server/bin/<commit>` descriptions. This research does not establish every current resolver mode's bootstrap executable filename, root override behavior, or migration between layouts.

## Download fallback is part of the documented workflow

Both the [FAQ connectivity section](https://code.visualstudio.com/docs/remote/faq.md#what-are-the-connectivity-requirements-for-vs-code-server) and [SSH connectivity section](https://code.visualstudio.com/docs/remote/ssh.md#what-are-the-connectivity-requirements-for-the-vs-code-server-when-it-is-running-on-a-remote-machine-vm-or-container) say Remote-SSH first attempts to download on the remote host, then falls back to downloading locally and transferring remotely. `remote.SSH.localServerDownload` can select always-local or never-local behavior.

The docs list local outbound HTTPS access to `update.code.visualstudio.com` and `vscode.download.prss.microsoft.com`. Thus a remote host unable to download directly does not inherently require manual staging. This is conditional on local download connectivity, SSH access, remote prerequisites, permissions, and available storage. It is not a promise that any failure can be repaired automatically. The cited docs do not specify the current proprietary resolver's exact transfer command, retry count, or archive validation sequence.

## Parallel versions and disruption

**Separate installations are verified; a universal Remote-SSH nondisruption guarantee is not.** Stable CLI paths give different commits different directories and PID/log files. In the [main-snapshot server builder](https://github.com/microsoft/vscode/blob/caf4fe387393f704f7eb94578e48dcff65bf8032/cli/src/tunnels/code_server.rs), running-server lookup and setup operate on the requested version's paths. Those methods do not themselves kill a different version as a prerequisite to installing the requested one. This is a narrow source observation, not proof about all callers or proprietary resolver orchestration.

There is stronger, explicit parallel-version evidence for **`code serve-web`**, a separate product mode. [Stable `serve_web.rs`](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/commands/serve_web.rs#L70) says existing clients continue receiving their version while new clients receive new versions. Its connection manager stores versions by quality and commit and supports multiple concurrent web servers. It also has child-process timeout and termination logic. **Do not attribute this serve-web routing contract to Remote-SSH.**

Neither the reviewed official SSH docs nor the public server files establish that upgrading a client preserves every remote terminal, extension host, subprocess, or background job. A commit mismatch rejects the new connection; it does not itself prove that the old server is killed. Conversely, separate version directories do not prove the old process or its jobs are preserved indefinitely. Exact Remote-SSH old-process retirement, upgrade/reload behavior across windows, and job survival remain unverified.

## Installation cleanup and rollback

The [stable download cache](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/download_cache.rs) provides specific installation mechanics:

- It uses a per-entry file lock and rechecks whether the target already exists.
- It creates a unique staging directory, runs the creation callback, then renames staging to the final directory.
- A drop guard attempts staging cleanup on failure/cancellation. A later attempt, while holding the same entry's lock, removes orphaned staging directories for that entry.
- Existing targets are accepted through the cache's existence check. These mechanics do not establish a complete validation or crash-durability guarantee for every preexisting installation.

The [main-snapshot server builder](https://github.com/microsoft/vscode/blob/caf4fe387393f704f7eb94578e48dcff65bf8032/cli/src/tunnels/code_server.rs) downloads and extracts inside that callback, and normally runs the server entrypoint with `--version` before completion. Its requirements-skip path bypasses that check. This is a limited installation check, not successful application migration or connection proof.

Cleanup has distinct paths:

| Mechanism | Verified behavior | Limit |
| --- | --- | --- |
| [Stable `prune_stopped_servers`](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/tunnels/paths.rs) | Filters installations by absence of a detected running PID before deleting their directory. | Does not establish when Remote-SSH invokes it, or a race-free global lifetime guarantee. |
| [Stable cache `touch`](https://github.com/microsoft/vscode/blob/2d0b7506a36c1d6db9a466440131a8e01eab2289/cli/src/download_cache.rs) | Uses `KEEP_LRU = 5`; when over the threshold, attempts to delete the last entry. | This method has no running-process check. Deletion failure can retain entries. Five is not a guaranteed rollback inventory, and this source does not prove which SSH versions exercise the cache. |
| [Official Remote-SSH uninstall command](https://code.visualstudio.com/docs/remote/troubleshooting.md#cleaning-up-the-vs-code-server-on-the-remote) | Explicitly kills running VS Code Server processes and deletes the installation folder. | This is a documented cleanup operation, not evidence that routine automatic updates do the same. |

No reviewed source promises automatic rollback to a prior server after failed startup, indefinite retention of old binaries, backwards-compatible mutable state, or lossless job migration. Staged installation is not application rollback. The absence of a guarantee in these bounded sources is not proof that no additional proprietary safeguards exist.

## Pi context and handoff boundaries

The task supplies these Pi constraints: the Pi 1.2 client private bridge has an exact SDK dependency; server state requires a sole writer; busy workers must be preserved. These are **supplied project context**, not independently verified repository findings in this note.

The external evidence supports describing automatic remote installation/update as normal VS Code behavior. It does not choose Pi's compatibility key, admission behavior while busy, handoff timing, state migration, cleanup retention, or rollback policy. It also does not justify calling VS Code stateless: the cited server has live connection/process state, and the docs describe remote extension storage. Separate editor-server binaries are not evidence that two Pi daemons can safely write the same session index.

Repository verification belongs to **Explorer**; Pi policy decisions belong to **Product Manager and the user**; implementation belongs to **Developer**. No Pi policy or implementation is proposed here. The existing report's manual-bootstrap guidance should not be cited as a description of normal VS Code installation, though failures can still require troubleshooting.
