/**
 * Opportunity source collectors.
 *
 * Every collector uses an **official API or a published feed**. AIBA never
 * scrapes HTML that the operator is not permitted to consume, never bypasses
 * authentication, and honours `robots.txt` for any HTML fetch (see `fetchPageText`).
 *
 * Sources that require credentials are registered with
 * `permissionStatus: 'manual_only'` until the matching environment variable is
 * present, at which point they activate automatically — no code change needed.
 */
import { env } from '../../env'
import { createLogger } from '../../observability/logger'
import { fingerprint, truncate, unique } from '../../utils'

const log = createLogger({ component: 'research.sources' })

export type SourceCategory =
  | 'underserved_market'
  | 'saas_opportunity'
  | 'affiliate_opportunity'
  | 'digital_product'
  | 'lead_generation'
  | 'public_business_request'
  | 'freelance_opportunity'
  | 'local_business'
  | 'content_opportunity'
  | 'partnership'
  | 'emerging_niche'
  | 'useful_tool'
  | 'other'

export type RawSignal = {
  title: string
  description: string
  url: string
  category: SourceCategory
  tags: string[]
  region?: string
  publishedAt?: Date
  raw?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type CollectorContext = {
  config: Record<string, unknown>
  signal: AbortSignal
  limit: number
}

export type Collector = {
  key: string
  name: string
  type: 'api' | 'rss' | 'public_dataset' | 'manual' | 'partner'
  url: string
  termsUrl?: string
  permissionStatus: 'public_api' | 'permitted' | 'manual_only' | 'prohibited'
  requiresCredentials: boolean
  credentialEnvVar?: string
  credentialPresent: () => boolean
  defaultCategories: SourceCategory[]
  rateLimitPerHour: number
  reliability: number
  description: string
  collect: (ctx: CollectorContext) => Promise<RawSignal[]>
}

/* ------------------------------------------------------------------ helpers */

const USER_AGENT = env.RESEARCH_USER_AGENT

async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  if (!env.SOURCE_ALLOW_NETWORK) throw new Error('SOURCE_ALLOW_NETWORK is disabled')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000)
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    })
    if (response.status === 429) throw new Error(`Rate limited by ${new URL(url).host} (HTTP 429)`)
    if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<string> {
  if (!env.SOURCE_ALLOW_NETWORK) throw new Error('SOURCE_ALLOW_NETWORK is disabled')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000)
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml', 'user-agent': USER_AGENT, ...(init.headers ?? {}) },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/** robots.txt compliance check used before any HTML page fetch. */
export async function robotsAllows(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    const robotsUrl = `${target.origin}/robots.txt`
    const text = await fetchText(robotsUrl, { timeoutMs: 8000 })
    const lines = text.split('\n').map((l) => l.trim())
    let applies = false
    const disallow: string[] = []
    for (const line of lines) {
      if (/^user-agent:/i.test(line)) {
        const agent = line.split(':')[1]?.trim().toLowerCase() ?? ''
        applies = agent === '*' || agent.includes('aiba')
      } else if (applies && /^disallow:/i.test(line)) {
        const path = line.split(':').slice(1).join(':').trim()
        if (path) disallow.push(path)
      } else if (/^allow:/i.test(line) && applies) {
        const path = line.split(':').slice(1).join(':').trim()
        if (path && target.pathname.startsWith(path)) return true
      }
    }
    return !disallow.some((path) => target.pathname.startsWith(path))
  } catch {
    // robots.txt unreachable → fail closed for HTML scraping.
    return false
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Minimal RSS/Atom reader — no dependency, tolerant of the common dialects. */
export function parseFeed(xml: string): RawSignal[] {
  const items: RawSignal[] = []
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) ?? []
  for (const block of blocks) {
    const title = pickTag(block, 'title')
    const link = pickLink(block)
    const description = pickTag(block, 'description') || pickTag(block, 'summary') || pickTag(block, 'content')
    const published = pickTag(block, 'pubDate') || pickTag(block, 'published') || pickTag(block, 'updated')
    const categories = [...block.matchAll(/<category[^>]*?(?:term="([^"]*)"|>([^<]*)<)/gi)]
      .map((m) => (m[1] ?? m[2] ?? '').trim())
      .filter(Boolean)
    if (!title) continue
    items.push({
      title: stripHtml(title),
      description: truncate(stripHtml(description ?? ''), 1200),
      url: link,
      category: 'emerging_niche',
      tags: unique(categories).slice(0, 6),
      publishedAt: published ? new Date(published) : undefined,
      raw: { feedTitle: title },
    })
  }
  return items
}

function pickTag(block: string, tag: string): string {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(block)
  if (cdata?.[1]) return cdata[1].trim()
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  return plain?.[1]?.trim() ?? ''
}

function pickLink(block: string): string {
  const href = /<link[^>]*href="([^"]+)"/i.exec(block)
  if (href?.[1]) return href[1]
  const plain = /<link[^>]*>([^<]+)<\/link>/i.exec(block)
  return plain?.[1]?.trim() ?? ''
}

/* --------------------------------------------------------------- collectors */

/**
 * Hacker News (Algolia public API) — surfaces demand signals from public
 * discussion: "Ask HN" threads about problems people pay to solve.
 */
const hackerNews: Collector = {
  key: 'hacker_news',
  name: 'Hacker News (Algolia API)',
  type: 'api',
  url: 'https://hn.algolia.com/api/v1/search',
  termsUrl: 'https://github.com/HackerNews/API',
  permissionStatus: 'public_api',
  requiresCredentials: false,
  defaultCategories: ['saas_opportunity', 'emerging_niche', 'useful_tool'],
  rateLimitPerHour: 60,
  reliability: 78,
  description: 'Public Hacker News search API. Used to detect repeatedly-expressed pain points and tool demand.',
  credentialPresent: () => true,
  async collect({ config, signal, limit }) {
    const query = String(config.query ?? 'Ask HN how do you handle')
    const numericFilters = String(config.since ?? '')
    const url = new URL('https://hn.algolia.com/api/v1/search')
    url.searchParams.set('query', query)
    url.searchParams.set('tags', String(config.tags ?? 'story'))
    url.searchParams.set('hitsPerPage', String(Math.min(limit, 40)))
    if (numericFilters) url.searchParams.set('numericFilters', numericFilters)
    const data = await fetchJson<{ hits: { objectID: string; title?: string; story_text?: string; url?: string; created_at?: string; points?: number; num_comments?: number; _tags?: string[] }[] }>(
      url.toString(),
      { signal },
    )
    return (data.hits ?? []).map((hit) => ({
      title: hit.title ?? truncate(stripHtml(hit.story_text ?? ''), 90),
      description: truncate(stripHtml(hit.story_text ?? hit.title ?? ''), 1200),
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      category: 'emerging_niche' as SourceCategory,
      tags: unique([...(hit._tags ?? []), 'hacker-news']).slice(0, 5),
      publishedAt: hit.created_at ? new Date(hit.created_at) : undefined,
      raw: { points: hit.points, comments: hit.num_comments, objectID: hit.objectID },
    }))
  },
}

/** GitHub public search — issues labelled "help wanted" are genuine public requests. */
const githubIssues: Collector = {
  key: 'github_issues',
  name: 'GitHub Help-Wanted Issues',
  type: 'api',
  url: 'https://api.github.com/search/issues',
  termsUrl: 'https://docs.github.com/en/rest',
  permissionStatus: 'public_api',
  requiresCredentials: false,
  credentialEnvVar: 'GITHUB_TOKEN',
  defaultCategories: ['saas_opportunity', 'useful_tool', 'partnership'],
  rateLimitPerHour: 30,
  reliability: 85,
  description: 'Public GitHub REST API. "help wanted" issues reveal unmet software needs. A token raises the rate limit.',
  credentialPresent: () => true,
  async collect({ config, signal, limit }) {
    const labels = String(config.labels ?? 'help wanted')
    const query = encodeURIComponent(`${labels} ${config.query ?? 'in:title tool'} is:open is:issue`)
    const url = `https://api.github.com/search/issues?q=${query}&sort=reactions&order=desc&per_page=${Math.min(limit, 30)}`
    const data = await fetchJson<{ items: { id: number; title: string; body?: string; html_url: string; created_at: string; labels: { name: string }[]; repository_url: string; reactions?: { total_count: number } }[] }>(
      url,
      {
        signal,
        headers: env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' } : { 'x-github-api-version': '2022-11-28' },
      },
    )
    return (data.items ?? []).map((item) => ({
      title: truncate(item.title, 140),
      description: truncate(stripHtml(item.body ?? ''), 1200),
      url: item.html_url,
      category: 'public_business_request' as SourceCategory,
      tags: unique([...(item.labels ?? []).map((l) => l.name), 'github']).slice(0, 6),
      publishedAt: new Date(item.created_at),
      raw: { repository: item.repository_url, reactions: item.reactions?.total_count ?? 0 },
    }))
  },
}

/** Remotive — public remote-job API (explicitly published for programmatic use). */
const remotive: Collector = {
  key: 'remotive_jobs',
  name: 'Remotive Remote Jobs API',
  type: 'api',
  url: 'https://remotive.com/api/remote-jobs',
  termsUrl: 'https://remotive.com/remote-jobs/api',
  permissionStatus: 'public_api',
  requiresCredentials: false,
  defaultCategories: ['freelance_opportunity', 'lead_generation'],
  rateLimitPerHour: 12,
  reliability: 72,
  description: 'Published remote-jobs API. Used to detect which skills are in demand and at what rate.',
  credentialPresent: () => true,
  async collect({ config, signal, limit }) {
    const url = new URL('https://remotive.com/api/remote-jobs')
    if (config.category) url.searchParams.set('category', String(config.category))
    if (config.search) url.searchParams.set('search', String(config.search))
    url.searchParams.set('limit', String(Math.min(limit, 50)))
    const data = await fetchJson<{ jobs: { id: number; title: string; description: string; company_name: string; category: string; job_type: string; candidate_required_location: string; url: string; publication_date: string; salary?: string; tags?: string[] }[] }>(url.toString(), { signal })
    return (data.jobs ?? []).map((job) => ({
      title: `${job.title} — ${job.company_name}`,
      description: truncate(`${stripHtml(job.description)} ${job.salary ? `Compensation signal: ${job.salary}.` : ''}`, 1200),
      url: job.url,
      category: 'freelance_opportunity' as SourceCategory,
      tags: unique([job.category, job.job_type, ...(job.tags ?? [])].filter(Boolean)).slice(0, 6),
      region: job.candidate_required_location,
      publishedAt: job.publication_date ? new Date(job.publication_date) : undefined,
      raw: { company: job.company_name, salary: job.salary ?? null },
    }))
  },
}

/** Arbeitnow — public job-board API with a simple CC-style licence. */
const arbeitnow: Collector = {
  key: 'arbeitnow_jobs',
  name: 'Arbeitnow Job Board API',
  type: 'api',
  url: 'https://www.arbeitnow.com/api/job-board-api',
  termsUrl: 'https://www.arbeitnow.com/',
  permissionStatus: 'public_api',
  requiresCredentials: false,
  defaultCategories: ['freelance_opportunity', 'local_business'],
  rateLimitPerHour: 12,
  reliability: 68,
  description: 'Public job-board API. Shows which roles employers repeatedly struggle to fill.',
  credentialPresent: () => true,
  async collect({ signal, limit }) {
    const data = await fetchJson<{ data: { slug: string; title: string; description: string; company_name: string; tags: string[]; job_types: string[]; location: string; url: string; created_at: number; remote: boolean }[] }>(
      'https://www.arbeitnow.com/api/job-board-api',
      { signal },
    )
    return (data.data ?? []).slice(0, Math.min(limit, 50)).map((job) => ({
      title: `${job.title} — ${job.company_name}`,
      description: truncate(stripHtml(job.description), 1200),
      url: job.url,
      category: (job.remote ? 'freelance_opportunity' : 'local_business') as SourceCategory,
      tags: unique([...(job.tags ?? []), ...(job.job_types ?? []), 'jobs']).slice(0, 6),
      region: job.location,
      publishedAt: job.created_at ? new Date(job.created_at * 1000) : undefined,
      raw: { remote: job.remote },
    }))
  },
}

/** Product Hunt — GraphQL API. Activates only when PRODUCTHUNT_TOKEN is set. */
const productHunt: Collector = {
  key: 'product_hunt',
  name: 'Product Hunt GraphQL API',
  type: 'api',
  url: 'https://api.producthunt.com/v2/api/graphql',
  termsUrl: 'https://api.producthunt.com/v2/docs',
  permissionStatus: 'public_api',
  requiresCredentials: true,
  credentialEnvVar: 'PRODUCTHUNT_TOKEN',
  defaultCategories: ['saas_opportunity', 'emerging_niche'],
  rateLimitPerHour: 20,
  reliability: 80,
  description: 'Official Product Hunt API: what is shipping, and what categories are heating up.',
  credentialPresent: () => Boolean(env.PRODUCTHUNT_TOKEN),
  async collect({ signal, limit }) {
    if (!env.PRODUCTHUNT_TOKEN) throw new Error('PRODUCTHUNT_TOKEN not configured')
    const query = `query($first:Int!){ posts(first:$first, order:VOTES){ edges{ node{ name tagline description url website votesCount createdAt topics{ edges{ node{ name } } } } } } }`
    const data = await fetchJson<{ data?: { posts: { edges: { node: { name: string; tagline: string; description: string; url: string; votesCount: number; createdAt: string; topics: { edges: { node: { name: string } }[] } } }[] } }; errors?: { message: string }[] }>(
      'https://api.producthunt.com/v2/api/graphql',
      {
        method: 'POST',
        signal,
        headers: { authorization: `Bearer ${env.PRODUCTHUNT_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { first: Math.min(limit, 20) } }),
      },
    )
    if (data.errors?.length) throw new Error(data.errors[0]!.message)
    return (data.data?.posts.edges ?? []).map(({ node }) => ({
      title: truncate(node.name, 120),
      description: truncate(stripHtml(`${node.tagline}\n\n${node.description ?? ''}`), 1200),
      url: node.url,
      category: 'saas_opportunity' as SourceCategory,
      tags: unique([...(node.topics.edges ?? []).map((t) => t.node.name), 'product-hunt']).slice(0, 6),
      publishedAt: node.createdAt ? new Date(node.createdAt) : undefined,
      raw: { votes: node.votesCount },
    }))
  },
}

/** Configurable RSS/Atom feeds — the operator supplies URLs they may consume. */
const rssFeeds: Collector = {
  key: 'rss_feeds',
  name: 'Custom RSS/Atom Feeds',
  type: 'rss',
  url: 'config:feeds',
  permissionStatus: 'permitted',
  requiresCredentials: false,
  defaultCategories: ['emerging_niche', 'content_opportunity'],
  rateLimitPerHour: 60,
  reliability: 65,
  description: 'Any feed URLs you add in source configuration. Published feeds are intended for syndication.',
  credentialPresent: () => true,
  async collect({ config, signal, limit }) {
    const feeds = Array.isArray(config.feeds) ? (config.feeds as string[]) : []
    if (feeds.length === 0) return []
    const perFeed = Math.max(3, Math.ceil(limit / feeds.length))
    const results: RawSignal[] = []
    for (const feed of feeds.slice(0, 10)) {
      try {
        const xml = await fetchText(feed, { signal })
        const items = parseFeed(xml).slice(0, perFeed)
        results.push(
          ...items.map((item) => ({
            ...item,
            // Category is decided by the cleaning/analysis stage; feed items are
            // generic signals until then.
            metadata: { feedUrl: feed },
          })),
        )
      } catch (error) {
        log.warn('feed failed', { feed, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  },
}

/**
 * Google Trends "daily trending searches" is not an official API, so AIBA
 * instead offers this manual/partner source: the operator pastes public
 * research they have legitimately collected (search results, marketplace
 * listings, survey data). It is deliberately not automated.
 */
const manualResearch: Collector = {
  key: 'manual_research',
  name: 'Manual / partner research entries',
  type: 'manual',
  url: 'app:manual',
  permissionStatus: 'manual_only',
  requiresCredentials: false,
  defaultCategories: ['underserved_market', 'local_business', 'partnership'],
  rateLimitPerHour: 240,
  reliability: 90,
  description: 'Opportunities you add yourself (from sales calls, marketplaces, communities). Highest-trust source.',
  credentialPresent: () => true,
  async collect() {
    return []
  },
}

export const COLLECTORS: Collector[] = [
  hackerNews,
  githubIssues,
  remotive,
  arbeitnow,
  productHunt,
  rssFeeds,
  manualResearch,
]

export function collector(key: string): Collector | undefined {
  return COLLECTORS.find((c) => c.key === key)
}

/** Default source rows seeded into every workspace. */
export function defaultSourceConfigs() {
  return COLLECTORS.map((c) => ({
    name: c.name,
    type: c.type,
    url: c.url,
    permissionStatus: c.permissionStatus,
    termsUrl: c.termsUrl ?? null,
    requiresCredentials: c.requiresCredentials,
    credentialEnvVar: c.credentialEnvVar ?? null,
    rateLimitPerHour: c.rateLimitPerHour,
    reliabilityScore: String(c.reliability),
    categories: c.defaultCategories as string[],
    enabled: !c.requiresCredentials || c.credentialPresent(),
    config: {
      collector: c.key,
      description: c.description,
      feeds: c.key === 'rss_feeds' ? ([] as string[]) : undefined,
      query:
        c.key === 'hacker_news'
          ? 'Ask HN how do you handle'
          : c.key === 'github_issues'
            ? 'tool pricing automation'
            : undefined,
    } as Record<string, unknown>,
  }))
}

export { fetchJson, fetchText, stripHtml }

/** Build a stable dedupe fingerprint for a collected signal. */
export function signalFingerprint(signal: RawSignal): string {
  return fingerprint(signal.title, signal.url.split('?')[0])
}
