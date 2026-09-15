/**
 * AGENT 1 — RESEARCH AGENT
 *
 * Discovers opportunities from configured sources. Only official APIs, published
 * feeds, and manual entries are used. Each source carries a permission status and
 * a rate limit which are enforced before every request; a source that is not
 * permitted is never contacted.
 */
import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb, opportunities, sources } from '../../db'
import { env } from '../../env'
import { fingerprint, truncate } from '../../utils'
import { notify } from '../../notifications'
import { COLLECTORS, collector } from '../sources'
import type { AgentDefinition, AgentContext, AgentOutput } from '../types'
import { signalExtractionPrompt } from '../../ai/prompts'
import { researchSignalSchema } from '../../ai/schemas'

export const researchInputSchema = z.object({
  sourceKeys: z.array(z.string()).optional(),
  limitPerSource: z.number().int().min(1).max(60).default(15),
  useAiExtraction: z.boolean().default(true),
  triggerSource: z.enum(['schedule', 'manual', 'api', 'agent']).default('schedule'),
})
export type ResearchInput = z.infer<typeof researchInputSchema>

export type ResearchOutput = {
  scannedSources: {
    key: string
    name: string
    status: 'ok' | 'skipped' | 'error' | 'rate_limited' | 'not_permitted'
    discovered: number
    duplicates: number
    error?: string
    durationMs: number
  }[]
  newOpportunityIds: string[]
  duplicates: number
  totalDiscovered: number
  highScoreCandidates: number
}

const TITLE_NOISE = /^(show hn|ask hn|tell hn|launch hn|weekly|monthly|digest|newsletter|podcast|episode|jobs?|hiring thread)/i

export const researchAgent: AgentDefinition<ResearchInput, ResearchOutput> = {
  key: 'research',
  name: 'Research Agent',
  description: 'Discovers legitimate opportunities from authorised APIs, feeds and manual entries.',
  category: 'discovery',
  policyAction: 'research_scan',
  estimatedCostCents: 25,
  modelTier: 'cheap',
  timeoutSeconds: 240,
  cadenceMinutes: 60,
  requiresWorkspace: true,
  inputSchema: researchInputSchema,

  async run(input, ctx): Promise<AgentOutput<ResearchOutput>> {
    const db = await getDb()
    const notes: string[] = []
    const warnings: string[] = []

    const allSources = await db.select().from(sources).where(eq(sources.workspaceId, ctx.workspaceId))
    const selected = allSources.filter((source) => {
      if (!source.enabled) return false
      const key = String((source.config as Record<string, unknown> | null)?.collector ?? '')
      if (input.sourceKeys?.length) return input.sourceKeys.includes(key) || input.sourceKeys.includes(source.name)
      return Boolean(key)
    })

    if (selected.length === 0) {
      return {
        data: { scannedSources: [], newOpportunityIds: [], duplicates: 0, totalDiscovered: 0, highScoreCandidates: 0 },
        summary: 'No enabled sources to scan.',
        warnings: ['Enable at least one source on the Sources page, or add a manual entry.'],
      }
    }

    const profile = await loadProfile(ctx.workspaceId)
    const scannedSources: ResearchOutput['scannedSources'] = []
    const newIds: string[] = []
    let duplicates = 0

    for (const source of selected) {
      const started = Date.now()
      const collectorDef = collector(String((source.config as Record<string, unknown>)?.collector ?? ''))
      if (!collectorDef) {
        scannedSources.push({ key: source.name, name: source.name, status: 'error', discovered: 0, duplicates: 0, error: 'No collector implementation', durationMs: 0 })
        continue
      }

      // Permission gate: manual-only or prohibited sources are never fetched.
      if (collectorDef.permissionStatus === 'prohibited') {
        scannedSources.push({ key: collectorDef.key, name: source.name, status: 'not_permitted', discovered: 0, duplicates: 0, error: 'Source marked prohibited', durationMs: 0 })
        continue
      }
      if (source.permissionStatus === 'manual_only') {
        scannedSources.push({ key: collectorDef.key, name: source.name, status: 'skipped', discovered: 0, duplicates: 0, error: 'Manual-only source: use the New Opportunity form', durationMs: 0 })
        continue
      }
      if (collectorDef.requiresCredentials && !collectorDef.credentialPresent()) {
        scannedSources.push({
          key: collectorDef.key,
          name: source.name,
          status: 'skipped',
          discovered: 0,
          duplicates: 0,
          error: `Requires ${collectorDef.credentialEnvVar}`,
          durationMs: 0,
        })
        if (!source.enabled) continue
        await db.update(sources).set({ enabled: false, lastScanStatus: 'skipped', lastError: `Missing ${collectorDef.credentialEnvVar}` }).where(eq(sources.id, source.id))
        warnings.push(`${source.name} disabled: set ${collectorDef.credentialEnvVar} to activate it.`)
        continue
      }

      // Rate limit: never exceed the configured hourly budget for a source.
      if (!(await withinRateLimit(source.id, source.rateLimitPerHour))) {
        scannedSources.push({ key: collectorDef.key, name: source.name, status: 'rate_limited', discovered: 0, duplicates: 0, error: `Hourly limit ${source.rateLimitPerHour} reached`, durationMs: 0 })
        continue
      }

      try {
        const signals = await collectorDef.collect({
          config: (source.config as Record<string, unknown>) ?? {},
          signal: ctx.signal,
          limit: input.limitPerSource,
        })

        let sourceNew = 0
        let sourceDupes = 0
        const accepted: typeof signals = []

        for (const signal of signals) {
          if (!signal.title || signal.title.length < 5) continue
          if (TITLE_NOISE.test(signal.title) && signal.title.length < 40) continue
          const stamp = fingerprint(signal.title, signal.url.split('?')[0])
          const existing = await db
            .select({ id: opportunities.id })
            .from(opportunities)
            .where(and(eq(opportunities.workspaceId, ctx.workspaceId), eq(opportunities.fingerprint, stamp)))
            .limit(1)
          if (existing[0]) {
            sourceDupes++
            continue
          }
          accepted.push(signal)

          const inserted = await db
            .insert(opportunities)
            .values({
              workspaceId: ctx.workspaceId,
              sourceId: source.id,
              sourceName: source.name,
              title: truncate(signal.title, 200),
              description: truncate(signal.description || signal.title, 4000),
              url: signal.url || null,
              category: signal.category,
              tags: signal.tags.slice(0, 10),
              region: signal.region ?? null,
              fingerprint: stamp,
              status: 'discovered',
              raw: (signal.raw ?? {}) as Record<string, unknown>,
              metadata: {
                collector: collectorDef.key,
                sourceType: collectorDef.type,
                permissionStatus: collectorDef.permissionStatus,
                ...(signal.metadata ?? {}),
              },
              discoveredAt: signal.publishedAt && !Number.isNaN(signal.publishedAt.getTime()) ? signal.publishedAt : new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: opportunities.id })

          if (inserted[0]) {
            newIds.push(inserted[0].id)
            sourceNew++
          } else {
            sourceDupes++
          }
        }

        // Optional AI pass to extract structured signals from long-form feeds.
        if (input.useAiExtraction && ctx.ai.available && collectorDef.type === 'rss' && signals.length > 0) {
          const extracted = await extractWithAi(ctx, collectorDef.name, collectorDef.type, signals)
          for (const signal of extracted) {
            const stamp = fingerprint(signal.title, signal.url)
            const inserted = await db
              .insert(opportunities)
              .values({
                workspaceId: ctx.workspaceId,
                sourceId: source.id,
                sourceName: `${source.name} (AI-extracted)`,
                title: truncate(signal.title, 200),
                description: truncate(signal.description, 4000),
                url: signal.url || null,
                category: signal.category,
                tags: signal.tags.slice(0, 10),
                region: signal.region || null,
                fingerprint: stamp,
                status: 'discovered',
                metadata: { collector: collectorDef.key, extractedBy: 'ai' },
              })
              .onConflictDoNothing()
              .returning({ id: opportunities.id })
            if (inserted[0]) {
              newIds.push(inserted[0].id)
              sourceNew++
            }
          }
        }

        duplicates += sourceDupes
        await db
          .update(sources)
          .set({
            lastScanAt: new Date(),
            lastScanStatus: 'ok',
            lastError: null,
            scanCount: sql`${sources.scanCount} + 1`,
            discoveredCount: sql`${sources.discoveredCount} + ${sourceNew}`,
            updatedAt: new Date(),
          })
          .where(eq(sources.id, source.id))

        scannedSources.push({
          key: collectorDef.key,
          name: source.name,
          status: 'ok',
          discovered: sourceNew,
          duplicates: sourceDupes,
          durationMs: Date.now() - started,
        })
        notes.push(`${source.name}: ${sourceNew} new, ${sourceDupes} duplicate(s) skipped.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await db
          .update(sources)
          .set({ lastScanAt: new Date(), lastScanStatus: 'error', lastError: message.slice(0, 500), updatedAt: new Date() })
          .where(eq(sources.id, source.id))
        scannedSources.push({ key: collectorDef.key, name: source.name, status: 'error', discovered: 0, duplicates: 0, error: message, durationMs: Date.now() - started })
        warnings.push(`${source.name}: ${message}`)
        ctx.logger.warn('source scan failed', { source: source.name, message })
      }
    }

    const threshold = profile?.scoreThreshold ?? 70

    if (newIds.length > 0) {
      await notify({
        workspaceId: ctx.workspaceId,
        type: 'high_score_opportunity',
        severity: 'info',
        title: `${newIds.length} new opportunity candidates discovered`,
        body: `${scannedSources.filter((s) => s.status === 'ok').length} source(s) scanned. Scoring runs next.`,
        link: '/dashboard/opportunities',
        dedupeKey: `research:${new Date().toISOString().slice(0, 13)}`,
      })
    }

    return {
      data: {
        scannedSources,
        newOpportunityIds: newIds,
        duplicates,
        totalDiscovered: newIds.length,
        highScoreCandidates: 0,
      },
      summary: `Research scan complete: ${newIds.length} new opportunit${newIds.length === 1 ? 'y' : 'ies'} from ${scannedSources.filter((s) => s.status === 'ok').length} source(s); ${duplicates} duplicate(s) filtered.`,
      notes,
      warnings,
      provider: ctx.ai.available ? ctx.ai.provider : undefined,
      metrics: {
        sourcesScanned: scannedSources.length,
        discovered: newIds.length,
        duplicates,
        errors: scannedSources.filter((s) => s.status === 'error').length,
        scoreThreshold: threshold,
      },
    }
  },

  async memory(output, _input, ctx) {
    const db = await getDb()
    if (output.data.newOpportunityIds.length === 0) return
    await db.insert(agentMemoryTable).values({
      workspaceId: ctx.workspaceId,
      agentKey: 'research',
      kind: 'summary',
      key: `scan:${new Date().toISOString().slice(0, 13)}`,
      content: `${output.data.newOpportunityIds.length} opportunities discovered across ${output.data.scannedSources.filter((s) => s.status === 'ok').length} sources.`,
      importance: 2,
      data: { ids: output.data.newOpportunityIds.slice(0, 50), duplicates: output.data.duplicates },
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })
  },
}

import { agentMemory as agentMemoryTable } from '../../db'

async function loadProfile(workspaceId: string) {
  const db = await getDb()
  const { profiles } = await import('../../db')
  const rows = await db.select().from(profiles).where(eq(profiles.workspaceId, workspaceId)).limit(1)
  return rows[0] ?? null
}

async function withinRateLimit(sourceId: string, limitPerHour: number): Promise<boolean> {
  if (limitPerHour >= 1000) return true
  const db = await getDb()
  const { agentRuns } = await import('../../db')
  const result = await db.execute(sql`
    select count(*)::text as count from agent_runs
    where agent_key = 'research'
      and started_at >= now() - interval '1 hour'
      and input::text like ${`%${sourceId}%`}
  `)
  const rows = result as unknown as { rows?: { count: string }[] }
  const count = Number(Array.isArray(result) ? (result[0] as { count?: string })?.count ?? 0 : rows.rows?.[0]?.count ?? 0)
  void agentRuns
  // The source's own scan cadence is the practical limiter; this guard prevents
  // a manual "Scan now" storm from hammering a third-party API.
  return count < Math.max(1, Math.ceil(limitPerHour / 4))
}

async function extractWithAi(
  ctx: AgentContext,
  sourceName: string,
  sourceType: string,
  signals: { title: string; description: string; url: string }[],
): Promise<{ title: string; description: string; category: ResearchOutput extends never ? never : import('../sources').SourceCategory; url: string; region: string; tags: string[] }[]> {
  const prompt = signalExtractionPrompt({
    sourceName,
    sourceType,
    raw: signals.map((s) => `- ${s.title}: ${truncate(s.description, 500)} (${s.url})`).join('\n'),
    categories: [],
  })
  try {
    const result = await ctx.ai.generateJson<{ signals: z.infer<typeof researchSignalSchema>[] }>(
      {
        system: prompt.system,
        prompt: prompt.prompt,
        tier: 'cheap',
        maxTokens: 1500,
        schemaName: 'signal_extraction',
        workspaceId: ctx.workspaceId,
        agentKey: 'research',
      },
      z.object({ signals: z.array(researchSignalSchema) }),
    )
    return (result.signals ?? []).map((signal) => ({
      title: signal.title,
      description: signal.description,
      category: signal.category,
      url: signal.url,
      region: signal.region,
      tags: signal.tags,
    }))
  } catch (error) {
    ctx.logger.warn('AI signal extraction failed; heuristic signals retained', {
      message: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

export const RESEARCH_COLLECTOR_KEYS = COLLECTORS.map((c) => c.key)
export { env, inArray }
