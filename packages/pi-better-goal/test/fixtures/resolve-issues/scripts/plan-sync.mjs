#!/usr/bin/env node
// Keep a run's task plan in step with its spec's GitHub issue tree, the only record of
// scope. Every open issue under the spec with no open sub-issue is a unit; an issue with an
// open sub-issue is a container; a closed issue is done. Order comes from native
// `blockedBy` links.
//
//   plan-sync.mjs --run <run dir> [--live] [--json] [--exit-actions]
//   plan-sync.mjs --find-run --runs <runs dir> --issue <owner/name#123> [--json] [--exit-actions]
//
// --live fetches the tree (issue-tree.mjs, one GraphQL query plus follow-ups) and, when the
// fetch is complete, saves it as <run>/issue-tree.json. Without --live it diffs the plan
// against that saved snapshot and makes no GitHub call. Actions:
//
//   add-unit         an open leaf issue under the spec that the plan does not know
//   set-deps         a unit lacks a dependency its own issue's blockedBy names
//   move-link        an issue with open sub-issues is blocked by an open issue: GitHub shows
//                    it holding every sub-issue, but the run never inherits it, so move it
//                    onto the sub-issues that use what the blocker builds
//   drop-unit        a unit's issue was closed, gained open sub-issues, or left the tree
//   blocked-outside  a unit waits on an open issue outside the spec's tree
//
// The plan knows an issue when a unit (any status), an `excluded` entry, or `merged` (merged
// by an earlier run) names it. set-deps only adds: dependencies the explorer recorded
// stay. A partial or failed fetch never drops a unit or changes dependencies; a failed one
// falls back to the snapshot. A plan whose spec is not a GitHub issue has nothing to sync.
//
// --find-run prints the newest run directory whose spec or saved tree contains the issue, so
// a new invocation resumes the spec's run instead of starting a second one.
//
// Exit 0 whenever it ran and answered: actions due or not, no tree available (`missingTree`),
// a run found or not; the outcome is in the output (--json: `actions`, `missingTree`, and for
// --find-run `found` and `dir`). Exit 2 only when it could not run (bad arguments, unreadable plan).
// With --find-run and no run found, plain output is empty on stdout (a note goes to stderr).
// --exit-actions restores the old exit codes for one release (deprecated): 1 when actions are due
// or no run was found, 2 when no tree is available.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isMainModule } from '../../engineering-runtime/scripts/main-module.mjs'
import { fetchTree, keyOf } from './issue-tree.mjs'
import { parseIssueRef } from './ready-check.mjs'

export const SNAPSHOT = 'issue-tree.json'
const DONE = new Set(['succeeded', 'cancelled'])

export class PlanSyncError extends Error {}

const unitsOf = (plan) => (Array.isArray(plan?.units) ? plan.units : plan?.issues) ?? []

// The spec's root issue, or null for a local or pasted spec.
export function specRef(plan) {
  for (const value of [plan?.specLocator, plan?.spec, plan?.specUrl]) {
    if (typeof value !== 'string') continue
    try { return parseIssueRef(value) } catch { /* not an issue reference */ }
  }
  return null
}

// The issue a unit or excluded entry names, as "owner/name#n", or null.
function issueKey(entry, repo) {
  for (const value of [entry?.issue, entry?.ref, entry?.id]) {
    if (value === undefined || value === null) continue
    try {
      const ref = parseIssueRef(String(value), repo)
      return keyOf(ref.repo, ref.number)
    } catch { /* not an issue reference */ }
  }
  return null
}

const idFor = (key, repo) => (key.startsWith(`${repo}#`) ? key.slice(repo.length + 1) : key)

// The unit ids of the plan's `excluded` issues (release gates, human-only environment work,
// empty rollups): a unit that depends on one waits for a human, never for the run.
export function excludedIds(plan) {
  const repo = specRef(plan)?.repo ?? null
  const ids = new Set()
  for (const e of plan?.excluded ?? []) {
    const key = issueKey(e, repo)
    const raw = e?.issue ?? e?.id
    if (key) ids.add(repo ? idFor(key, repo) : key)
    else if (raw !== undefined && raw !== null) ids.add(String(raw).replace(/^#/, ''))
  }
  return ids
}

export function classify(tree) {
  const kind = {}
  for (const node of Object.values(tree.nodes)) {
    if (node.state !== 'open') { kind[node.key] = 'closed'; continue }
    const open = (node.children ?? []).filter((k) => tree.nodes[k]?.state === 'open')
    kind[node.key] = open.length ? 'container' : 'unit'
  }
  return kind
}

// Diff the plan against the tree. `partial` suppresses every removal and dependency change.
export function planSync(plan, tree) {
  const root = specRef(plan)
  if (!root) return { synced: false, actions: [] }
  const repo = root.repo
  const partial = !tree.complete
  const kind = classify(tree)
  const nodes = tree.nodes
  const units = unitsOf(plan)
  const byKey = new Map()
  for (const u of units) { const key = issueKey(u, repo); if (key) byKey.set(key, u) }
  const known = new Set(byKey.keys())
  for (const e of plan.excluded ?? []) { const key = issueKey(e, repo); if (key) known.add(key) }
  for (const id of plan.merged ?? []) { const key = issueKey({ id }, repo); if (key) known.add(key) }

  const leavesUnder = (key, seen = new Set()) => {
    if (seen.has(key)) return []
    seen.add(key)
    if (kind[key] === 'unit') return [key]
    if (kind[key] !== 'container') return []
    return (nodes[key].children ?? []).flatMap((k) => leavesUnder(k, seen))
  }
  // A unit waits on its own issue's blockers only. A container's link is never inherited:
  // move-link asks for it on the sub-issues that actually wait.
  const blockers = (key) => nodes[key]?.blockedBy ?? []
  const wants = (key) => {
    const deps = new Set()
    const outside = []
    for (const b of blockers(key)) {
      if (b.state !== 'open') continue
      if (nodes[b.key]) for (const leaf of leavesUnder(b.key)) { if (leaf !== key) deps.add(idFor(leaf, repo)) }
      else outside.push(b.key)
    }
    return { deps: [...deps].sort(), outside }
  }

  const actions = []
  const add = (action, unit, detail, extra = {}) => actions.push({ action, unit, detail, ...extra })
  for (const [key, k] of Object.entries(kind)) {
    if (k !== 'unit' || known.has(key)) continue
    const node = nodes[key]
    const { deps } = wants(key)
    const id = idFor(key, repo)
    const rollup = (node.children ?? []).length > 0
    add('add-unit', id, `add unit ${id} for ${key} "${node.title}"${deps.length ? ` with dependsOn [${deps.join(', ')}]` : ''}: fetch its issue into the run, continue the explorer for it, rerun the size check${rollup ? '; every sub-issue is closed, so the explorer records what is left or that nothing is (then hand back "close it")' : ''}`, { issue: key, dependsOn: deps })
  }
  for (const [key, u] of byKey) {
    if (DONE.has(u.status)) continue
    const id = String(u.id)
    const k = kind[key]
    if (k === undefined) {
      if (!partial) add('drop-unit', id, `unit ${id}'s issue ${key} is no longer under ${tree.root}: cancel the unit, or put the issue back in the tree`, { issue: key })
      continue
    }
    if (k === 'closed') { add('drop-unit', id, `unit ${id}'s issue ${key} was closed on GitHub: set succeeded if its PR merged, else cancelled`, { issue: key }); continue }
    if (k === 'container') {
      const open = (nodes[key].children ?? []).filter((c) => nodes[c]?.state === 'open').map((c) => idFor(c, repo))
      if (!partial) add('drop-unit', id, `unit ${id}'s issue ${key} now has open sub-issues (${open.join(', ')}): they are the units; cancel ${id} and keep its workspace`, { issue: key })
      continue
    }
    const { deps, outside } = wants(key)
    if (!partial) {
      const have = new Set((u.dependsOn ?? []).map(String))
      const missing = deps.filter((d) => !have.has(d))
      if (missing.length) add('set-deps', id, `unit ${id} waits on ${missing.join(', ')} (blockedBy on GitHub): add ${missing.length === 1 ? 'it' : 'them'} to its dependsOn`, { issue: key, dependsOn: [...have, ...missing] })
    }
    for (const o of outside) add('blocked-outside', id, `unit ${id} is blocked by open ${o}, outside ${tree.root}: make it a sub-issue of an issue in the tree, or remove the link`, { issue: key, blocker: o })
  }
  for (const [key, k] of Object.entries(kind)) {
    if (k !== 'container' || key === tree.root) continue
    const open = (nodes[key].blockedBy ?? []).filter((b) => b.state === 'open').map((b) => b.key)
    if (!open.length) continue
    const children = (nodes[key].children ?? []).filter((c) => nodes[c]?.state === 'open').map((c) => idFor(c, repo))
    add('move-link', idFor(key, repo), `${key} has ${children.length} open sub-issues (${children.join(', ')}) and is blocked by ${open.join(', ')}; the run does not inherit a link on it: add blocked_by on each sub-issue that uses what the blocker builds, remove the link from ${key}, drop the blocker from the dependsOn of sub-issues that do not use it, and rerun next-actions.mjs with --sync so the saved tree sees the move`, { issue: key, blockers: open })
  }
  const order = ['drop-unit', 'add-unit', 'set-deps', 'move-link', 'blocked-outside']
  actions.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || String(a.unit).localeCompare(String(b.unit)))
  return { synced: true, partial, actions }
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

// Sync a run directory: fetch when `live`, else (or when the fetch fails) use the snapshot.
export function syncRun(runDir, { live = false, fetch = fetchTree, now = () => new Date() } = {}) {
  const plan = readJson(join(runDir, 'task-plan.json'))
  if (!plan) throw new PlanSyncError(`cannot read ${join(runDir, 'task-plan.json')}`)
  const root = specRef(plan)
  if (!root) return { source: 'none', synced: false, actions: [] }
  const snapshotPath = join(runDir, SNAPSHOT)
  let tree = null
  let source = 'snapshot'
  let fetchError = null
  if (live) {
    const fetched = fetch(root)
    if (fetched.complete) {
      tree = { ...fetched, fetchedAt: now().toISOString() }
      writeFileSync(snapshotPath, `${JSON.stringify(tree, null, 2)}\n`)
      source = 'live'
    } else if (Object.keys(fetched.nodes).length && fetched.nodes[fetched.root]?.children) {
      tree = fetched
      source = 'live-partial'
      fetchError = fetched.errors
    } else {
      fetchError = fetched.errors
    }
  }
  if (!tree) tree = readJson(snapshotPath)
  if (!tree) return { source: 'none', synced: false, fetchError, actions: [], missingTree: true }
  const result = planSync(plan, tree)
  return { source, fetchedAt: tree.fetchedAt ?? null, fetchError, ...result }
}

// The newest run whose spec is the issue, or whose saved tree contains it.
export function findRun(runsDir, ref) {
  const key = keyOf(ref.repo, ref.number)
  let best = null
  let names = []
  try { names = readdirSync(runsDir) } catch { return null }
  for (const name of names) {
    const dir = join(runsDir, name)
    const planPath = join(dir, 'task-plan.json')
    if (!existsSync(planPath)) continue
    const plan = readJson(planPath)
    const spec = specRef(plan)
    const tree = readJson(join(dir, SNAPSHOT))
    const match = (spec && keyOf(spec.repo, spec.number) === key) || Boolean(tree?.nodes?.[key])
    if (!match) continue
    const mtime = statSync(planPath).mtimeMs
    if (!best || mtime > best.mtime) best = { dir, mtime }
  }
  return best?.dir ?? null
}

export function parseCliArgs(argv) {
  const opts = { live: false, json: false, findRun: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--live') opts.live = true
    else if (flag === '--json') opts.json = true
    else if (flag === '--find-run') opts.findRun = true
    else if (flag === '--exit-actions') opts.exitActions = true
    else if (['--run', '--runs', '--issue'].includes(flag) && argv[i + 1] !== undefined) opts[flag.slice(2)] = argv[++i]
    else throw new PlanSyncError('usage: plan-sync.mjs --run <run dir> [--live] [--json] [--exit-actions] | --find-run --runs <runs dir> --issue <owner/name#123> [--json] [--exit-actions]; exit 0 when it ran (the outcome is in the output), 2 on error')
  }
  if (opts.findRun ? !(opts.runs && opts.issue) : !opts.run) throw new PlanSyncError('usage: plan-sync.mjs --run <run dir> [--live] [--json] [--exit-actions] | --find-run --runs <runs dir> --issue <owner/name#123> [--json] [--exit-actions]; exit 0 when it ran (the outcome is in the output), 2 on error')
  return opts
}

if (isMainModule(import.meta.url)) {
  try {
    const opts = parseCliArgs(process.argv.slice(2))
    if (opts.findRun) {
      const dir = findRun(opts.runs, parseIssueRef(opts.issue))
      if (opts.json) console.log(JSON.stringify({ found: Boolean(dir), dir }, null, 2))
      else if (dir) console.log(dir)
      else process.stderr.write(`plan-sync: no run under ${opts.runs} for ${opts.issue}\n`)
      process.exitCode = opts.exitActions && !dir ? 1 : 0
    } else {
      const result = syncRun(opts.run, { live: opts.live })
      if (opts.json) console.log(JSON.stringify(result, null, 2))
      else {
        for (const a of result.actions) process.stdout.write(`${a.action.padEnd(17)}${a.detail}\n`)
        if (result.fetchError) process.stdout.write(`fetch failed, ${result.source === 'live-partial' ? 'partial tree used' : 'saved snapshot used'}: ${result.fetchError.map((e) => `${e.key}: ${e.error}`).join('; ')}\n`)
        process.stdout.write(result.synced ? `tree ${result.source}${result.fetchedAt ? ` ${result.fetchedAt}` : ''}; ${result.actions.length} due\n` : result.missingTree ? 'no issue tree available (no saved snapshot and no successful fetch): rerun with --live\n' : 'no issue tree to sync\n')
      }
      process.exitCode = opts.exitActions ? (result.missingTree ? 2 : result.actions.length ? 1 : 0) : 0
    }
  } catch (error) {
    process.stderr.write(`plan-sync: ${error.message}\n`)
    process.exitCode = 2
  }
}
