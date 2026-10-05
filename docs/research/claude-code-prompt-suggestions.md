# Claude Code next-prompt suggestions: evidence

Scope: grayed-out next-prompt text, not slash-command, `@` file, or shell completion. Research only; no Pi API mapping, implementation, or product policy. Sources describe the live documentation and public changelog retrieved for this task (changelog head: 2.1.289), not a locally tested binary.

## Verified behavior

| Topic | What the official sources support |
| --- | --- |
| Acceptance | **Tab or Right arrow** places the suggestion in the prompt input; **Enter then submits**. This is a two-step interaction in current docs. [S1] |
| Dismissal | **Start typing** to dismiss. The prompt-suggestions section does not document Escape as a dedicated dismissal key; general Escape behavior is not evidence for that binding. [S1] |
| Startup | A newly opened session shows a grayed-out example command selected from the **project's git history**, reflecting recently worked-on files. This is distinct from post-response suggestions based on **conversation history**. The docs do not specify a startup fallback when git history is absent. [S1] |
| Generation timing | After Claude responds, it **can** suggest a follow-up or workflow continuation. Each next-prompt suggestion uses a **short background request to the same model the session uses**. No debounce interval, exact scheduling point, timeout, or cancellation protocol is documented here. Do not infer Haiku or a separate autocomplete engine from generic background-task model settings. [S1] |
| Cost | The request counts toward plan usage limits or API costs. Docs say it reuses the conversation prompt cache and is mostly cache reads plus a few output tokens, so added cost is small. This is not a fixed token budget or monetary ceiling. [S1] |
| Per-suggestion eligibility | Documented skips include cold prompt cache; after the first turn in **some** sessions; previous response ending in an error; plan mode; near/at usage limit; and teammate sessions by default (the team lead gets suggestions). This list is explicitly non-exhaustive. [S1] |
| Usage override | `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` keeps suggestions on until the limit is reached, including near the limit in 2.1.238+. It is not documented as bypassing an exhausted limit or every other gate. [S1, S3, S5] |
| Adaptive frequency | Leaving many suggestions unused reduces frequency; using one restores normal frequency. The terminal change in 2.1.283 names **20 consecutively unused suggestions**. Docs also name `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` as a way to restore usual frequency. [S1, S5] |
| Noninteractive output | Print mode does not generate suggestions by default. `--prompt-suggestions` requires `--print`, `--output-format stream-json`, and `--verbose`; it emits a `prompt_suggestion` message after each turn that generates one. Very short conversations and cold caches can yield none, including a single short query. [S1, S4] |

## Configuration, defaults, and provider constraints

- `promptSuggestionEnabled` is a Boolean, supported in user, project, local, and managed settings; the settings reference gives its **default as `true`**. `/config`'s Prompt suggestions toggle writes this key. `false` hides suggestions. [S2, S3]
- `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` takes precedence over that key. The env reference accepts standard Boolean forms (`1`/`true`/`yes`/`on`, and their off equivalents, case-insensitive). For organization-wide disabling, interactive docs prescribe both managed `promptSuggestionEnabled: false` and managed `env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false"` to prevent a user's environment override. [S1, S3]
- **Setting default is not effective availability:** interactive docs say sessions without feature-flag fetching default suggestions off and hide the toggle, including third-party providers, Claude apps gateways, and a first install/upgrade session whose flags have not arrived. Settings docs say normal eligibility requires a claude.ai or Console account with telemetry on; on Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or with telemetry off, the settings key has no effect and **only `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` turns them on**. Read the default and this exception together. [S1, S2]
- Feature-flag fetching is disabled by the activating values of `DISABLE_GROWTHBOOK`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; third-party provider sessions normally skip it unless an embedding host sets `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`. Claude apps gateways skip it too. `DISABLE_TELEMETRY` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` activate on **any nonempty value**, even `"false"`; `DO_NOT_TRACK` is a standard Boolean. [S3]
- The explicit env opt-in exception is documented for the providers/telemetry cases above, but its complete interaction with gateway sessions, host-supplied controls, and every flag-fetching disable switch is not specified. Do not generalize it into universal provider support. These pages do not identify suggestion-specific telemetry event names or payloads. [S1-S3]

## Failure evidence and version caveats

**First-party release notes, not guarantees of universal correctness** ([S5]):

- 2.0.70 added Enter-to-accept-and-submit and fixed Tab replacing typed input; 2.1.136 subsequently fixed Enter auto-submitting a suggestion on empty input instead of requiring Tab or arrow. Historical Enter behavior must not override current interactive docs.
- 2.1.49, 2.1.50, and 2.1.62 record prompt-suggestion cache-hit regressions. 2.1.257 fixed advisor-configured sessions re-sending the full conversation uncached for background requests, including suggestions. Cache reuse is documented intent, not an invariant established by this research.
- 2.1.141 fixed suggestions silently disabled by an output style; 2.1.238 fixed the near-limit env override; 2.1.268 fixed SDK suggestions using pre-compaction conversation; 2.1.269 fixed dropping suggestions in languages without spaces and improved Japanese/Chinese/Korean filtering.

**User reports in the official public issue tracker, not independently reproduced or maintainer-confirmed causes:**

- [#29343][S6] (closed as duplicate) reports accidental Enter on partial text leading to allegedly fabricated instructions and an unwanted GitHub issue closure. It supports an input-consent risk report, not a proven current generator/input-buffer mechanism or an established relationship to the empty-input fix.
- [#13878][S7] (closed feature request) reports suggestions disrupting thought flow and asks for an opt-out. Its claim of no opt-out is historical user perception, superseded by current settings documentation and the 2.0.71 `/config` toggle release note.

## Inferences and unresolved questions for the parent

- **Inference:** a similar feature warrants investigation of acceptance/submission separation, preservation of typed drafts, stale results after typing/compaction, multilingual filtering, and cache/cost accounting. These are evidence-derived review topics, not selected Pi behavior or acceptance criteria.
- **Unknown:** exact generator prompt, decoding parameters, output limit, confidence/filter thresholds, retries, cancellation, concurrent requests, latency budget, and exact cache/usage thresholds. The same-session-model statement is verified; engine details beyond it are not.
- **Unknown:** how startup git history is sampled, whether startup examples incur inference cost, and behavior outside git repositories. Conversation history is documented context for follow-ups, not evidence of a filesystem-wide history scan.
- **Unknown:** whether Escape dismisses only ghost text, whether acceptance can be rebound, and suggestion-specific telemetry content. No runtime tests were performed.
- Route Pi repository/API exploration to **Explorer**, UX/default/cost/provider decisions to **Product Manager**, and implementation to **Developer**. The parent owns synthesis into the Pi design.

## Sources

- **S1:** [Interactive mode: Prompt suggestions](https://code.claude.com/docs/en/interactive-mode#prompt-suggestions). Full relevant section and both subsections read: interaction, startup context, model/request timing, cost, gates, opt-out, managed disable, and print mode.
- **S2:** [Settings reference: promptSuggestionEnabled](https://code.claude.com/docs/en/settings-reference#promptsuggestionenabled). Full key entry read, including scope, Boolean/default, env precedence, and provider/telemetry opt-in exception.
- **S3:** [Environment variables](https://code.claude.com/docs/en/env-vars). Relevant variable rows, Boolean semantics, and full feature-flag-fetching/first-session sections read: env override, telemetry opt-out semantics, provider and host exceptions.
- **S4:** [CLI reference](https://code.claude.com/docs/en/cli-reference). `--prompt-suggestions` entry and supporting print/output/verbose entries: opt-in event output and required flags.
- **S5:** [Official public CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) ([retrieved raw text](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)). Relevant entries checked with their version headings: historical behavior and acknowledged fixes, not exposed generator implementation.
- **S6:** [Official tracker issue #29343](https://github.com/anthropics/claude-code/issues/29343). Full issue body read: reporter's accidental-submit claim, macOS CLI environment, duplicate status; not independent confirmation.
- **S7:** [Official tracker issue #13878](https://github.com/anthropics/claude-code/issues/13878). Full issue body read: reported workflow disruption and historical opt-out request; not current configuration authority.

[S6]: https://github.com/anthropics/claude-code/issues/29343
[S7]: https://github.com/anthropics/claude-code/issues/13878
