/**
 * github-connector — Fetch GitHub issues and PRs as ConnectorItems.
 *
 * Tries `gh` CLI first (zero-config if authed), falls back to GitHub
 * REST API via fetch (requires `token` in config). Returns empty array
 * with a warning log when neither is available.
 */

import { execSync } from 'node:child_process'
import type { ConnectorConfig, ConnectorItem, KnowledgeConnector } from './types.js'

// ─────────────────────────────────────────────────────────
// GitHub issue shape from gh CLI
// ─────────────────────────────────────────────────────────

interface GhIssue {
  number: number
  title: string
  body: string | null
  updatedAt: string
  url: string
  state: string
  labels?: Array<{ name: string }>
}

// ─────────────────────────────────────────────────────────
// GitHubConnector
// ─────────────────────────────────────────────────────────

export class GitHubConnector implements KnowledgeConnector {
  readonly type = 'github'

  async fetchItems(config: ConnectorConfig): Promise<ConnectorItem[]> {
    const repo = config.config.repo as string | undefined
    if (!repo) {
      console.warn('GitHub connector: missing "repo" in config (expected "owner/repo")')
      return []
    }

    // Try gh CLI first
    try {
      return this.fetchViaCli(repo)
    } catch (err) {
      console.warn("fetchViaCli failed", err);
    }

    // Try REST API
    const token = config.config.token as string | undefined
    if (token) {
      try {
        return await this.fetchViaApi(repo, token)
      } catch (err) {
        console.warn(`GitHub connector: API fetch failed for ${repo}: ${err instanceof Error ? err.message : err}`)
        return []
      }
    }

    console.warn(`GitHub connector: no gh CLI and no token for ${repo} — skipping`)
    return []
  }

  transformToNodes(items: ConnectorItem[]): Array<{ path: string; content: string; metadata: Record<string, unknown> }> {
    return items.map((item) => ({
      path: `github:${item.source}/issues/${item.id}`,
      content: `# ${item.title}\n\n${item.content}`,
      metadata: {
        source: item.source,
        url: item.url,
        updatedAt: item.updatedAt,
        ...item.metadata,
      },
    }))
  }

  transformToEdges(_items: ConnectorItem[]): Array<{ fromPath: string; toPath: string; edgeType: string }> {
    return []
  }

  // ── Private helpers ──

  private fetchViaCli(repo: string): ConnectorItem[] {
    const json = execSync(
      `gh issue list --repo ${repo} --state open --json number,title,body,updatedAt,url,state,labels --limit 100`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const issues: GhIssue[] = JSON.parse(json)
    return issues.map((issue) => ({
      id: String(issue.number),
      source: repo,
      title: issue.title,
      content: issue.body ?? '',
      url: issue.url,
      updatedAt: issue.updatedAt,
      metadata: {
        state: issue.state,
        labels: issue.labels?.map((l) => l.name) ?? [],
      },
    }))
  }

  private async fetchViaApi(repo: string, token: string): Promise<ConnectorItem[]> {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    })

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${res.statusText}`)
    }

    const issues = await res.json() as Array<Record<string, unknown>>
    return issues.map((issue) => ({
      id: String(issue.number),
      source: repo,
      title: issue.title as string,
      content: (issue.body as string) ?? '',
      url: issue.html_url as string,
      updatedAt: issue.updated_at as string,
      metadata: {
        state: issue.state,
        labels: (issue.labels as Array<Record<string, unknown>>)?.map((l) => l.name) ?? [],
      },
    }))
  }
}
