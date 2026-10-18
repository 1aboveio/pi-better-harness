#!/usr/bin/env node
// Fetch a spec's GitHub issue tree (native sub-issues at any depth, each issue's labels and
// native `blockedBy` links) in as few calls as possible: one GraphQL query covers three
// levels, and follow-up queries run only where GitHub truncated something.
//
//   issue-tree.mjs --issue <owner/name#123> [--json]
//
// Exit 0 whenever it ran (an incomplete tree is `complete: false` with `errors`, not a failure);
// 2 for a bad command.
//
// GraphQL caps a query at 500,000 potential nodes, counted from every `first:` multiplied
// down the nesting, so the levels narrow (50, 20, 10 sub-issues) and each issue asks for at
// most 20 labels and 10 blockers. A follow-up runs only for: an issue below the third
// level that has sub-issues (re-rooted query), an issue with more sub-issues than its
// level returned (pages of child numbers, each child re-rooted), and an issue with more
// labels or blockers than fit (one wide detail query). Transient failures (HTTP 502/503/
// 504, EOF, timeouts, connection resets) retry; anything still failing is listed in
// `errors` and the tree is marked incomplete, never guessed.
//
// Result: { root, complete, errors, nodes: { "owner/name#n": node } } where a node is
// { key, repo, number, title, state ('open'|'closed'), url, labels, blockedBy: [{ key, state }],
//   children: [key] | null (null = not fetched), parent }.

import { execFileSync } from 'node:child_process'

import { isMainModule } from '../../engineering-runtime/scripts/main-module.mjs'

export const WIDTHS = [50, 20, 10]
const LABELS = 20
const BLOCKERS = 10
const WIDE = 100
const TRANSIENT = /\b(?:502|503|504)\b|EOF|ETIMEDOUT|timed? ?out|ECONNRESET|socket hang up|Bad Gateway|Service Unavailable|Gateway Timeout/i

const fields = (labels, blockers) => `number title state url repository { nameWithOwner }
  labels(first: ${labels}) { totalCount nodes { name } }
  blockedBy(first: ${blockers}) { totalCount nodes { number state repository { nameWithOwner } } }`

function level(depth) {
  if (depth >= WIDTHS.length) return 'subIssuesSummary { total }'
  return `subIssues(first: ${WIDTHS[depth]}) { totalCount pageInfo { hasNextPage endCursor }
    nodes { ${fields(LABELS, BLOCKERS)} ${level(depth + 1)} } }`
}

export const TREE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${fields(LABELS, BLOCKERS)} ${level(0)} } } }`

export const PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    subIssues(first: ${WIDE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { number repository { nameWithOwner } } } } } }`

export const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${fields(WIDE, WIDE)} } } }`

export const keyOf = (repo, number) => `${repo}#${number}`
const split = (key) => { const i = key.lastIndexOf('#'); return { repo: key.slice(0, i), number: Number(key.slice(i + 1)) } }

// Retry a call while it fails transiently; `sleep` is injected so tests do not wait.
export function withRetry(fn, { attempts = 3, sleep = sleepSync } = {}) {
  return (...args) => {
    for (let i = 1; ; i++) {
      try { return fn(...args) } catch (error) {
        if (i >= attempts || !TRANSIENT.test(String(error?.message || error))) throw error
        sleep(1000 * i)
      }
    }
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// `graphql(query, variables)` returns the response's `data`; inject it to test without GitHub.
export function fetchTree(rootRef, { graphql = ghGraphql, attempts = 3, sleep } = {}) {
  const call = withRetry(graphql, { attempts, sleep })
  const nodes = {}
  const errors = []
  const root = keyOf(rootRef.repo, rootRef.number)
  const issueOf = (key, query, extra = {}) => {
    const { repo, number } = split(key)
    const [owner, name] = repo.split('/')
    const issue = call(query, { owner, name, number, ...extra })?.repository?.issue
    if (!issue) throw new Error(`issue ${key} not found`)
    return issue
  }
  const followUps = []

  // Record an issue and everything nested under it; queue follow-ups for what was cut off.
  const record = (raw, parent) => {
    const repo = raw.repository?.nameWithOwner
    const key = keyOf(repo, raw.number)
    const prior = nodes[key]
    const node = {
      key, repo, number: raw.number, title: raw.title ?? null,
      state: String(raw.state || '').toLowerCase(), url: raw.url ?? null,
      labels: (raw.labels?.nodes ?? []).map((l) => l.name),
      blockedBy: (raw.blockedBy?.nodes ?? []).map((b) => ({ key: keyOf(b.repository?.nameWithOwner ?? repo, b.number), state: String(b.state || '').toLowerCase() })),
      children: null,
      parent: prior?.parent ?? parent,
    }
    nodes[key] = node
    if ((raw.labels?.totalCount ?? 0) > node.labels.length || (raw.blockedBy?.totalCount ?? 0) > node.blockedBy.length) followUps.push({ kind: 'detail', key })
    if (raw.subIssues) {
      node.children = raw.subIssues.nodes.map((child) => record(child, key))
      if (raw.subIssues.pageInfo?.hasNextPage) followUps.push({ kind: 'page', key, after: raw.subIssues.pageInfo.endCursor })
    } else if ((raw.subIssuesSummary?.total ?? 0) === 0) {
      node.children = []
    } else {
      followUps.push({ kind: 'reroot', key })
    }
    return key
  }

  try {
    record(issueOf(root, TREE_QUERY), null)
  } catch (error) {
    return { root, complete: false, errors: [{ key: root, error: String(error?.message || error) }], nodes }
  }
  while (followUps.length) {
    const job = followUps.shift()
    try {
      if (job.kind === 'reroot') record(issueOf(job.key, TREE_QUERY), nodes[job.key]?.parent ?? null)
      else if (job.kind === 'detail') {
        const raw = issueOf(job.key, DETAIL_QUERY)
        const node = nodes[job.key]
        node.labels = (raw.labels?.nodes ?? []).map((l) => l.name)
        node.blockedBy = (raw.blockedBy?.nodes ?? []).map((b) => ({ key: keyOf(b.repository?.nameWithOwner ?? node.repo, b.number), state: String(b.state || '').toLowerCase() }))
      } else if (job.kind === 'page') {
        const page = issueOf(job.key, PAGE_QUERY, { after: job.after }).subIssues
        for (const child of page.nodes) {
          const childKey = keyOf(child.repository?.nameWithOwner, child.number)
          nodes[job.key].children.push(childKey)
          nodes[childKey] = { key: childKey, parent: job.key }
          followUps.push({ kind: 'reroot', key: childKey })
        }
        if (page.pageInfo?.hasNextPage) followUps.push({ kind: 'page', key: job.key, after: page.pageInfo.endCursor })
      }
    } catch (error) {
      errors.push({ key: job.key, error: String(error?.message || error) })
    }
  }
  return { root, complete: errors.length === 0, errors, nodes }
}

export function ghGraphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`)
  const out = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }))
  if (out.errors?.length) throw new Error(out.errors.map((e) => e.message).join('; '))
  return out.data
}

if (isMainModule(import.meta.url)) {
  const i = process.argv.indexOf('--issue')
  const m = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(process.argv[i + 1] ?? '')
  if (i < 0 || !m) {
    console.error('usage: issue-tree.mjs --issue <owner/name#123>')
    process.exitCode = 2
  } else {
    const tree = fetchTree({ repo: m[1], number: Number(m[2]) })
    console.log(JSON.stringify(tree, null, 2))
    // exit 0 whenever it ran: `complete` and `errors` in the output say whether the tree is whole
  }
}
