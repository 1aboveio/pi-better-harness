# Guarded and trusted extension tools for confined subagents

## Status

Accepted. Extends [ADR 0007](0007-trusted-runtime-task-boundary.md) (the task boundary admits only verified tool implementations) and [ADR 0005](0005-sandbox-permission-table.md) (the `/sandbox` table). Issue #351.

## Problem

A confined subagent runs `pi --no-extensions -e <packages>`. Only its bash commands run under the kernel sandbox; the child Pi process itself does not. The task boundary registers read/write/edit/bash on guarded file operations and blocks every other tool. That kept the boundary honest but left confined children without the tools models expect:

- `web_fetch` and `web_search` were blocked even though the default tool list asks for them.
- `apply_patch` (from `@vanillagreen/pi-codex-minimal-tools`) was blocked. It writes files in-process, so admitting it as-is would bypass every file rule. gpt-6 models reach for it constantly and waste calls looking for it.

## Decision

Two kinds of extension tool, chosen by a human in `/sandbox` → Subagents · Tools.

**Guarded tools follow the file rules.** They are harness adapters that go through the same guarded file operations as `write` and `edit`, so Project files, Outside project, Stored credentials and the protected paths govern them exactly. Today there is one: `apply_patch`.

- Same name, `{ input }` schema and Codex patch format as the third-party tool, so models' habits work. The parser and applier are this harness's own.
- Removal (Delete File, and the source of a Move) uses a new guarded remove operation. It checks `evaluateDeleteAccess` on both the resolved target and the entry itself, judged without following its final component (canonical parent plus the literal name), so a link planted in `~/.ssh`, `~/.pi` or a sibling repository is refused even when its target is deletable. It then unlinks inside the kernel-confined file worker. Write levels therefore refuse removal outside the disposable places, as they do for bash. A move is "write the destination, then remove the source", not `rename`.
- The whole patch is validated before anything is written: syntax, the file rules for every target, and every hunk against current content. Each file is then written whole, so none is ever half-patched. Removals run last. If a write fails part-way, applied files are restored where the rules allow, and the error lists what was restored, what could not be, and what was never applied.
- It is a task builtin only when ticked (default on), and it is activated for a child that may `edit` or `write`, or asks for it by name.

**Trusted tools run outside the file rules.** A third-party tool the human ticks is loaded into the child and runs in the child Pi process with that process's access. The page says so, and ticking one is a loosening change: the page names it, and saving it as defaults needs a second Enter. (Ticking originally needed a second Space; that was dropped so a whole package's tools can be ticked in one keystroke.)

- The candidate list comes from what the running Pi has registered (`pi.getAllTools()` with `sourceInfo`), by owning package. Builtins, the guarded names and this harness's own tools are excluded.
- Defaults: `web_fetch` and `web_search` from `@juicesharp/rpiv-web-tools` on; everything else off.
- A ticked tool is admitted only when both its name and its canonical source match: the parent records the package root in the immutable child task policy, and the child's `tool_call` gate admits the tool only if its registered source lies inside that root. An extension file with no package manifest (for example `~/.pi/agent/extensions/foo.ts`) is its own package: that file alone is loaded and admitted, never its directory, which Pi would scan for every extension. Another package registering the same name is refused. The child cannot widen the list.
- Known network tool names are refused while the profile's Network access is Off: `web_fetch`, `web_search`, `firecrawl_scrape`, `firecrawl_extract`, `mcp`, `mcpScript`, `remote_bash`, and any `mcp__*` name. This is a fixed name list, not a network sandbox: a trusted tool under another name that reaches the network is not stopped by it. Tick only tools you trust.
- The parent loads the ticked package (or single file) into the child. `toolExtensions` in `config.json` still picks the package to load, as an override, but only a package the human ticked is admitted. A ticked tool whose package cannot be found is refused at launch with a reason.

The launch line lists both: `Runtime: isolated · guarded apply_patch · trusted web_fetch (@juicesharp/rpiv-web-tools), …`. Refused tools are listed with their reason.

Unconfined children keep whatever the user maps.

## Consequences

- Confined children can fetch the web and apply Codex patches without a hole in the file rules.
- Ticking a trusted tool is a real trust decision: that tool's code can read and write anything the child Pi process can. The page is explicit about it, and the default list is short.
- The settings live in the existing permissions file (`subagentTools`). Files written before this change load the default tool set.
- Admission by package root depends on Pi reporting each tool's source path; a tool registered without one (for example an inline factory) is never admitted as trusted.
