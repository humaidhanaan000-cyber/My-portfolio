/**
 * Publishing integrations.
 *
 * AIBA only publishes through integrations the operator has explicitly
 * configured with their own credentials (stored in environment variables, never
 * in the database and never exposed to the browser). When nothing is configured
 * the platform says so plainly instead of pretending to publish.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { getDb, contentAssets, settings, storageObjects, projects } from '../db'
import { env } from '../env'
import { createLogger } from '../observability/logger'
import { hmac } from '../security/crypto'

const log = createLogger({ component: 'integrations' })

export type PublishResult = { ok: boolean; url?: string; error?: string }

export type PublishTarget = {
  name: string
  configured: boolean
  kind: 'webhook' | 'wordpress' | 'github' | 'local_export'
  description: string
  publish: (asset: typeof contentAssets.$inferSelect) => Promise<PublishResult>
}

export type PublishTargetInfo = {
  kind: PublishTarget['kind']
  name: string
  configured: boolean
  description: string
  requiredEnv: string[]
}

const SETTING_KEY = 'publishing.target'

const TARGET_ENV: Record<PublishTarget['kind'], string[]> = {
  webhook: ['PUBLISH_WEBHOOK_URL', 'PUBLISH_WEBHOOK_SECRET'],
  wordpress: ['WORDPRESS_BASE_URL', 'WORDPRESS_USER', 'WORDPRESS_APP_PASSWORD'],
  github: ['GITHUB_PUBLISH_TOKEN', 'GITHUB_PUBLISH_REPO', 'GITHUB_PUBLISH_BRANCH'],
  local_export: [],
}

function envAny(keys: string[]): boolean {
  return keys.every((key) => Boolean(process.env[key]))
}

/** The active target: explicitly selected, or the first fully-configured one. */
export async function getPublishTarget(workspaceId: string): Promise<PublishTarget> {
  const db = await getDb()
  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.workspaceId, workspaceId), eq(settings.key, SETTING_KEY)))
    .limit(1)
  const selected = (rows[0]?.value as { kind?: string } | undefined)?.kind as PublishTarget['kind'] | undefined

  const candidates = availableTargets()
  const chosen = candidates.find((t) => t.kind === selected && t.configured) ?? candidates.find((t) => t.configured)
  if (!chosen) {
    return {
      name: 'not-configured',
      configured: false,
      kind: 'local_export',
      description:
        'No publishing integration configured. Approve the content, then download the Markdown export from the project page, or configure a target in .env.',
      publish: async () => ({ ok: false, error: 'No publishing integration configured' }),
    }
  }
  return chosen
}

export function availableTargets(): PublishTarget[] {
  return [webhookTarget(), wordpressTarget(), githubTarget()]
}

export function describeTargets(): PublishTargetInfo[] {
  return availableTargets().map((target) => ({
    kind: target.kind,
    name: target.name,
    configured: target.configured,
    description: target.description,
    requiredEnv: TARGET_ENV[target.kind],
  }))
}

export async function setPublishTarget(workspaceId: string, kind: PublishTarget['kind']): Promise<void> {
  const db = await getDb()
  const existing = await db
    .select({ id: settings.id })
    .from(settings)
    .where(and(eq(settings.workspaceId, workspaceId), eq(settings.key, SETTING_KEY)))
    .limit(1)
  if (existing[0]) {
    await db.update(settings).set({ value: { kind }, updatedAt: new Date() }).where(eq(settings.id, existing[0].id))
  } else {
    await db.insert(settings).values({ workspaceId, key: SETTING_KEY, value: { kind } })
  }
}

/* ------------------------------------------------------------------ targets */

function webhookTarget(): PublishTarget {
  const required = TARGET_ENV.webhook
  return {
    kind: 'webhook',
    name: 'Webhook publishing endpoint',
    configured: envAny(required),
    description: 'POSTs each approved asset as JSON, signed with HMAC-SHA256 in the X-AIBA-Signature header.',
    async publish(asset) {
      const url = process.env.PUBLISH_WEBHOOK_URL
      const secret = process.env.PUBLISH_WEBHOOK_SECRET ?? ''
      if (!url) return { ok: false, error: 'PUBLISH_WEBHOOK_URL not set' }
      const payload = JSON.stringify({
        type: asset.type,
        title: asset.title,
        slug: asset.slug,
        summary: asset.summary,
        body: asset.body,
        format: asset.format,
        metadata: asset.metadata,
        publishedAt: new Date().toISOString(),
      })
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-aiba-signature': hmac(payload, secret),
          },
          body: payload,
        })
        if (!response.ok) return { ok: false, error: `Webhook returned HTTP ${response.status}` }
        const body = (await response.json().catch(() => ({}))) as { url?: string }
        return { ok: true, url: body.url }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function wordpressTarget(): PublishTarget {
  const required = TARGET_ENV.wordpress
  return {
    kind: 'wordpress',
    name: 'WordPress REST API',
    configured: envAny(required),
    description: 'Creates posts through the official WordPress REST API using an application password.',
    async publish(asset) {
      const base = process.env.WORDPRESS_BASE_URL
      const user = process.env.WORDPRESS_USER
      const password = process.env.WORDPRESS_APP_PASSWORD
      if (!base || !user || !password) return { ok: false, error: 'WordPress credentials incomplete' }
      const auth = Buffer.from(`${user}:${password}`).toString('base64')
      try {
        const response = await fetch(`${base.replace(/\/$/, '')}/wp-json/wp/v2/posts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
          body: JSON.stringify({
            title: asset.title,
            content: asset.body,
            slug: asset.slug,
            excerpt: asset.summary,
            status: 'draft', // the operator publishes from their own CMS
          }),
        })
        if (!response.ok) return { ok: false, error: `WordPress returned HTTP ${response.status}` }
        const body = (await response.json()) as { link?: string }
        return { ok: true, url: body.link }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function githubTarget(): PublishTarget {
  const required = TARGET_ENV.github
  return {
    kind: 'github',
    name: 'GitHub repository (static sites)',
    configured: envAny(required),
    description: 'Commits approved Markdown assets into a repository you own, e.g. for a static site or documentation folder.',
    async publish(asset) {
      const token = process.env.GITHUB_PUBLISH_TOKEN
      const repo = process.env.GITHUB_PUBLISH_REPO
      const branch = process.env.GITHUB_PUBLISH_BRANCH ?? 'main'
      const dir = process.env.GITHUB_PUBLISH_DIR ?? 'content'
      if (!token || !repo) return { ok: false, error: 'GitHub publishing credentials incomplete' }
      try {
        const filePath = `${dir}/${asset.slug || asset.id}.md`
        const content = Buffer.from(`# ${asset.title}\n\n${asset.summary}\n\n${asset.body}\n`).toString('base64')
        const url = `https://api.github.com/repos/${repo}/contents/${filePath}`
        const existing = await fetch(`${url}?ref=${branch}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        })
        let sha: string | undefined
        if (existing.ok) {
          const body = (await existing.json()) as { sha?: string }
          sha = body.sha
        }
        const response = await fetch(url, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
          body: JSON.stringify({
            message: `content: add ${asset.title.slice(0, 60)} via AIBA`,
            content,
            branch,
            ...(sha ? { sha } : {}),
          }),
        })
        if (!response.ok) return { ok: false, error: `GitHub returned HTTP ${response.status}` }
        const body = (await response.json()) as { content?: { html_url?: string } }
        return { ok: true, url: body.content?.html_url }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/* -------------------------------------------------------------- asset store */

/**
 * Persist an asset as a file in object storage so published/approved assets have
 * a stable addressable URL even without an external CDN.
 */
export async function persistAssetToStorage(input: {
  workspaceId: string
  key: string
  content: string
  contentType: string
  createdByAgent?: string
}): Promise<{ url: string; provider: string; sizeBytes: number }> {
  const buffer = Buffer.from(input.content, 'utf8')

  if (env.STORAGE_DRIVER === 'local') {
    const dir = path.resolve(env.STORAGE_LOCAL_DIR, input.workspaceId)
    mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, input.key)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, buffer)
    const url = `${env.STORAGE_PUBLIC_BASE_URL ?? '/api/storage'}/${input.workspaceId}/${input.key}`
    await recordObject(input, buffer.length, url)
    return { url, provider: 'local', sizeBytes: buffer.length }
  }

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({
    region: env.STORAGE_REGION,
    ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT, forcePathStyle: true } : {}),
    credentials: env.STORAGE_KEY && env.STORAGE_SECRET ? { accessKeyId: env.STORAGE_KEY, secretAccessKey: env.STORAGE_SECRET } : undefined,
  })
  const key = `workspaces/${input.workspaceId}/${input.key}`
  await client.send(
    new PutObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key, Body: buffer, ContentType: input.contentType }),
  )
  const url = env.STORAGE_PUBLIC_BASE_URL
    ? `${env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    : `s3://${env.STORAGE_BUCKET}/${key}`
  await recordObject({ ...input, key }, buffer.length, url)
  return { url, provider: env.STORAGE_DRIVER, sizeBytes: buffer.length }
}

async function recordObject(input: { workspaceId: string; key: string; contentType: string; createdByAgent?: string }, sizeBytes: number, url: string) {
  const db = await getDb()
  await db
    .insert(storageObjects)
    .values({
      workspaceId: input.workspaceId,
      provider: env.STORAGE_DRIVER,
      bucket: env.STORAGE_BUCKET,
      key: input.key,
      contentType: input.contentType,
      sizeBytes,
      url,
      createdByAgent: input.createdByAgent ?? null,
      isPublic: false,
    })
    .onConflictDoNothing()
}

/** Export every approved asset of a project as a single Markdown bundle. */
export async function exportProjectAssets(workspaceId: string, projectId: string): Promise<{ markdown: string; count: number }> {
  const db = await getDb()
  const project = (await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).limit(1))[0]
  if (!project) throw new Error('Project not found')
  const assets = await db
    .select()
    .from(contentAssets)
    .where(and(eq(contentAssets.projectId, projectId), eq(contentAssets.workspaceId, workspaceId)))

  const markdown = [
    `# ${project.name} — content export`,
    '',
    `Exported ${new Date().toISOString()} by AIBA. All figures in these documents are estimates.`,
    '',
    ...assets.map((asset) =>
      [`---`, '', `## ${asset.title} (${asset.type}, v${asset.version}, ${asset.status})`, '', asset.summary, '', asset.body, ''].join('\n'),
    ),
  ].join('\n')

  await persistAssetToStorage({
    workspaceId,
    key: `projects/${project.slug}/content-export-${Date.now()}.md`,
    content: markdown,
    contentType: 'text/markdown',
    createdByAgent: 'execution',
  })

  log.info('project assets exported', { projectId, count: assets.length })
  return { markdown, count: assets.length }
}
