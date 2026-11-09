# Proposed remote server lifecycle requirements

Status: product proposal for confirmation, not an approved policy or implementation plan.

## Purpose and evidence

Agree on observable remote lifecycle behavior before technical design. The user reports that a daemon dead after reboot can leave a stale socket and produce "connection closed". This is the supplied problem statement, not an independently verified diagnosis.

The sole factual source is the user brief for this task. No external research, execution-path inspection, or code changes underpin this note. Existing UX and constraints below are supplied by that brief. Writing follows bundled PRD guidance adapted to a requirements note; no applicable WRITING.md was found.

## Explicit human requirements

The user's exact lifecycle request is:

> if the remote server daemon is not started, it should start on the first attempt to connect. the server daemon remains active if there is at least 1 active session. and session should have a default 24-hour / configurable expire window if no new activity. daemon auto close in default30mins / configurable when no active session

| ID | Explicit requirement |
| --- | --- |
| H1 | A first connection attempt starts the remote daemon when it is not running. |
| H2 | The daemon remains running while at least 1 active session exists. The meaning of active needs confirmation. |
| H3 | A session expires after a default 24 hours without new activity. The window is configurable. Activity and expiry effects need confirmation. |
| H4 | With no active sessions, the daemon automatically shuts down after a default 30 minutes. The window is configurable. Its starting point needs confirmation. |
| H5 | Preserve the active/closed session browser, attach/reopen, close, and rename workflows. The UI remains native and local; execution remains remote. |
| H6 | Disconnecting must not abort remote work. Durable session transcripts must be preserved. |

H1-H6 are the supplied requirements. Everything labeled P or D below is a recommendation or open product decision, not an additional approved requirement. No existing behavior beyond the brief is asserted.

## Proposed lifecycle semantics

All P rules are conditional on human confirmation. They describe outcomes, not code boundaries or mechanisms.

### P1. Active means open, not connected

An active session is an open, non-expired session, including one with no attached client. A closed session is a retained history entry, not a deleted transcript. Transport connectivity is a separate state: connected, disconnected, or reconnecting must not itself change active/closed status.

An open session waiting for a reply or approval remains active until it expires. A connected but idle client does not prevent expiration. The browser continues to distinguish active and closed sessions; temporary connection failure must not falsely present active sessions as closed.

Reason: treating disconnection as closure would conflict with H6 and make remote continuation unreliable.

### P2. Count meaningful session activity, not transport traffic

| Event | Proposed inactivity effect |
| --- | --- |
| Successful session creation or explicit reopen | Start a new inactivity window. |
| Explicit successful attach to an open session, including deliberate return after disconnection | Reset the window. |
| Accepted user message, instruction, cancellation, approval, denial, or other response in that session | Reset the window. A rejected request does not count. |
| Model or tool execution owned by the session | Protect the session as specified in P3, regardless of output frequency. |
| Completion, failure, or cancellation of the last owned execution | Start a full new inactivity window under P3. |
| Entering a waiting-for-input or waiting-for-approval state after execution yields | Start the waiting inactivity window. Waiting itself does not refresh it. |
| Automatic reconnect, connection maintenance, heartbeat, status poll, transcript replay, or duplicate event delivery | Do not reset the window. |
| Passive session-list or history viewing, reading or scrolling an already attached transcript, rename, or an idle connected client | Do not reset the window. |

Explicit attach is a deliberate user action, not an automatic reconnect renamed as attach. Changing the name preserves the session's deadline. These distinctions avoid accidental indefinite retention from an open browser or transport maintenance.

### P3. Do not expire executing work merely because it is silent

A session with in-flight model or tool work cannot expire due to inactivity, even if no output arrives for more than 24 hours. When its last owned execution settles or yields to user input, a full inactivity window begins. This is an exemption from inactivity expiration, not a new execution timeout or a promise that interrupted processes survive host reboot.

Waiting for user input or approval is not executing work. Its clock runs while waiting, whether the client is connected or not. At expiry the session closes and any outstanding approval ceases to authorize execution. Reopen must require a fresh decision before any pending approval-dependent action executes.

For background work, recommend that work launched on behalf of a session retains that session as its lifecycle owner until it finishes, fails, or is explicitly cancelled. Returning from the foreground tool call or disconnecting the client does not end that ownership. Such background work receives the same protection as foreground work. Its completion starts a fresh inactivity window when no other owned work remains.

This recommendation can keep a daemon alive indefinitely for never-ending work. No background execution limit is proposed. Whether deliberately independent work exists, who owns it, and what guarantees it has are unresolved facts and decisions; this note does not grant the daemon permission to abandon it.

### P4. Expiration closes the session, not its history

At the inactivity deadline, close an eligible session and show it in closed history with an expiration reason. Preserve its durable transcript and name. Expiration and daemon idle shutdown never delete history and do not define a retention or deletion policy.

Reopen is explicit, retains the session identity and transcript, and starts a fresh inactivity window. Reopen does not replay old prompts, rerun completed tools, or automatically grant expired approvals. Creating a new session remains distinct from reopening one.

Recommend that manual close is allowed immediately when no owned execution is running. If execution is running, do not silently cancel it or hide it in a closed session: leave the session active and explain that work is still running. A separate deliberate cancellation may precede close. This manual-close rule is an open choice, not supplied policy.

### P5. Persist inactivity meaning across restarts

For an open, non-executing session, preserve its last qualifying activity and deadline across daemon or host restarts. Elapsed real time while offline counts toward inactivity; restarting does not renew the session. On return, an overdue eligible session is closed before it can accept further work; the user may explicitly reopen it.

Do not treat a pre-restart "running" label as proof that work still runs, or assume that loss of the connection ended it. Where execution status cannot yet be established, show that uncertainty and do not report successful completion or cancel work merely to satisfy expiration. Once established, genuinely ongoing work follows P3. For work established as interrupted, recommend a fresh inactivity window from that determination so the user can inspect the failure; do not auto-resume it.

No host-reboot execution-survival guarantee is added. Technical handling of time corrections and recovery must preserve these outcomes without silently granting a new window on every restart.

### P6. Use one continuous zero-session idle window

The daemon idle clock starts when a usable daemon first has zero active sessions. This includes initial startup with no sessions, not only a transition from 1 to 0. If startup restores active sessions, the zero-session clock does not run.

When the last active session closes or expires, start the idle clock. Creating or reopening an active session cancels it. A later transition to zero starts a full new window. Multiple sessions count independently: closing one must not start shutdown while another remains active.

A connection, passive browser view, or heartbeat without an active session neither blocks nor renews idle shutdown. After the zero-session window elapses, stop the daemon without changing closed history. Recommend starting a fresh zero-session window after a later daemon restart: this is a new daemon availability period, unlike persisted session inactivity deadlines.

### P7. Start on demand with visible recovery and bounded failure

A deliberate connect attempt starts an absent daemon and proceeds to the requested operation once it is usable. A stale endpoint must not require manual cleanup or produce only an unexplained "connection closed" when startup can recover it. Do not treat endpoint presence alone as successful connection.

While startup or restoration is underway, show a truthful in-progress state. On failure, show an actionable error distinguishing what is known, such as remote access failure, authorization failure, startup failure, or unconfirmed readiness. Preserve the intended target session for a deliberate retry; never claim execution or attachment succeeded when it did not.

Recommend a bounded attempt that ends in success or an explicit failure with retry available. No startup deadline, retry count, or latency target is specified here. Those limits require a proposal and confirmation, not an invented numeric SLA.

After intentional idle shutdown or an explicit user shutdown, an attached but idle UI must not immediately restart the daemon through an eager reconnect loop. Remain visibly disconnected or stopped until a deliberate operation needs the remote daemon. Opening the remote browser, connecting, creating, attaching, or reopening are recommended examples of such deliberate demand; passive refresh is not. Unexpected connection loss may have separate reconnect behavior, but cannot abort remote work or erase the distinction from intentional shutdown.

### P8. Resolve overlapping requests without losing accepted work

Concurrent first-connect attempts must converge on one usable daemon service for the same remote target. Each caller receives success or an accurate error; concurrency must not create duplicate user sessions or duplicate execution as a side effect of retry.

When last-session closure or idle shutdown overlaps a create, reopen, attach, or accepted activity request, preserve the same lifecycle rules. If an operation is accepted, do not shut down underneath its active session or silently lose it. Otherwise report failure or continue through on-demand startup, without claiming acceptance. If activity is accepted before expiry closes a session, refresh its deadline. If closure wins first, require explicit reopen before new execution. Do not implicitly reopen a session because a poll or late event arrived.

## The two configuration defaults

| Product setting description, not a config key | Required default | Proposed meaning |
| --- | --- | --- |
| Session inactivity expiration window | 24 hours | Per-session period under P2-P5. It is not maximum session age or an execution timeout. |
| Daemon zero-active-session idle shutdown window | 30 minutes | Continuous zero-session period under P6. It is not a client-disconnect timeout. |

These are independent configurable durations. Do not assign undocumented existing configuration names, storage locations, or UI controls. Recommend accepting positive finite durations and rejecting invalid values with an explicit error rather than silently changing them. Zero, disabling, configuration scope, precedence between settings sources, and changes to already running clocks are not specified by the user. Recommend applying configuration changes prospectively to newly started windows unless the human chooses immediate recalculation. Architect should propose the configuration contract after these product choices are confirmed.

## Acceptance cases

H cases enforce the brief. P cases are proposed acceptance criteria and become binding only when the corresponding proposals are confirmed. Duration boundaries use the effective configured duration, not assumed scheduler precision; an operation at the boundary follows P8.

| Case | Given / when | Observable result | Basis |
| --- | --- | --- | --- |
| A1 | Daemon absent; user deliberately connects. Repeat with the reported post-reboot stale-endpoint condition. | Start and complete the requested connection when recovery succeeds; no manual daemon launch or endpoint cleanup is required. | H1; P7 recovery |
| A2 | Several clients make the first connection concurrently. | One usable service; no duplicate session or execution from retry; each client receives a truthful outcome. | P8 |
| A3 | Startup is slow or fails. | Progress while pending, then success or actionable failure; target is retained for deliberate retry, with no false success. | P7 |
| A4 | At least 1 open session remains; all clients disconnect. | Daemon remains available and remote execution continues. Disconnect does not close the session. | H2, H6; P1 |
| A5 | An eligible session has no qualifying activity for 24 hours, including with a connected idle client. | It closes as expired, preserves history, and can be explicitly reopened. Just before the deadline it remains open. | H3, H6; P1, P4 |
| A6 | Polls, heartbeats, passive reads, automatic reconnects, and rename occur throughout inactivity. | Original deadline does not move. Explicit attach or an accepted message before expiry moves it by a full window. | P2 |
| A7 | Model or tool work runs silently longer than 24 hours after disconnection. | No inactivity cancellation or expiration; completion starts a fresh inactivity window. | H6; P3 |
| A8 | Foreground call returns while session-owned background work continues. | Session stays active and daemon stays running; the last owned work settling starts the new window. | P3 |
| A9 | Session waits for approval or input without a response for a full window. | Session expires. Reopen preserves context but cannot execute on the expired approval without a fresh decision. | P3, P4 |
| A10 | An idle open session has 1 hour left; restart consumes 2 hours with no activity. | On return it is closed as overdue, not granted a new 24 hours. Uncertain execution status is shown as uncertain. | P5 |
| A11 | Daemon first becomes usable with zero sessions, or its last active session closes. | Shutdown occurs after a continuous default 30 minutes with zero active sessions in either case. | H4; P6 |
| A12 | A session is created or reopened before idle shutdown; later the last session closes. | Pending idle shutdown is cancelled, then a full new idle window begins at the later zero-session transition. | P6 |
| A13 | Only closed history and a connected session browser remain. | Daemon can idle-shut down; history survives; passive reconnect does not restart it. A deliberate remote operation can start it again. | H1, H4, H6; P6, P7 |
| A14 | Close one of two active sessions, then close the last one. | First close does not start shutdown. Last close starts the idle window. Repeated close does not renew it. | H2; P6 |
| A15 | User closes a session while owned work is running. | Proposed behavior: close is declined with a clear running-work reason, without cancellation or loss of visibility. | P4, open D3 |
| A16 | Expiration or final-close/shutdown overlaps accepted activity, create, reopen, or attach. | Accepted work is not lost or killed; otherwise caller sees a truthful retry/reopen outcome. No implicit revival from late traffic. | P8 |
| A17 | Configure the inactivity and idle windows to different supported positive durations. | Each boundary changes independently; long-running work protections still hold. Invalid values are reported, not silently accepted. | H3, H4; configuration proposal |
| A18 | Reopen an expired session after daemon shutdown. | Start on demand, preserve identity, name, and transcript, start a new inactivity window, and do not replay prior work. | H1, H5, H6; P4 |

## Explicit choices to confirm

All decisions below are open and owned by the human requesting this policy. Recommendations must not be treated as approvals.

| Decision | Recommended choice | Consequence or alternative requiring a decision |
| --- | --- | --- |
| D1: Active and activity | Adopt P1-P2: open sessions count; deliberate attach refreshes; rename, passive viewing, automatic reconnect, and transport traffic do not. | Decide especially whether attach should refresh at all and whether rename should count. |
| D2: Silent and background execution | Adopt P3 protection and ownership until work settles; start a full window afterward. | Accept potentially indefinite daemon lifetime for ongoing work. Independent background work needs a separate explicit policy if it exists. |
| D3: Waiting and manual close | Let waiting sessions expire; require fresh approval after expiry; decline close while work runs. | An alternative close-and-cancel or close-with-work-continuing behavior needs explicit human approval. |
| D4: Expiry and recovery | Close, retain history, and reopen explicitly without replay; preserve idle session deadlines across restarts under P4-P5. | Confirm the proposed new window after execution is established as interrupted; host reboot is not a work-survival guarantee. |
| D5: Zero-session daemon | Count initial zero-session startup and later zero transitions alike; restart the idle window for each daemon availability period. | Confirm that a connected passive browser does not keep an empty daemon alive. |
| D6: Intentional shutdown and startup failure | Require fresh deliberate demand after intentional shutdown; show progress and bounded errors under P7. | Exact startup limits remain unchosen. Confirm which deliberate browser actions constitute demand. |
| D7: Configuration contract | Keep independent defaults of 24 hours and 30 minutes; accept positive finite durations; apply changes to future windows. | Confirm scope and precedence, whether zero or disable is allowed, and whether changes recalculate existing deadlines. No keys are selected. |
| D8: Overlapping lifecycle requests | Adopt P8: accepted work is protected; otherwise explicit failure or on-demand recovery. | Technical ordering is Architect's decision, but the observable acceptance outcome must hold. |

## Handoff, not an implementation plan

Architect owns technical design after confirmation, including recovery, concurrency, timing guarantees, and the configuration contract. This note chooses no modules, interfaces, process controls, or code boundaries.

Developer owns implementation and verification against approved H requirements and confirmed P cases. No implementation is requested in this task.

Researcher owns evidence for unresolved factual claims, including actual background-work ownership, restart recovery capabilities, and available configuration surfaces. Existing parallel VS Code fact research and codebase research are not duplicated here. Findings may inform the decisions above but do not approve product policy on the human's behalf.
