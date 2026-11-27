#!/usr/bin/env node
// Print the coordination a resolve-issues run owes right now, from its saved state, so the
// main agent never has to remember follow-on steps.
//
//   next-actions.mjs --run <run dir> [--capacity-json '<snapshot>' | --slots N] [--quiet-minutes 45] [--resume] [--sync] [--json] [--peek] [--mode full|narrow|off] [--rules] [--exit-due]
//
// Reads <run>/task-plan.json (units with status, stage, worker, workerSince, workspace,
// dependsOn, pr, headSha, reviewedHead) and <run>/reviews/<unit>-r<N>.json (+ .fix.json; its head, complete, and
// external.awaiting, and whether it holds a P0/P1). A unit with `worker`
// set is busy. Actions, in priority order:
//
//   add-unit, drop-unit, set-deps, move-link, blocked-outside, cycle
//                   the plan differs from the spec's GitHub issue tree (plan-sync.mjs): apply
//                   it through update_plan. --resume and --sync fetch the tree (one GraphQL
//                   query) and save it; every other call diffs the saved tree, with no
//                   GitHub call. Sync after the run files an issue
//   unblock         a unit marked blocked without a reason from BLOCK_REASONS
//                   (`blockedReason`), or human-decision without `humanItem` (1-5) and
//                   `humanNeed`: reopen it now; and on --resume, every blocked unit:
//                   reopen it with fresh limits; its next step follows. A note never keeps a
//                   unit blocked. A complete review at the unit's HEAD that holds a P0/P1 but
//                   wrote no fix brief and awaits no GitHub reviewer (a handback) gets a
//                   fresh full round, so review-verdict hands it back again only if its
//                   finding recurs
//   worker-kind     a unit's recorded worker has no `workerKind`, or one outside WORKER_KINDS
//                   (implement, fix, review): record it, or stop that worker and put its
//                   question in the unit's next implementer or fix brief. Exploration is the
//                   fleet's one explorer, never a unit's worker
//   decide          a unit has a question no `decisions` entry answers yet (its `answers`
//                   names the question's file): a worker result's `decisionNeeded`
//                   (<run>/results/*.json), or review-verdict's decide file at the unit's
//                   HEAD. The unit takes no other step until it is answered: both skills take
//                   the automatic answer, blocked or not, and `finish` waits for it (never
//                   block on the human)
//   split           (rush-issues runs only) a unit the size check held (`sizeCheck.verdict`
//                   stop, no `runWhole`) whose code is not done: file its drafted split, or
//                   draft one and file it, then --sync. Rush never defers a unit for size, so a blocked
//                   one is not settled and `finish` waits; text in an issue or the plan never
//                   overrides this. resolve-issues hands held units back instead
//   check-worker    a worker has run past --quiet-minutes and its workspace has changed no file
//                   for that long: inspect its output; if it is stuck, stop it and resume the
//                   unit in its kept workspace (expire.md). Silence is a failure, not progress
//   review-verdict  a review of the current HEAD is written but its verdict is not recorded
//   start-fix       the verdict wrote a fix brief for the current HEAD; give it to a worker
//   carry           review passed on an earlier HEAD and the PR moved since (a CI fix or a base
//                   update): write the carry record, no reviewer; its verdict follows
//   start-review    the PR's current HEAD has no review yet; from round 2, pick its tier
//                   first: a skip writes the record and needs no reviewer. A reopened
//                   handback reviews the same HEAD again, full
//   restack         (`chain` mode) an open PR carries the commits of a chain parent that is now
//                   blocked or cancelled: rebase it onto the target without them. Also a PR that
//                   passed review while a shared-file ancestor (not a dependency) holds an open
//                   P0/P1, or has not passed MOVE_OFF_MINUTES after it: move it off that ancestor
//   deliver         review passed on the current HEAD: watch CI, then mark ready and merge (through
//                   the queue when there is one)
//                   (or hand back in supervised mode); set succeeded when it lands. In `chain`
//                   mode, one deliver per line: enqueue only its deepest PR whose whole line
//                   passed review; that merge lands the line
//   open-pr         the unit has pushed commits (headSha) or its code is done, the parents allow it,
//                   and no PR is open. In `chain` mode the
//                   detail names its chain parent: the open run PR it shares files with (`files`)
//   resume          in flight with no worker and code not done: resume it in its workspace
//   fill-slot       a pending unit whose dependencies are met
//   retry-blocked   everything else is settled and a unit blocked on a cause that can clear by
//                   itself (retry-*, timeout-task, spawn-death, external-blocker) is due its next automatic attempt
//                   (30m, 2h, 8h after blockedAt): set it in-flight, autoRetries + 1
//   wait            the same, but no attempt is due yet: keep a heartbeat, never finish
//   finish          every unit is delivered, blocked, cancelled, or not started behind one of
//                   those (named in the detail, with units built whose PR cannot open because a
//                   parent will not land): write the handoff. For a
//                   GitHub spec it needs a fetch in the same call: without --sync, or when the
//                   fetch failed, it prints `sync` instead. A run never finishes on a tree it
//                   could not read
//
// Text output ends with one short line pointing to the skill path. With --resume or --rules it
// ends with RULES instead, the rules a compaction summary most often drops (in narrow and off
// modes, a one-line rules reminder for that mode).
//
// Only this script decides that the run is finished. End a turn only when it prints nothing
// due, or `finish`. Each due action records when it was first printed (<run>/next-actions-seen.json;
// --peek reads without recording), and a repeat says how long it has gone undone.
//
// `blocked` means a unit itself is stopped, and its `blockedReason` says why, from
// BLOCK_REASONS: a failure out of progress, a cause outside the run (external-blocker), a human-only
// decision, a review handback, or (not in rush runs) a size hold. Any other block is reopened. A unit that only waits on another unit is
// not started: it stays `pending`, never `blocked`. A pending
// unit behind a parent that will not finish this run (blocked, cancelled, or `excluded`) gets no
// action and counts as settled, so `finish` names it as not started and what it waits on.
//
// Actions that need a worker (start-fix, start-review, resume, fill-slot) are limited to the
// free slots. A unit starts when its `dependsOn` parents' code is done, in every delivery mode;
// in `wait` mode its PR opens once they merge. A `stacksOn` parent (a shared surface) orders
// only the PR, and only in `stack` and `chain` mode; in `wait` mode PRs merge in the order they
// are ready. `chain` mode (no stacked CI, but the merge keeps commits): a PR opens on the target
// as soon as its parents' PRs are open, carrying its chain parent's commits. Pass --resume on the first call of
// a new invocation of an existing run.
//
// Exit code: 0 whenever the script ran and answered, whatever is due (including `finish` and
// `wait`); 2 when it could not (bad arguments, unreadable plan). Due or not is in the output:
// the text lines, and `exitDue` in --json. --exit-due restores the old exit 1 when anything is due,
// for a caller that branches on it.
//
// Capacity is optional. Without --capacity-json and --slots, every worker-needing action is due,
// each noted as needing a free worker slot (the harness spawn limit governs). With either flag,
// worker-needing actions are limited to the free slots, as before.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule } from '../../engineering-runtime/scripts/main-module.mjs'
import { excludedIds, syncRun } from './plan-sync.mjs'
import { BLOCKING } from './review-verdict.mjs'

// No skill-owned concurrency default: the caller supplies fresh host capacity.
// The only workers a unit runs (SKILL.md, Your role). A watcher is not a worker.
export const WORKER_KINDS = Object.freeze(['implement', 'fix', 'review'])
export const SKILL_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'SKILL.md')
// Printed after every text call, and by rehydrate.mjs after a compaction.
export const RULES = 'Per unit, run only implement, fix, and review workers, recorded as workerKind: no planning, architecture, product, or setup workers. Exploration continues the run\'s one explorer, on the fleet explore row. You coordinate: never edit product code. In full mode take every step from next-actions.mjs; in every mode the run ends only when it reports done. A HEAD after a passing review is carried; any other new HEAD takes the tier rereview-scope.mjs picks, never yours. Decide before you defer: a question a worker or review raises is answered and recorded, then the unit continues; retrying or deferring never answers it. Never block on the human: take the automatic answer and keep going. Fix the root cause, never only its symptom. Before each scheduling pass, refresh subagent_settings and pass its snapshot with --capacity-json; do not reuse a run-start budget or subtract workflow workers again.'
export const DEFAULT_QUIET_MINUTES = 45
// The reasons a unit may stay blocked (expire.md#reason-codes). Waiting on another unit, an
// infrastructure or external blocker (a tree issue the unit waits on), and a size hold in a rush
// run (split instead) are not among them.
export const BLOCK_REASONS = Object.freeze(['retry-explore', 'retry-implement', 'retry-review', 'retry-ci', 'timeout-task', 'spawn-death', 'external-blocker', 'human-decision', 'review-handback', 'size-hold'])
// An undone action says how long it has been printed once it is this old.
export const UNDONE_NOTE_MINUTES = 10
// expire.md#human-only: a human-decision block names its item (1-5) and what the human must do.
// Without them the deferral is the run's own work (pi 01a147fb deferred #1747 for a refused tool).
export const HUMAN_ITEMS = Object.freeze([1, 2, 3, 4, 5])
export const namesHumanItem = (u) => HUMAN_ITEMS.includes(u.humanItem) && typeof u.humanNeed === 'string' && u.humanNeed.trim() !== ''
// A PR that passed review waits this long on a shared-file chain ancestor still in review, then moves off it.
// Replay (skyee-ai-risk, fmm-express, wiki-kb, pi-better-harness): without it, wiki-kb's chained PRs waited 872
// minutes in all behind slow reviews, more than wait mode's 534; with it, 281.
export const MOVE_OFF_MINUTES = 30
const WAITS_ON_OTHERS = new Set(['deliver', 'check-worker'])
const TERMINAL = new Set(['succeeded', 'blocked', 'cancelled'])
// How much the text output prescribes; JSON output is the same in every mode.
export const SCHEDULER_MODES = Object.freeze(['full', 'narrow', 'off'])
// Blocks that can clear without a human, and the minutes before each automatic fresh attempt.
const AUTO_RETRY = new Set(['retry-ci', 'timeout-task', 'spawn-death', 'external-blocker'])
const AUTO_RETRY_GAPS_MIN = [30, 120, 480]
const NEEDS_SLOT = new Set(['restack', 'start-fix', 'start-review', 'resume', 'fill-slot'])

export class NextActionsError extends Error {}

export function normalizeCapacity(input) {
  if (input === undefined || input === null) return { source: 'none' }
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) throw new NextActionsError('--slots must be a nonnegative safe integer')
    return { source: 'explicit', slots: input }
  }
  const fields = ['maxConcurrent', 'runningCount', 'pendingCount', 'occupiedSlots', 'availableSlots']
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      fields.some(key => !Number.isSafeInteger(input[key]) || input[key] < 0) || input.maxConcurrent < 1) {
    throw new NextActionsError('capacity requires a fresh Harness snapshot with maxConcurrent, runningCount, pendingCount, occupiedSlots, and availableSlots; or an explicit --slots budget')
  }
  const occupied = input.runningCount + input.pendingCount
  if (!Number.isSafeInteger(occupied) || input.occupiedSlots !== occupied ||
      input.availableSlots !== Math.max(0, input.maxConcurrent - occupied)) {
    throw new NextActionsError('inconsistent Harness capacity: occupiedSlots must equal runningCount + pendingCount, and availableSlots must equal max(0, maxConcurrent - occupiedSlots)')
  }
  if (input.revision !== undefined && (typeof input.revision !== 'string' || !input.revision.trim())) {
    throw new NextActionsError('capacity revision must be a nonempty string when supplied')
  }
  return { source: 'harness', ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...Object.fromEntries(fields.map(key => [key, input[key]])) }
}

const hasWorker = (u) => u.worker !== undefined && u.worker !== null && u.worker !== ''
const codeDone = (u) => u.stage === 'done'

// Pure decision from the plan and each unit's newest review round.
// `capacity`: a fresh Harness snapshot, or an explicitly reconciled total workflow budget.
// Snapshot availableSlots is already net of all running and reserved workers.
// `reviews`: { [unitId]: { round, at, head, fix, complete, awaiting, blocking } } for the newest round
// (`at`: when its file was written, ms).
// `resume`: this is the first call of a new invocation, so earlier blocks get a fresh attempt.
// `now` (ms) and `activity` ({ [unitId]: newest workspace change, ms }) find silent workers;
// without `now`, no worker is checked. `sync` is plan-sync.mjs's result for this call, or
// null when the spec is not a GitHub issue tree.
// `seen` ({ "<action>:<unit>": ms }) is when each action was first printed; the result's `seen`
// is the map to save for the next call.
// `questions` ({ [unitId]: [{ key, ask }] }, from readQuestions) are the workers' open questions;
// `key` is the result file, relative to the run, that a `decisions` entry's `answers` names.
export function nextActions(plan, reviews = {}, capacity, { resume = false, now, activity = {}, quietMinutes = DEFAULT_QUIET_MINUTES, sync = null, seen = {}, questions = {} } = {}) {
  const effectiveCapacity = normalizeCapacity(capacity)
  const saved = (Array.isArray(plan?.units) ? plan.units : plan?.issues) ?? []
  if (!Array.isArray(saved) || saved.length === 0) throw new NextActionsError('task plan has no units')
  const excluded = excludedIds(plan)
  const gates = (u) => (u.dependsOn ?? []).map(String).filter((d) => excluded.has(d))
  // In a rush run, a size-held unit is split, never deferred: it gets `split` until the sync
  // drops it (split into sub-issues) or a rerun size check clears it.
  const shortcut = plan.skill === 'rush-issues'
  const sizeHeld = (u) => shortcut && (u.sizeCheck?.verdict ?? u.sizeCheck?.scope) === 'stop' && u.sizeCheck?.runWhole !== true && !codeDone(u)
    && !hasWorker(u) && u.status !== 'succeeded' && u.status !== 'cancelled' && gates(u).length === 0
    && !excluded.has(String(u.id))
  const reasonOk = (u) => BLOCK_REASONS.includes(u.blockedReason) && !(shortcut && u.blockedReason === 'size-hold')
    && (u.blockedReason !== 'human-decision' || namesHumanItem(u))
  const reopen = (u) => (resume || !reasonOk(u)) && u.status === 'blocked' && !hasWorker(u) && gates(u).length === 0 && !sizeHeld(u)
  // `stack` and `chain` both open a child's PR once its parents' PRs are open; only the PR base differs.
  if (plan.deliveryMode !== undefined && !['stack', 'chain', 'wait'].includes(plan.deliveryMode)) throw new NextActionsError(`deliveryMode must be stack, chain, or wait: ${JSON.stringify(plan.deliveryMode)}`)
  const chain = plan.deliveryMode === 'chain'
  // `stack` and `chain` share the line logic: parents from shared files, parentHead, offLine, move-off,
  // and one delivery per line. They differ only in the PR base and how a line is enqueued.
  const linked = plan.deliveryMode !== 'wait'
  const stack = plan.deliveryMode !== 'wait'
  const savedById = new Map(saved.map((u) => [String(u.id), u]))
  const parentDone = (p) => codeDone(p) || p.status === 'succeeded'
  // A unit wrongly marked blocked while it only waited on its parents reopens as not started.
  // Its kept workspace and commits stay; it resumes there once its parents' code is done.
  const unmetParents = (u) => (u.dependsOn ?? []).map(String).filter((d) => { const p = savedById.get(d); return p && !parentDone(p) })
  const reopenAs = (u) => (!codeDone(u) && unmetParents(u).length ? 'pending' : 'in-flight')
  // A block without a listed reason, behind an excluded issue, is only waiting: not started.
  const units = saved.map((u) => (reopen(u) ? { ...u, status: reopenAs(u) }
    : u.status === 'blocked' && !reasonOk(u) && gates(u).length ? { ...u, status: 'pending' } : u))
  const byId = new Map(units.map((u) => [String(u.id), u]))
  // The first unit or excluded issue up the dependsOn chain that will not finish in this run.
  const waitsOn = (u, seen = new Set()) => {
    for (const d of (u.dependsOn ?? []).map(String)) {
      if (seen.has(d)) continue
      seen.add(d)
      if (excluded.has(d)) return d
      const p = byId.get(d)
      if (!p) continue
      if (p.status === 'blocked' || p.status === 'cancelled') return d
      const up = waitsOn(p, seen)
      if (up) return up
    }
    return null
  }
  const notStarted = (u) => (u.status === 'pending' || u.status === undefined) && !hasWorker(u) && waitsOn(u) !== null
  // Built on a parent's code, but the parent will not land this run: its PR cannot open.
  const builtWaiting = (u) => u.status === 'in-flight' && codeDone(u) && (!u.pr || plan.deliveryMode !== 'wait') && !hasWorker(u) && waitsOn(u) !== null
  // A block counts as settled only with a listed reason, or behind an excluded issue.
  const settledBlock = (u) => u.status !== 'blocked' || reasonOk(u) || gates(u).length > 0
  const supervised = plan.mergeMode === 'supervised'
  const lookup = (ids) => (ids ?? []).map((p) => byId.get(String(p))).filter(Boolean)
  const dependsOnOf = (u) => lookup(u.dependsOn)
  // Two units stacked on each other: the lower id is the parent, so one PR can open first.
  const lowerId = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) < Number(b) : a < b)
  // A blocked or cancelled stacksOn parent drops out: the PR bases on the target instead. In wait
  // mode a shared surface orders nothing: whichever PR merges second rebases.
  const stackParents = (u) => (stack ? lookup(u.stacksOn) : []).filter((p) => p.status !== 'blocked' && p.status !== 'cancelled')
    .filter((p) => !(p.stacksOn ?? []).map(String).includes(String(u.id)) || lowerId(String(p.id), String(u.id)))
  const parentsOf = (u) => [...lookup(u.dependsOn), ...stackParents(u)]
  // The one parent relation every line walk uses: a reciprocal pair resolves to the lower id.
  const resolvedParent = (u) => { if (!stack || !u.stacksOn?.length) return null; const p = byId.get(String(u.stacksOn[0])); return p && !((p.stacksOn ?? []).map(String).includes(String(u.id)) && !lowerId(String(p.id), String(u.id))) ? p : null }
  // Chain mode: the unmerged units whose commits a unit's branch carries (itself, its dependsOn
  // parents, and its chain parents, transitively).
  const lineOf = (u, out = new Set()) => {
    const id = String(u.id)
    if (out.has(id) || u.status === 'succeeded') return out
    out.add(id)
    for (const p of [...lookup(u.dependsOn), resolvedParent(u)].filter(Boolean)) lineOf(p, out)
    return out
  }
  const depsOf = (u, out = new Set()) => { for (const p of lookup(u.dependsOn)) if (!out.has(String(p.id))) { out.add(String(p.id)); depsOf(p, out) } return out }
  const ordered = (ids) => [...ids].map((i) => byId.get(i)).sort((a, b) => lineOf(a).size - lineOf(b).size).map((v) => String(v.id))
  const openRunPr = (v) => Boolean(v.pr) && !TERMINAL.has(v.status)
  // The open run PR a finished unit chains on: of the open PRs it carries (dependsOn) or shares a
  // file with, the one whose line holds all its dependencies, then most of them; a tie goes to the
  // deeper line, then the higher id.
  const chainParent = (u) => {
    const files = new Set(u.files)
    const deps = lineOf(u)
    const shares = (v) => (v.files ?? []).filter((f) => files.has(f))
    const cands = units.filter((v) => String(v.id) !== String(u.id) && openRunPr(v) && (deps.has(String(v.id)) || shares(v).length > 0))
    if (!cands.length) return null
    const ids = new Set(cands.map((v) => String(v.id)))
    // A line that carries every open dependency comes first; shared files only break ties.
    const depIds = cands.filter((v) => deps.has(String(v.id))).map((v) => String(v.id))
    const coversDeps = (v) => depIds.filter((i) => lineOf(v).has(i)).length
    const covers = (v) => [...lineOf(v)].filter((i) => ids.has(i)).length
    const best = [...cands].sort((a, b) => coversDeps(b) - coversDeps(a) || covers(b) - covers(a) || lineOf(b).size - lineOf(a).size || (lowerId(String(a.id), String(b.id)) ? 1 : -1))[0]
    const line = lineOf(best)
    return { parent: best, shared: shares(best), uncovered: cands.filter((v) => !line.has(String(v.id))) }
  }
  // A dependsOn cycle among unsettled units never starts: name it instead of idling.
  const cycleFrom = (u) => {
    const path = []
    const walk = (v) => {
      const id = String(v.id)
      const at = path.indexOf(id)
      if (at >= 0) return path.slice(at)
      if (TERMINAL.has(v.status)) return null
      path.push(id)
      for (const p of lookup(v.dependsOn)) { const c = walk(p); if (c) return c }
      path.pop()
      return null
    }
    return walk(u)
  }
  const actions = []
  const add = (action, u, detail) => actions.push({ action, unit: String(u.id), detail })
  const chainReady = []
  const chainOpen = (u) => {
    const id = String(u.id)
    if (!Array.isArray(u.files)) return `record unit ${id}'s own changed files as files (git diff --name-only <its base>...HEAD in its workspace), then rerun: its chain parent comes from them`
    const c = chainParent(u)
    if (!c) return `open unit ${id}'s PR as a draft on the target: no open run PR shares its files${dependsOnOf(u).length ? '; rebase it onto the target first, since its parents merged' : ''}`
    const headless = [c.parent, ...c.uncovered].filter((v) => !v.headSha)
    if (headless.length) return `record headSha for ${headless.map((v) => `unit ${v.id}'s PR`).join(', ')}, then rerun: unit ${id} chains on a parent's exact HEAD`
    const p = c.parent
    const why = c.shared.length ? `shares ${c.shared.slice(0, 3).join(', ')}${c.shared.length > 3 ? ` and ${c.shared.length - 3} more` : ''}` : 'it builds on its code'
    // A dependency on another line rides this branch as a copy: open now so review and CI start, but
    // ship only after that dependency lands and a restack drops the copy (its own PR merges it).
    const deps = lineOf(u)
    const offLine = c.uncovered.filter((v) => deps.has(String(v.id))).map((v) => String(v.id))
    const sharing = c.uncovered.filter((v) => !deps.has(String(v.id)))
    const other = `; set offLine to [${offLine.join(', ')}]${offLine.length ? ': those dependencies sit on another line, so this PR ships only after they land and a restack drops their commits' : ''}${sharing.length ? `; it also shares files with ${sharing.map((v) => v.id).join(', ')} on another line: whichever of those merges second rebases onto the target` : ''}`
    const base = chain ? `the PR keeps base targetBranch and carries ${p.id}'s line until it lands` : `push it as a Mergify stack on ${p.id}'s PR (base: its branch; mergify skill)`
    return `open unit ${id}'s PR as a draft ${chain ? 'on the target, chained' : 'stacked'} on unit ${p.id} (${p.pr}; ${why}): rebase onto ${p.branch ?? `unit ${p.id}'s branch`} at ${p.headSha ? p.headSha.slice(0, 7) : 'its HEAD'} now (a fix worker resolves conflicts once), set stacksOn to [${p.id}] and parentHead to that HEAD, and review it against that branch; ${base}${other}`
  }
  // Decide before you defer: an open question holds the unit until a decision answers it.
  const answeredBy = new Map()
  for (const d of Array.isArray(plan.decisions) ? plan.decisions : []) {
    for (const key of [d?.answers].flat()) if (typeof key === 'string' && key) answeredBy.set(key, String(d.id ?? ''))
  }
  const decideKey = (id, r) => `reviews/${id}-r${r.round}.decide.json`
  const reviewQuestion = (u) => { const r = reviews[String(u.id)]; return r?.decide && r.head === u.headSha && !r.fix ? r : null }
  const openQuestions = (u) => {
    const id = String(u.id)
    const out = (questions[id] ?? []).filter((q) => !answeredBy.has(q.key))
    const r = reviewQuestion(u)
    if (r && !answeredBy.has(decideKey(id, r))) out.push({ key: decideKey(id, r), ask: r.ask || 'a recurring spec finding: implementer and reviewer read the requirement differently' })
    return out
  }
  const deciding = (u) => !hasWorker(u) && u.status !== 'succeeded' && u.status !== 'cancelled' && openQuestions(u).length > 0
  // A handback at the unit's HEAD: the review is complete and holds a P0/P1, yet wrote no fix brief
  // and waits on no GitHub reviewer. Review it again instead of re-reading the old verdict.
  const reviewAgain = new Set()
  for (const u of saved) {
    // An open question's `decide` already sets the unit in-flight or defers it with its item.
    if (!reopen(u) || (deciding(u) && u.blockedReason === 'human-decision' && !resume)) continue
    const r = reviews[String(u.id)]
    if (r && u.headSha && r.head === u.headSha && u.reviewedHead !== u.headSha && !r.fix && !r.decide && r.complete && r.blocking && !r.awaiting) reviewAgain.add(String(u.id))
    const why = reasonOk(u) ? ''
      : u.blockedReason === 'human-decision' ? `unit ${u.id} is deferred to a human without naming its human-only item (humanItem 1-5 and humanNeed, expire.md#human-only), so its fix is the run's own: `
        : `unit ${u.id} is blocked without a reason from expire.md's list (blockedReason ${JSON.stringify(u.blockedReason ?? null)}), so it is not blocked: `
    add('unblock', u, reopenAs(u) === 'pending'
      ? `${why}unit ${u.id} only waits on ${unmetParents(u).join(', ')}: set it pending (not started), keep its workspace, and let it start when they are done`
      : why ? `${why}set it in-flight and take its next step; a wait on another unit or an outside blocker is pending, and a size hold in a rush run is split`
        : `unit ${u.id} was blocked in an earlier invocation: set it in-flight with fresh limits and take its failure's response again (expire.md)`)
  }

  if (Number.isFinite(now)) {
    const quietMs = quietMinutes * 60_000
    for (const u of units) {
      if (!hasWorker(u)) continue
      const since = Date.parse(u.workerSince ?? '')
      if (!Number.isFinite(since)) continue
      const last = Math.max(since, activity[String(u.id)] ?? 0)
      const quiet = Math.floor((now - last) / 60_000)
      if (now - last > quietMs) add('check-worker', u, `unit ${u.id}'s worker ${u.worker} has changed nothing in its workspace for ${quiet}m: read its latest output; if it is stuck, stop it and resume the unit in its kept workspace (expire.md)`)
    }
  }

  for (const u of units) {
    if (!hasWorker(u) || WORKER_KINDS.includes(u.workerKind)) continue
    add('worker-kind', u, u.workerKind === undefined || u.workerKind === null
      ? `unit ${u.id}'s worker ${u.worker} has no workerKind: set it to implement, fix, or review; any other worker for a unit stops`
      : `unit ${u.id}'s worker ${u.worker} is a ${JSON.stringify(u.workerKind)}: a unit runs only implement, fix, and review workers. Stop it, keep what it wrote, put its question in the unit's next implementer or fix brief, and clear worker; an explorer belongs on the fleet explore row`)
  }

  for (const u of units) {
    if (!deciding(u)) continue
    const open = openQuestions(u)
    const asks = open.map((q) => `${q.key}: ${q.ask}`).join('; ')
    const keys = open.map((q) => JSON.stringify(q.key)).join(', ')
    add('decide', u, `unit ${u.id} needs a decision (${asks}). Take the automatic answer (preflight.md#never-block-on-the-human): accept the recommendation, or form one that keeps every acceptance criterion, is easiest to undo, and touches least outside the unit. Record it in decisions with answers ${keys} and source agent-recommendation, then take the unit's next step${u.status === 'blocked' ? ' (set it in-flight)' : ''}. Defer only when every answer loosens an acceptance criterion, a required check, or a merge rule, or needs access the run lacks: record that as the decision and block the unit (human-decision, with its humanItem and humanNeed)`)
  }

  for (const u of units) {
    if (deciding(u)) continue
    if (sizeHeld(u)) { add('split', u, `unit ${u.id} is held by the size check: rush never defers for size. File its drafted split, or draft one whose largest slice is smaller than the unit and file it; a unit held only by a question takes the recommended answer (preflight.md#shortcut-mode). Then rerun the size check, or --sync after filing`); continue }
    // A unit with pushed commits gets its draft PR now, even while its worker runs, so CI runs and
    // the work is safe while it finishes; review still waits for its code to be done.
    const earlyPr = (v) => !TERMINAL.has(v.status) && !codeDone(v) && !v.pr && v.headSha && waitsOn(v) === null
      && parentsOf(v).every((p) => (stack ? Boolean(p.pr) || p.status === 'succeeded' : p.status === 'succeeded'))
    if (earlyPr(u)) add('open-pr', u, `open unit ${u.id}'s PR as a draft now at ${String(u.headSha).slice(0, 7)} (implementation.md#open-the-pr for this delivery mode): CI runs while it finishes; start review once its code is done`)
    if (TERMINAL.has(u.status) || hasWorker(u)) continue
    const id = String(u.id)
    const gate = gates(u)
    if (gate.length) continue
    if (u.status === 'pending' || u.status === undefined) {
      const met = dependsOnOf(u).every(parentDone)
      if (met) add('fill-slot', u, u.workspace || u.headSha ? `start unit ${id} in its kept workspace: its dependencies are met` : `start unit ${id}: its dependencies are met`)
      continue
    }
    if (!codeDone(u)) { add('resume', u, `unit ${id} is in flight with no worker; resume it in its workspace`); continue }
    // A parent that will not land holds its child, PR or not: it is settled, never opened or moved.
    if (waitsOn(u) !== null && (!u.pr || linked)) continue
    if (!u.pr) {
      const ok = parentsOf(u).every((p) => (stack ? Boolean(p.pr) || p.status === 'succeeded' : p.status === 'succeeded'))
      if (ok && linked) add('open-pr', u, chainOpen(u))
      else if (ok) add('open-pr', u, stack || dependsOnOf(u).length === 0 ? `open unit ${id}'s PR as a draft` : `open unit ${id}'s PR as a draft: rebase it onto the target first, since its parents merged`)
      continue
    }
    const dropped = linked ? lookup(u.stacksOn).filter((p) => (p.status === 'blocked' || p.status === 'cancelled') && !(u.dependsOn ?? []).map(String).includes(String(p.id))) : []
    if (dropped.length) {
      add('restack', u, `unit ${id}'s PR carries the commits of chain parent ${dropped.map((p) => p.id).join(', ')}, which will not land: rebase it onto the target without them (a fix worker resolves conflicts), drop ${dropped.map((p) => p.id).join(', ')} from stacksOn, push; the new HEAD takes the tier the scope script picks`)
      continue
    }
    if (!u.headSha) continue
    const review = reviews[id]
    // A fix brief at the HEAD (GitHub feedback merged after the pass) outranks the old pass.
    const fixAtHead = review && review.head === u.headSha && review.fix
    if (u.reviewedHead === u.headSha && !fixAtHead) {
      if (linked) { chainReady.push(u); continue }
      add('deliver', u, supervised
        ? `review passed on ${u.headSha.slice(0, 7)}: when CI is green, hand the PR back merge-ready`
        : `review passed on ${u.headSha.slice(0, 7)}: when CI is green, mark ready and merge (enqueue under a queue); set succeeded when it lands`)
    } else if (reviewAgain.has(id)) {
      add('start-review', u, `review ${u.pr} at ${u.headSha.slice(0, 7)} again against the issue as it reads now (round ${review.round + 1}, full); review-verdict compares it with round ${review.round}`)
    } else if (review && u.reviewedHead === review.head && review.complete && !review.blocking && !review.awaiting) {
      add('carry', u, `review passed on ${review.head.slice(0, 7)}; ${u.headSha.slice(0, 7)} came after it, so no reviewer: in its review clone run review-verdict.mjs --carry --review reviews/${id}-r${review.round + 1}.json --head ${u.headSha} --base <review base> ; then github-reviews.mjs merge and review-verdict.mjs on that file`)
    } else if (review && review.head === u.headSha) {
      const answer = reviewQuestion(u) ? answeredBy.get(decideKey(id, review)) : undefined
      if (review.fix) add('start-fix', u, `give reviews/${id}-r${review.round}.fix.json to a fix worker, as its action says`)
      else if (answer !== undefined) add('review-verdict', u, `decision ${answer} answers reviews/${id}-r${review.round}.decide.json: run review-verdict.mjs on reviews/${id}-r${review.round}.json with --decision ${answer}`)
      else add('review-verdict', u, `run github-reviews.mjs merge, then review-verdict.mjs, on reviews/${id}-r${review.round}.json`)
    } else {
      const next = (review?.round ?? 0) + 1
      add('start-review', u, review
        ? `pick the tier for ${u.pr} at ${u.headSha.slice(0, 7)}: rereview-scope.mjs --prior reviews/${id}-r${review.round}.json --base <review base> --head ${u.headSha} --write-skip reviews/${id}-r${next}.json; on skip run review-verdict.mjs on that file, else spawn round ${next}'s reviewer`
        : `review ${u.pr} at ${u.headSha.slice(0, 7)} (round ${next})`)
    }
  }

  // Chain mode: deliver each line once, at its deepest PR whose whole line passed review and is built on
  // its parents' current HEADs (`parentHead`): a branch built on an older parent HEAD would land commits
  // nobody reviewed. When a parent's HEAD passes, restack each child built on an older one, once.
  const passed = new Set(chainReady.map((u) => String(u.id)))
  const parentOf = resolvedParent
  const stale = (u) => { const p = parentOf(u); return Boolean(p && p.status !== 'succeeded' && u.parentHead !== p.headSha) }
  const consistent = (u) => { for (let v = u, n = 0; v && n <= units.length; v = parentOf(v), n++) if (stale(v)) return false; return true }
  // A PR carrying copies of another line's dependency ships only once they landed and a restack dropped
  // them. What it carries is derived, never trusted: every unmerged dependency off its chain line, plus
  // the recorded `offLine` ids that are dependencies (copies not yet dropped).
  const chainSet = (u) => { const out = new Set(); let v = parentOf(u); for (let n = 0; v && n <= units.length; n++) { for (const i of lineOf(v)) out.add(i); v = parentOf(v) } return out }
  const offLineOf = (u) => {
    if (!linked || !u.pr) return []
    const deps = depsOf(u)
    const onLine = chainSet(u)
    const derived = [...deps].filter((i) => byId.get(i)?.status !== 'succeeded' && !onLine.has(i))
    return [...new Set([...derived, ...(u.offLine ?? []).map(String).filter((i) => deps.has(i))])]
  }
  const cleaning = new Set()
  // A chained PR with no recorded offLine may carry copies nobody can see any more: restack it first.
  const unrecorded = (u) => linked && Boolean(u.pr) && Boolean(u.stacksOn?.length) && !Array.isArray(u.offLine)
  if (linked) {
    for (const u of units) {
      if (!unrecorded(u) || TERMINAL.has(u.status) || hasWorker(u) || waitsOn(u) !== null) continue
      cleaning.add(String(u.id))
      const p = parentOf(u)
      add('restack', u, `unit ${u.id} has no recorded offLine: rebase it onto ${p && !TERMINAL.has(p.status) ? `unit ${p.id}'s HEAD ${p.headSha ? p.headSha.slice(0, 7) : ''}`.trim() + `, set parentHead to ${p.headSha ? p.headSha.slice(0, 7) : 'that HEAD'}` : 'the target, clear stacksOn and parentHead'}, keep only its own commits and its dependencies on that line, record offLine as the dependencies it still carries from other lines (often []), push, and cancel CI on the replaced HEAD; carry a passed review, else the scope script picks the tier`)
    }
    for (const u of units) {
      if (cleaning.has(String(u.id))) continue
      const off = offLineOf(u)
      if (!u.pr || TERMINAL.has(u.status) || hasWorker(u) || waitsOn(u) !== null || !off.length || !off.every((i) => byId.get(i)?.status === 'succeeded')) continue
      cleaning.add(String(u.id))
      const p = parentOf(u)
      add('restack', u, `${off.join(', ')} landed: rebase unit ${u.id} onto ${p && p.status !== 'succeeded' ? `unit ${p.id}'s HEAD ${p.headSha ? p.headSha.slice(0, 7) : ''}`.trim() : 'the target'} to drop the copies of their commits, ${p && p.status !== 'succeeded' ? `set parentHead to ${p.headSha ? p.headSha.slice(0, 7) : 'that HEAD'}, ` : 'clear stacksOn and parentHead, '}clear offLine, push, and cancel CI on the replaced HEAD; carry a passed review, else the scope script picks the tier`)
    }
    for (const u of units) {
      if (offLineOf(u).length) continue
      const p = parentOf(u)
      if (!u.pr || TERMINAL.has(u.status) || hasWorker(u) || !stale(u) || TERMINAL.has(p.status) || p.reviewedHead !== p.headSha || !p.headSha) continue
      add('restack', u, `unit ${u.id}'s branch is built on ${u.parentHead ? `unit ${p.id}'s old HEAD ${String(u.parentHead).slice(0, 7)}` : `an unrecorded HEAD of unit ${p.id}`}; ${p.id} passed at ${p.headSha.slice(0, 7)}: rebase onto it, set parentHead to ${p.headSha.slice(0, 7)}, push, and cancel CI on the replaced HEAD; carry a passed review, else the scope script picks the tier`)
    }
  }
  const whole = chainReady.filter((u) => [...lineOf(u)].every((i) => passed.has(i) && !offLineOf(byId.get(i)).length && !unrecorded(byId.get(i))) && consistent(u))
  // A passed PR never waits long on an ancestor it only shares files with: move it off one that is in
  // a fix round or blocked at once, and off one still in review after MOVE_OFF_MINUTES.
  const fixing = (v) => { const r = reviews[String(v.id)]; return v.status === 'blocked' || v.status === 'cancelled' || Boolean(r && r.head === v.headSha && (r.fix || (r.complete && r.blocking))) }
  const chainUp = (u) => { const out = []; const seen = new Set([String(u.id)]); let v = u; while (v?.stacksOn?.length) { v = byId.get(String(v.stacksOn[0])); if (!v || seen.has(String(v.id))) break; seen.add(String(v.id)); out.push(v) } return out }
  for (const u of chainReady) {
    if (whole.includes(u) || cleaning.has(String(u.id))) continue
    const id = String(u.id)
    const deps = depsOf(u)
    const held = chainUp(u).filter((v) => v.status !== 'succeeded' && !passed.has(String(v.id)) && !deps.has(String(v.id)))
    if (!held.length) continue
    const r = reviews[id]
    const waited = Number.isFinite(now) && r?.head === u.headSha && Number.isFinite(r.at) ? (now - r.at) / 60_000 : 0
    const stuck = held.filter(fixing)
    if (!stuck.length && waited < MOVE_OFF_MINUTES) continue
    const drop = new Set(held.map((v) => String(v.id)))
    // The new parent is the nearest ancestor whose own line carries none of them; never drop a dependency.
    const up = chainUp(u)
    const at = up.findIndex((v) => ![...lineOf(v)].some((i) => drop.has(i)))
    if (up.slice(0, at < 0 ? up.length : at).some((v) => deps.has(String(v.id)))) continue
    const onto = at < 0 ? null : up[at]
    const names = held.map((v) => v.id).join(', ')
    add('restack', u, `unit ${id} passed review but its line waits on ${names}, which it only shares files with (${stuck.length ? `${stuck.map((v) => v.id).join(', ')} is in a fix round or blocked` : `still in review ${Math.floor(waited)}m after this pass`}): move it off: rebase onto ${onto ? `unit ${onto.id}'s branch at ${onto.headSha ? onto.headSha.slice(0, 7) : 'its HEAD'}, set stacksOn to [${onto.id}] and parentHead to that HEAD` : 'the target, clear stacksOn and parentHead'}, dropping their commits (a fix worker resolves conflicts); its new HEAD takes the tier the scope script picks, its children restack once it passes, and ${names} rebases after it lands`)
  }
  for (const u of whole) {
    if (whole.some((v) => v !== u && lineOf(v).has(String(u.id)))) continue
    const line = ordered(lineOf(u))
    const id = String(u.id)
    if (line.length === 1) {
      add('deliver', u, supervised
        ? `review passed on ${u.headSha.slice(0, 7)}: when CI is green, hand the PR back merge-ready`
        : `review passed on ${u.headSha.slice(0, 7)}: when CI is green, mark ready and merge (enqueue under a queue); set succeeded when it lands`)
      continue
    }
    add('deliver', u, supervised
      ? chain
        ? `review passed on every PR in unit ${id}'s line (${line.join(' -> ')}): when CI is green on each HEAD, hand them back merge-ready together; merging ${u.pr} lands the whole line`
        : `review passed on every PR in unit ${id}'s stack (${line.join(' -> ')}): when CI is green on each HEAD, hand the whole stack back merge-ready, to be enqueued together (Mergify lands it parent first)`
      : chain
        ? `review passed on every PR in unit ${id}'s line (${line.join(' -> ')}): when CI is green on each HEAD, mark them all ready and enqueue only ${u.pr}; its merge lands the line, and GitHub marks the others merged (set each succeeded). While one is not green yet, enqueue the deepest PR whose line is all green, and the rest after`
        : `review passed on every PR in unit ${id}'s stack (${line.join(' -> ')}): when CI is green on each HEAD, mark them all ready and enqueue them together (mergify skill, stack-push.mjs --enqueue); Mergify lands the stack parent first (set each succeeded when it lands). While one is not green yet, enqueue the green prefix, and the rest after`)
  }

  const seenCycles = new Set()
  // A stacksOn loop means no line has a deepest PR; name it like a dependsOn cycle.
  if (linked) {
    for (const u of units) {
      if (TERMINAL.has(u.status)) continue
      const path = [String(u.id)]
      for (let v = parentOf(u); v && !TERMINAL.has(v.status); v = parentOf(v)) {
        const at = path.indexOf(String(v.id))
        if (at >= 0) {
          const c = path.slice(at)
          const key = `s:${[...c].sort().join(',')}`
          if (!seenCycles.has(key)) { seenCycles.add(key); actions.push({ action: 'cycle', unit: c[0], detail: `units ${c.join(' -> ')} -> ${c[0]} are chained on each other, so no line can ship: clear stacksOn and parentHead on ${c[c.length - 1]} and restack it onto the target` }) }
          break
        }
        path.push(String(v.id))
      }
    }
  }
  for (const u of units) {
    if (TERMINAL.has(u.status)) continue
    const c = cycleFrom(u)
    if (!c || seenCycles.has([...c].sort().join(','))) continue
    seenCycles.add([...c].sort().join(','))
    actions.push({ action: 'cycle', unit: c[0], detail: `units ${c.join(' -> ')} -> ${c[0]} depend on each other, so none can start: remove the link that is not a real dependency (on GitHub and in dependsOn)` })
  }
  const SYNC = ['drop-unit', 'add-unit', 'set-deps', 'move-link', 'blocked-outside', 'cycle']
  for (const a of sync?.actions ?? []) actions.push({ action: a.action, unit: a.unit, detail: a.detail })
  const order = [...SYNC, 'worker-kind', 'decide', 'split', 'unblock', 'check-worker', 'restack', 'carry', 'review-verdict', 'start-fix', 'start-review', 'deliver', 'open-pr', 'resume', 'fill-slot']
  actions.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action))
  // One restack per unit per pass: the first reason found; the next pass sees the new HEAD.
  const restacked = new Set()
  for (let i = 0; i < actions.length; i++) if (actions[i].action === 'restack') { if (restacked.has(actions[i].unit)) actions.splice(i--, 1); else restacked.add(actions[i].unit) }
  const busy = units.filter(hasWorker).length
  // The Harness already counted our workers along with other work and reservations.
  // Without a capacity source every worker-needing action is due: the harness spawn limit governs.
  const unlimited = effectiveCapacity.source === 'none'
  const slots = unlimited ? null : effectiveCapacity.source === 'harness' ? effectiveCapacity.maxConcurrent : effectiveCapacity.slots
  let free = unlimited ? Infinity : effectiveCapacity.source === 'harness' ? effectiveCapacity.availableSlots : Math.max(0, slots - busy)
  const due = []
  const waiting = []
  for (const a of actions) {
    if (!NEEDS_SLOT.has(a.action)) { due.push(a); continue }
    if (free > 0) { due.push(unlimited ? { ...a, detail: `${a.detail} [needs a free worker slot]` } : a); free-- } else waiting.push(a)
  }
  const treeChanged = (sync?.actions ?? []).length > 0
  for (const u of units) {
    if (u.status === 'blocked' && hasWorker(u) && !settledBlock(u)) due.push({ action: 'unblock', unit: String(u.id), detail: `unit ${u.id} is blocked without a reason from expire.md's list while worker ${u.worker} is recorded: if that worker is gone, clear it and set the unit in-flight; a block needs a blockedReason` })
  }
  // A block whose cause can clear by itself (CI, a runner, a provider, the network, a dead worker) gets
  // automatic fresh attempts at growing gaps; a due attempt is printed even while other units work.
  const retryable = units.filter((u) => u.status === 'blocked' && AUTO_RETRY.has(u.blockedReason) && (u.autoRetries ?? 0) < AUTO_RETRY_GAPS_MIN.length && !hasWorker(u))
  const dueAt = (u) => (Date.parse(u.blockedAt ?? '') || 0) + AUTO_RETRY_GAPS_MIN[u.autoRetries ?? 0] * 60_000
  // A block with no blockedAt (an older plan) gets its first fresh attempt only once nothing else is left.
  const ready = retryable.filter((u) => u.blockedAt && Number.isFinite(now) && now >= dueAt(u))
  const retryDetail = (u) => (u.blockedReason === 'external-blocker'
    ? `blocker unit ${u.id} (a cause outside the run) may have cleared: rerun the command its issue records, unchanged; if it exits 0, close the blocker issue and mark ${u.id} succeeded so the units behind it continue; if not, set autoRetries ${(u.autoRetries ?? 0) + 1} and a new blockedAt`
    : `unit ${u.id} is blocked (${u.blockedReason}) and its cause may have cleared: set it in-flight with autoRetries ${(u.autoRetries ?? 0) + 1} and give it a fresh attempt on the current state; if it fails the same way, block it again with a new blockedAt`)
  for (const u of ready) due.push({ action: 'retry-blocked', unit: String(u.id), detail: retryDetail(u) })
  const parked = units.filter(notStarted).map((u) => `${u.id} (waits on ${waitsOn(u)})`)
  const built = units.filter((u) => builtWaiting(u) && !u.pr).map((u) => `${u.id} (waits on ${waitsOn(u)})`)
  const openWaiting = units.filter((u) => builtWaiting(u) && u.pr).map((u) => `${u.id} (${u.pr}, waits on ${waitsOn(u)})`)
  if (!ready.length && units.every((u) => (TERMINAL.has(u.status) || notStarted(u) || builtWaiting(u)) && settledBlock(u) && !sizeHeld(u) && !deciding(u)) && !treeChanged) {
    if (sync?.fetchError) due.push({ action: 'sync', unit: null, detail: `every unit is settled, but the issue tree could not be read (${sync.fetchError.map((e) => e.error).join('; ')}): rerun with --sync until it reads; never finish on a tree you could not read` })
    else if (sync && !String(sync.source).startsWith('live')) due.push({ action: 'sync', unit: null, detail: 'every unit is settled: rerun with --sync to check the issue tree for new issues before finishing' })
    else if (retryable.some((u) => !u.blockedAt || !Number.isFinite(now))) {
      for (const u of retryable.filter((v) => !v.blockedAt || !Number.isFinite(now))) due.push({ action: 'retry-blocked', unit: String(u.id), detail: retryDetail(u) })
    } else if (retryable.length) {
      const next = retryable.reduce((a, u) => (dueAt(u) < dueAt(a) ? u : a))
      due.push({ action: 'wait', unit: String(next.id), detail: `unit ${next.id} is blocked (${next.blockedReason}); its next automatic attempt is at ${new Date(dueAt(next)).toISOString()}: keep a heartbeat until then and do not finish` })
    } else due.push({ action: 'finish', unit: null, detail: `every unit is delivered, blocked, cancelled, or not started behind one of those: write the handoff${parked.length ? `; not started: ${parked.join(', ')}` : ''}${built.length ? `; built, PR not opened: ${built.join(', ')}` : ''}${openWaiting.length ? `; PR open, cannot land: ${openWaiting.join(', ')}` : ''}` })
  }
  // How long each due action has gone undone, from when it was first printed.
  const nextSeen = {}
  for (const a of due) {
    const key = `${a.action}:${a.unit ?? ''}`
    const first = Number.isFinite(seen[key]) ? seen[key] : now
    if (Number.isFinite(first)) nextSeen[key] = first
    const undone = Number.isFinite(now) && Number.isFinite(first) ? Math.floor((now - first) / 60_000) : 0
    // deliver and check-worker repeat while CI, the queue, or a worker runs: not neglect.
    if (undone >= UNDONE_NOTE_MINUTES && !WAITS_ON_OTHERS.has(a.action)) a.detail += ` [printed ${undone}m ago and still not done: do it now]`
  }
  return { busy, slots, capacity: effectiveCapacity, due, waiting, seen: nextSeen }
}

// The newest file change in each busy unit's workspace, in ms. Skips dependency and build
// output (a worker that only downloads is not progressing) and stops after `limit` entries.
const SKIP_DIRS = new Set(['node_modules', '.gradle', 'build', 'dist', '.next', '.turbo', '.cache', 'Pods'])
export function readActivity(plan, limit = 20_000) {
  const units = (Array.isArray(plan?.units) ? plan.units : plan?.issues) ?? []
  const out = {}
  for (const u of units) {
    if (!hasWorker(u) || typeof u.workspace !== 'string' || !existsSync(u.workspace)) continue
    let newest = 0
    let seen = 0
    const stack = [u.workspace]
    for (const f of ['.git/index', '.git/logs/HEAD']) {
      try { newest = Math.max(newest, statSync(join(u.workspace, f)).mtimeMs) } catch { /* not a git checkout */ }
    }
    while (stack.length && seen < limit) {
      const dir = stack.pop()
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (++seen > limit) break
        if (e.isDirectory()) { if (e.name !== '.git' && !SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name)); continue }
        try { newest = Math.max(newest, statSync(join(dir, e.name)).mtimeMs) } catch { /* removed meanwhile */ }
      }
    }
    if (newest) out[String(u.id)] = newest
  }
  return out
}

// The newest review round per unit, from <run>/reviews/<unit>-r<N>.json.
export function readReviews(runDir) {
  const dir = join(runDir, 'reviews')
  const out = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(.+)-r(\d+)\.json$/)
    if (!m) continue
    const [, unit, n] = m
    const round = Number(n)
    if (out[unit] && out[unit].round >= round) continue
    let saved = {}
    try { saved = JSON.parse(readFileSync(join(dir, name), 'utf8')) ?? {} } catch { saved = {} }
    const awaiting = Array.isArray(saved.external?.awaiting) && saved.external.awaiting.length > 0
    const blocking = Array.isArray(saved.findings) && saved.findings.some((f) => BLOCKING.includes(f?.severity))
    const decidePath = join(dir, `${unit}-r${round}.decide.json`)
    const decide = existsSync(decidePath)
    let ask = ''
    if (decide) {
      try { ask = (JSON.parse(readFileSync(decidePath, 'utf8'))?.question ?? []).map((q) => `${q.id}: ${q.summary}`).join('; ') } catch { ask = '' }
    }
    let at
    try { at = statSync(join(dir, name)).mtimeMs } catch { at = undefined }
    out[unit] = { round, at, head: saved.head ?? null, fix: existsSync(join(dir, `${unit}-r${round}.fix.json`)), complete: saved.complete === true, awaiting, blocking, ...(decide ? { decide, ask } : {}) }
  }
  return out
}

// Each unit's open worker questions, from <run>/results/*.json: a result whose
// `decisionNeeded` is set (a string, or an object with `question`). Its unit is the result's
// `unit`, else the file name up to its first '-'.
export function readQuestions(runDir) {
  const dir = join(runDir, 'results')
  const out = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    let saved
    try { saved = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
    const need = saved?.decisionNeeded
    const ask = typeof need === 'string' ? need.trim() : need && typeof need === 'object' ? String(need.question ?? JSON.stringify(need)).trim() : ''
    if (!ask) continue
    const unit = String(saved.unit ?? name.split('-')[0].replace(/\.json$/, ''))
    ;(out[unit] ??= []).push({ key: `results/${name}`, ask })
  }
  return out
}

const USAGE = 'usage: next-actions.mjs --run <run dir> [--capacity-json <fresh snapshot JSON> | --slots <explicit workflow budget>] [--quiet-minutes 45] [--resume] [--sync] [--json] [--peek] [--mode full|narrow|off] [--rules] [--exit-due]\nexit 0 when it ran (the outcome is in the output; --json carries exitDue), 2 on error; --exit-due exits 1 when anything is due. Without a capacity flag every worker action is due, noted as needing a free slot.'

export function parseCliArgs(argv) {
  const opts = { quietMinutes: DEFAULT_QUIET_MINUTES, json: false, resume: false, sync: false, peek: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--json') { opts.json = true; continue }
    if (flag === '--resume') { opts.resume = true; continue }
    if (flag === '--sync') { opts.sync = true; continue }
    if (flag === '--peek') { opts.peek = true; continue }
    if (flag === '--rules') { opts.rules = true; continue }
    if (flag === '--exit-due') { opts.exitDue = true; continue }
    if (flag === '--mode' && argv[i + 1] !== undefined) { opts.mode = argv[++i]; continue }
    if (flag === '--quiet-minutes' && argv[i + 1] !== undefined) { opts.quietMinutes = Number(argv[++i]); continue }
    if (!['--run', '--slots', '--capacity-json'].includes(flag) || argv[i + 1] === undefined) throw new NextActionsError(USAGE)
    const key = flag === '--capacity-json' ? 'capacityJson' : flag.slice(2)
    if (opts[key] !== undefined) throw new NextActionsError(`${flag} may be supplied only once`)
    opts[key] = argv[++i]
  }
  if (!opts.run) throw new NextActionsError(USAGE)
  if (opts.slots !== undefined && opts.capacityJson !== undefined) {
    throw new NextActionsError('supply at most one capacity source: --capacity-json or --slots')
  }
  if (opts.capacityJson !== undefined) {
    let parsed
    try { parsed = JSON.parse(opts.capacityJson) } catch { throw new NextActionsError('--capacity-json must be valid JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NextActionsError('--capacity-json must contain a Harness snapshot object')
    opts.capacity = normalizeCapacity(parsed)
    delete opts.capacityJson
  } else if (opts.slots !== undefined) {
    if (!/^\d+$/.test(opts.slots)) throw new NextActionsError('--slots must be a nonnegative safe integer')
    opts.slots = Number(opts.slots)
    normalizeCapacity(opts.slots)
  }
  if (!(opts.quietMinutes > 0) || !Number.isFinite(opts.quietMinutes)) throw new NextActionsError('--quiet-minutes must be a positive finite number')
  return opts
}

if (isMainModule(import.meta.url)) {
  try {
    const opts = parseCliArgs(process.argv.slice(2))
    let plan
    try { plan = JSON.parse(readFileSync(join(opts.run, 'task-plan.json'), 'utf8')) } catch (error) {
      throw new NextActionsError(`cannot read ${join(opts.run, 'task-plan.json')}: ${error.message}`)
    }
    let sync = null
    try {
      sync = syncRun(opts.run, { live: opts.resume || opts.sync })
    } catch (error) {
      sync = { synced: false, actions: [], fetchError: [{ key: 'plan', error: error.message }] }
    }
    const seenPath = join(opts.run, 'next-actions-seen.json')
    let seen = {}
    try { seen = JSON.parse(readFileSync(seenPath, 'utf8')) ?? {} } catch { seen = {} }
    const result = nextActions(plan, readReviews(opts.run), opts.capacity ?? opts.slots, { resume: opts.resume, now: Date.now(), activity: readActivity(plan), quietMinutes: opts.quietMinutes, sync: sync.source === 'none' && !sync.missingTree && !sync.fetchError ? null : sync, seen, questions: readQuestions(opts.run) })
    if (!opts.peek) {
      try { writeFileSync(seenPath, `${JSON.stringify(result.seen)}\n`) } catch { /* a read-only run dir only loses the undone note */ }
    }
    delete result.seen
    // full: every due step; narrow: done or not, units with work, guards; off: done or not only.
    const mode = opts.mode ?? plan.schedulerMode ?? 'full'
    if (!SCHEDULER_MODES.includes(mode)) throw new NextActionsError(`scheduler mode must be ${SCHEDULER_MODES.join(', ')}: ${JSON.stringify(mode)}`)
    const exitDue = result.due.length > 0
    const showRules = opts.resume || opts.rules
    const budgetLine = (capacity) => capacity.source === 'harness'
      ? `workers ${result.busy}; Harness ${capacity.occupiedSlots}/${capacity.maxConcurrent} occupied, ${capacity.availableSlots} available`
      : capacity.source === 'none'
        ? `workers ${result.busy}; no capacity given: worker actions need a free worker slot (the harness spawn limit governs)`
        : `slots ${result.busy}/${result.slots} busy (explicit workflow budget)`
    const rulesLine = (text) => showRules ? `${'rules'.padEnd(15)}${text} Full text: ${SKILL_PATH}\n` : `${'rules'.padEnd(15)}Rules: ${SKILL_PATH} (--rules prints them)\n`
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...result, mode, exitDue }, null, 2)}\n`)
    else if (mode !== 'full') {
      const view = narrowView(plan, result)
      const guardNames = [...new Set(result.due.filter((a) => /^guards: (?!none)/m.test(view) && ['decide', 'review-verdict', 'unblock', 'worker-kind', 'split', 'sync', 'add-unit', 'drop-unit', 'set-deps', 'move-link', 'blocked-outside'].includes(a.action)).map((a) => a.action))]
      process.stdout.write(`${mode === 'off' ? `${view.split('\n')[0].replace(/: .*$/, '')}${guardNames.length ? ` (clear first: ${guardNames.join(', ')})` : ''}` : view}\n`)
      process.stdout.write(`${budgetLine(result.capacity)}\n`)
      process.stdout.write(rulesLine(`${mode === 'off' ? 'Scheduler mode off: plan every step yourself from the plan and results.' : 'Scheduler mode narrow: clear the guards, then choose each unit\'s next step yourself.'} The run ends only when this prints "run done".`))
    } else {
      for (const a of result.due) process.stdout.write(`${a.action.padEnd(15)}${a.detail}\n`)
      for (const a of result.waiting) process.stdout.write(`${'waiting-slot'.padEnd(15)}${a.detail}\n`)
      process.stdout.write(`${budgetLine(result.capacity)}; ${result.due.length} due\n`)
      process.stdout.write(rulesLine(RULES))
    }
    process.exitCode = opts.exitDue && exitDue ? 1 : 0
  } catch (error) {
    process.stderr.write(`next-actions: ${error.message}\n`)
    process.exitCode = 2
  }
}

// The narrow view: whether the run is done, which units have work, the guards, and what waits on
// the human. It leaves each unit's next step to the coordinator.
export function narrowView(plan, result) {
  const GUARDS = new Set(['decide', 'review-verdict', 'unblock', 'worker-kind', 'split', 'sync', 'add-unit', 'drop-unit', 'set-deps', 'move-link', 'blocked-outside'])
  const units = new Map((plan.units ?? []).map((u) => [String(u.id), u]))
  const guards = result.due.filter((a) => GUARDS.has(a.action)).map((a) => `${a.unit ?? 'run'}: ${a.detail}`)
  const work = [...new Set([...result.due, ...result.waiting].filter((a) => a.unit && !GUARDS.has(a.action) && a.action !== 'wait').map((a) => a.unit))]
  const wait = result.due.find((a) => a.action === 'wait')
  const held = [...units.values()].filter((u) => u.status === 'blocked' && u.blockedReason === 'human-decision').map((u) => `${u.id} (item ${u.humanItem ?? '?'}: ${u.humanNeed ?? 'unstated'})`)
  const done = result.due.some((a) => a.action === 'finish')
  const state = done ? 'done: write the handoff' : guards.length ? 'not done: clear the guards first' : work.length ? 'not done: units have work' : wait ? `not done: waiting (${wait.detail})` : 'not done: workers are running'
  return [`run ${state}`, `units with work: ${work.join(', ') || 'none'} (choose each unit's next step yourself)`,
    `guards: ${guards.length ? guards.join(' | ') : 'none'}`, `held on the human: ${held.join(', ') || 'none'}`].join('\n')
}
