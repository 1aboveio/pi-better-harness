// Excerpt from resolve-issues 0.36.0 ready-check.mjs; only the export used by plan-sync.
export class ReadyCheckError extends Error {}

export function parseIssueRef(text, defaultRepo = null) {
  const value = String(text ?? '').trim()
  let match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\b/.exec(value)
  if (match) return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
  match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(value)
  if (match) return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
  match = /^#?(\d+)$/.exec(value)
  if (match && defaultRepo) return { repo: defaultRepo, number: Number(match[1]) }
  throw new ReadyCheckError(`cannot read issue reference "${value}" (use owner/name#123, an issue URL, or a number with --repo)`)
}
