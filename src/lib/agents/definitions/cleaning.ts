/**
 * AGENT 2 — DATA CLEANING AGENT
 *
 * Normalises records, removes duplicates, flags spam/irrelevant/expired entries,
 * validates URLs and recalculates source reliability. Nothing reaches the
 * analysis agent without passing through here, so scoring is never polluted by
 * malformed or stale records.
 */
import { z } from 'zod'
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb, opportunities, sources } from '../../db'
import { truncate } from '../../utils'
import type { AgentDefinition, AgentOutput } from '../types'

export const cleaningInputSchema = z.object({
  opportunityIds: z.array(z.string().uuid()).optional(),
  batchSize: z.number().int().min(1).max(500).default(120),
  checkUrls: z.boolean().default(true),
})
export type CleaningInput = z.infer<typeof cleaningInputSchema>

export type CleaningOutput = {
  processed: number
  normalized: number
  duplicatesRemoved: number
  spamFlagged: number
  irrelevantFlagged: number
  expiredFlagged: number
  invalidUrls: number
  reliabilityUpdated: number
}

const SPAM_PATTERNS: RegExp[] = [
  /\b(click here|buy now|limited time offer|act fast|100% free money)\b/i,
  /\b(guaranteed\s+(income|profit|returns?))\b/i,
  /\b(crypto|forex|binary options)\s+(signals?|bot|pump)\b/i,
  /\b(work from home|make \$?\d+k? (a|per) (day|week))\b/i,
  /\b(no experience needed|instant approval|dm me|whatsapp \+\d+)\b/i,
  /(https?:\/\/\S+){3,}/i,
]

const IRRELEVANT_PATTERNS: RegExp[] = [
  /\b(casino|betting odds|adult content|essay writing service|assignment help)\b/i,
  /\b(free robux|free vbucks|gift card generator)\b/i,
]

export const cleaningAgent: AgentDefinition<CleaningInput, CleaningOutput> = {
  key: 'cleaning',
  name: 'Data Cleaning Agent',
  description: 'Normalises, de-duplicates, spam-filters, validates and expires opportunity records.',
  category: 'discovery',
  policyAction: 'clean_data',
  estimatedCostCents: 5,
  modelTier: 'cheap',
  timeoutSeconds: 180,
  cadenceMinutes: 180,
  requiresWorkspace: true,
  inputSchema: cleaningInputSchema,

  async run(input, ctx): Promise<AgentOutput<CleaningOutput>> {
    const db = await getDb()
    const limit = input.batchSize

    const rows = await db
      .select()
      .from(opportunities)
      .where(
        input.opportunityIds?.length
          ? and(eq(opportunities.workspaceId, ctx.workspaceId), inArray(opportunities.id, input.opportunityIds))
          : and(eq(opportunities.workspaceId, ctx.workspaceId), eq(opportunities.status, 'discovered'), isNull(opportunities.deletedAt)),
      )
      .limit(limit)

    let normalized = 0
    let duplicatesRemoved = 0
    let spamFlagged = 0
    let irrelevantFlagged = 0
    let expiredFlagged = 0
    let invalidUrls = 0
    const notes: string[] = []

    // Duplicate detection inside the batch: same normalised title, different id.
    const titleIndex = new Map<string, string>()

    for (const row of rows) {
      const title = row.title.replace(/\s+/g, ' ').trim()
      const description = row.description.replace(/\r\n/g, '\n').trim()
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, '')

      const patch: Record<string, unknown> = {}
      if (title !== row.title || description !== row.description) {
        patch.title = truncate(title, 200)
        patch.description = truncate(description, 4000)
        normalized++
      }

      // Semantic duplicate: an earlier record with the same normalised title.
      const priorId = titleIndex.get(normalizedTitle)
      if (priorId) {
        await db
          .update(opportunities)
          .set({
            ...patch,
            status: 'archived',
            isDuplicateOf: priorId,
            relevancyScore: '0',
            updatedAt: new Date(),
          })
          .where(eq(opportunities.id, row.id))
        duplicatesRemoved++
        continue
      }
      titleIndex.set(normalizedTitle, row.id)

      // Cross-batch duplicate: same normalised title already stored.
      const existing = await db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.workspaceId, ctx.workspaceId),
            eq(opportunities.status, 'cleaned'),
            sql`lower(regexp_replace(${opportunities.title}, '[^a-zA-Z0-9 ]', '', 'g')) = ${normalizedTitle}`,
            sql`${opportunities.id} <> ${row.id}`,
          ),
        )
        .limit(1)
      if (existing[0]) {
        await db
          .update(opportunities)
          .set({ ...patch, status: 'archived', isDuplicateOf: existing[0].id, relevancyScore: '0', updatedAt: new Date() })
          .where(eq(opportunities.id, row.id))
        duplicatesRemoved++
        continue
      }

      const text = `${title}\n${description}`
      let spamScore = 0
      for (const pattern of SPAM_PATTERNS) if (pattern.test(text)) spamScore += 25
      if (row.sourceName.toLowerCase().includes('ai-extracted')) spamScore += 5

      let relevancyScore = 60
      if (description.length > 200) relevancyScore += 12
      if (description.length < 60) relevancyScore -= 20
      if (row.url) relevancyScore += 8
      if (row.category && row.category !== 'other') relevancyScore += 6
      if (/[?!]/.test(title)) relevancyScore += 4
      for (const pattern of IRRELEVANT_PATTERNS) if (pattern.test(text)) relevancyScore = 0

      // Expiry: published more than 180 days ago and still labelled "urgent"-ish.
      let expired = false
      const discovered = new Date(row.discoveredAt).getTime()
      if (Date.now() - discovered > 180 * 86_400_000) {
        expired = true
        expiredFlagged++
      }

      // URL validation (HEAD request, no body download, honours network switch).
      let urlValid = row.urlValid
      if (input.checkUrls && row.url && !row.url.startsWith('app:')) {
        urlValid = await validateUrl(row.url)
        if (!urlValid) invalidUrls++
      }

      const status =
        spamScore >= 50 || relevancyScore < 25 || expired
          ? 'archived'
          : 'cleaned'
      if (spamScore >= 50) spamFlagged++
      if (relevancyScore < 25 && spamScore < 50) irrelevantFlagged++

      await db
        .update(opportunities)
        .set({
          ...patch,
          status,
          spamScore: spamScore.toFixed(2),
          relevancyScore: Math.max(0, Math.min(100, relevancyScore)).toFixed(2),
          urlValid,
          cleanedAt: new Date(),
          expiresAt: expired ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(opportunities.id, row.id))
    }

    const reliabilityUpdated = await recalculateSourceReliability(ctx.workspaceId)

    notes.push(`${rows.length} record(s) processed; ${duplicatesRemoved} duplicate(s) archived.`)
    if (spamFlagged) notes.push(`${spamFlagged} spam-flagged record(s) excluded from analysis.`)
    if (expiredFlagged) notes.push(`${expiredFlagged} record(s) older than 180 days archived as expired.`)
    if (invalidUrls) notes.push(`${invalidUrls} record(s) have unreachable URLs and are marked accordingly.`)

    return {
      data: {
        processed: rows.length,
        normalized,
        duplicatesRemoved,
        spamFlagged,
        irrelevantFlagged,
        expiredFlagged,
        invalidUrls,
        reliabilityUpdated,
      },
      summary: `Cleaned ${rows.length} record(s): ${normalized} normalised, ${duplicatesRemoved} duplicates, ${spamFlagged} spam, ${expiredFlagged} expired.`,
      notes,
      metrics: { processed: rows.length, duplicatesRemoved, spamFlagged, expiredFlagged },
    }
  },
}

async function validateUrl(url: string): Promise<boolean> {
  const { env } = await import('../../env')
  if (!env.SOURCE_ALLOW_NETWORK) return true
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': env.RESEARCH_USER_AGENT },
      })
      if (response.status === 405 || response.status === 501) return true // HEAD unsupported, assume live
      return response.status < 400
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * Source reliability = f(signal quality, URL validity, historical yield).
 * Feeds the research agent's source ordering and the scoring engine's trust bias.
 */
async function recalculateSourceReliability(workspaceId: string): Promise<number> {
  const db = await getDb()
  const rows = await db.execute(sql`
    select
      s.id,
      s.name,
      count(o.id) as total,
      count(*) filter (where o.url_valid) as valid_urls,
      count(*) filter (where o.spam_score::numeric < 50) as clean,
      count(*) filter (where o.status in ('scored','strategy_ready','approved')) as progressed,
      count(*) filter (where o.relevancy_score::numeric >= 60) as relevant
    from sources s
    left join opportunities o on o.source_id = s.id
    where s.workspace_id = ${workspaceId}
    group by s.id, s.name
  `)
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
    id: string
    total: string
    valid_urls: string
    clean: string
    progressed: string
    relevant: string
  }[]

  let updated = 0
  for (const row of list) {
    const total = Number(row.total)
    if (total === 0) continue
    const validRatio = Number(row.valid_urls) / total
    const cleanRatio = Number(row.clean) / total
    const relevantRatio = Number(row.relevant) / total
    const progressedRatio = Number(row.progressed) / total
    // Weighted blend, expressed 0-100. Volume adds a small confidence bonus.
    const score =
      100 *
      (0.25 * validRatio + 0.3 * cleanRatio + 0.3 * relevantRatio + 0.15 * Math.min(1, progressedRatio * 4)) *
      (0.85 + Math.min(0.15, total / 400))
    await db
      .update(sources)
      .set({ reliabilityScore: Math.min(100, Math.max(0, score)).toFixed(2), updatedAt: new Date() })
      .where(eq(sources.id, row.id))
    updated++
  }
  return updated
}

/** Housekeeping used by the scheduler: purge soft-deleted rows past retention. */
export async function purgeExpiredData(retentionDays = 180): Promise<{ opportunitiesPurged: number }> {
  const db = await getDb()
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const purged = await db
    .delete(opportunities)
    .where(and(eq(opportunities.status, 'archived'), or(lt(opportunities.updatedAt, cutoff), eq(opportunities.urlValid, false))))
    .returning({ id: opportunities.id })
  return { opportunitiesPurged: purged.length }
}
