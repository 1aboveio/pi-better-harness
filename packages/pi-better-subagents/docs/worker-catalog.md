# Shared worker catalog

Skills request roles; the harness catalog owns their instructions, preferred
models, and effort. Skills must not turn a model recommendation into an explicit
launch override. This interface plans workers; it does not launch them.

`pi-agent-catalog [resolve-workers]` reads one JSON request from stdin and emits
one JSON plan. Install the harness or subagents npm package to expose the binary,
or run its `agent-catalog.mjs` directly. No Pi session, credentials, provider
discovery, extensions, or network connection is needed. The CLI uses the packaged
`tsx` loader; the portable TypeScript API is `pi-better-subagents/catalog`.

## Request

```json
{
  "version": 1,
  "harness": "codex",
  "cwd": "/workspace/project",
  "projectTrusted": false,
  "available": [
    {
      "model": "openai/gpt-6.1-sol",
      "nativeModel": "gpt-6.1-sol",
      "supportedEfforts": ["low", "medium", "high"]
    },
    {
      "model": "openai/gpt-6-luna",
      "nativeModel": "gpt-6-luna",
      "supportedEfforts": ["low", "medium", "high"]
    },
    {
      "model": "openai/gpt-6-astra",
      "nativeModel": "gpt-6-astra",
      "supportedEfforts": ["low", "medium", "high"]
    }
  ],
  "launchCapabilities": {
    "model": true,
    "effort": true,
    "instructions": true
  },
  "hostPreferences": {
    "developer": {"model": "openai/gpt-6.1-sol", "effort": "high"}
  }
}
```

This is an example shape, not evidence that these models or controls are available
in any Codex installation. The caller supplies capabilities from its current host.
Do not copy an availability list from Pi, infer supported effort from a model name,
or treat a configured model as available without runtime evidence. A native model
name maps to exactly one canonical `provider/model`; ambiguous mappings fail.

The catalog still uses project > personal > bundled definitions. Personal storage
is `userRoot`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent`, shared across hosts.
The CLI never scans `.codex/agents` or writes user configuration. Project catalog
files contribute only when `projectTrusted` is explicitly true. Host preferences
are supplied configuration, not another copied catalog or a write to a role.

Optional `overrides` selects `implementer`, `explorer`, `diagnoser`, or `reviewer`:

```json
{"overrides": {"implementer": {"model": "deepseek/deepseek-flash@max"}}}
```

Model and effort resolve independently: task override > host preference > catalog
default. A model-only override keeps the resolved effort. Unsupported explicit
model/effort choices block; inherited effort can use the catalog's documented
nearest-level adjustment. Pi retains its existing tier/foreground fallback policy.
Codex and Claude Code require an explicit configured `tiers` policy or
`fallbackToForeground: true` to permit those default-model substitutions. An
explicit task or host model is never silently substituted.

## Plan And Execution

The plan maps implementer and diagnoser to Developer, explorer to Explorer, and
reviewer to Reviewer. Every worker reports `role`, `model`, `nativeModel`, `effort`,
`instructions`, `selection`, `catalogDigest`, `diagnostics`,
and `launch`. All four use the same immutable catalog snapshot. A reviewer that
resolves to the implementer's model blocks preflight; the skill must not invent
another model to make the check pass.

- **Pi:** `launch` is `{role: "developer"}` by default. Only explicit task or host
  model/effort choices add `model` or `thinking`. The coordinator adds its task
  prompt, alias, workspace, and authorized controls to the existing spawn tool.
  Live Pi launch resolution remains authoritative, including branch-local session
  preferences that an out-of-process CLI cannot read. Record the actual launch
  provenance, not just the preflight prediction.
- **Codex / Claude Code:** `launch` contains the verified native `model`, `effort`,
  and resolved role `instructions`. The adapter uses actual launch/configuration
  controls supported by its current surface and appends the task instructions.
  If the surface cannot apply a required field, do not launch. Saying a model name
  in a worker prompt is not model selection. This API is a plan, not a claim that
  every native `spawn_agent` surface supports per-call model or effort fields.

The catalog grants no sandbox, tool, filesystem, credential, or delegation
permissions. Existing host launch controls still apply.

On a blocked plan, `ok` is false and **every** `launch` is null. A model recorded
in an unsuccessful decision is diagnostic evidence, not launch authorization.
The CLI returns status 0 for a valid plan, including a blocked plan, and status 2
for malformed input or an invocation error. Consumers must check `ok`, not just
the process exit status. No automatic retry, install, or post-start substitution
is performed.

## Modules

- `catalog-schema.ts`, `catalog-store.ts`, `catalog-resolver.ts`: existing shared
  definitions and live inheritance, unchanged storage format.
- `model-resolution-core.ts`: portable availability and effort resolution, with
  host-provided supported effort levels or an injected effort-support function.
- `model-resolution.ts`: Pi wrapper, supplying `getSupportedThinkingLevels` from
  Pi's registry. Existing Pi callers retain their API and semantics.
- `worker-catalog.ts`: workflow slots, host adaptation, independence, and a single
  batch snapshot. It does not import a Pi SDK.