/**
 * AI provider abstraction.
 *
 * Every agent talks to `generateJson()` / `generateText()` and never to a
 * vendor SDK directly. Providers are selected by environment configuration, so
 * switching from OpenAI to Anthropic to a local Ollama model is a `.env` change
 * and nothing else. When no provider is configured the platform stays fully
 * functional using the deterministic heuristic engines in `src/lib/agents`.
 */
import { z } from 'zod'
import { env, resolveAiKey, resolveAiProvider } from '../env'
import { createLogger, persistLog } from '../observability/logger'

const log = createLogger({ component: 'ai' })

export type ModelTier = 'cheap' | 'standard' | 'reasoning'

export type GenerateRequest = {
  system?: string
  prompt: string
  tier?: ModelTier
  maxTokens?: number
  temperature?: number
  json?: boolean
  schemaName?: string
  timeoutMs?: number
  workspaceId?: string | null
  agentKey?: string | null
}

export type GenerateResult = {
  text: string
  data?: unknown
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costCents: number
  latencyMs: number
  finishReason?: string
}

export class AiUnavailableError extends Error {
  constructor(message = 'No AI provider configured') {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

export class AiResponseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message)
    this.name = 'AiResponseError'
  }
}

/* ------------------------------------------------------------ price catalog */

/** USD per 1M tokens. Update here when vendor pricing changes. */
const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'anthropic/claude-3.5-haiku': { input: 0.8, output: 4 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'meta-llama/llama-3.1-8b-instruct': { input: 0.06, output: 0.06 },
  'llama3.1': { input: 0, output: 0 },
  'qwen2.5:7b': { input: 0, output: 0 },
}

export function estimateCostCents(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICES[model] ?? PRICES[model.split('/').pop() ?? ''] ?? { input: 1, output: 3 }
  const usd = (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output
  // Store in cents with 4 decimal places of precision (sub-cent AI calls are normal).
  return Math.round(usd * 10_000) / 100
}

/** Rough token estimate when the provider does not return usage (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function configuredModel(tier: ModelTier = 'standard'): string {
  if (tier === 'cheap') return env.AI_CHEAP_MODEL
  if (tier === 'reasoning') return env.AI_REASONING_MODEL
  return env.AI_CHAT_MODEL
}

export type AiStatus = {
  configured: boolean
  provider: string
  models: Record<ModelTier, string>
  networkAllowed: boolean
  reason?: string
}

export function aiStatus(): AiStatus {
  const provider = resolveAiProvider()
  const configured = provider !== 'none' && Boolean(resolveAiKey())
  return {
    configured,
    provider,
    models: {
      cheap: env.AI_CHEAP_MODEL,
      standard: env.AI_CHAT_MODEL,
      reasoning: env.AI_REASONING_MODEL,
    },
    networkAllowed: env.AI_ALLOW_NETWORK,
    reason: configured
      ? undefined
      : 'Set AI_PROVIDER_KEY (or AI_PROVIDER + OPENAI_API_KEY/ANTHROPIC_API_KEY/OPENROUTER_API_KEY/OLLAMA_BASE_URL) to enable real model calls. Heuristic engines remain active.',
  }
}

/* -------------------------------------------------------------- transports */

async function httpJson(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<{ status: number; body: unknown; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: response.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

type OpenAiStyleResponse = {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  model?: string
  error?: { message?: string }
}

async function callOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  request: GenerateRequest,
  model: string,
): Promise<GenerateResult> {
  const started = Date.now()
  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      { role: 'user', content: request.prompt },
    ],
    max_tokens: request.maxTokens ?? env.AI_MAX_TOKENS,
    temperature: request.temperature ?? Number(env.AI_TEMPERATURE),
  }
  if (request.json) body.response_format = { type: 'json_object' }

  const { status, body: parsed, text } = await httpJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeoutMs: request.timeoutMs ?? env.AI_TIMEOUT_MS,
  })

  if (status >= 400) {
    const message = (parsed as OpenAiStyleResponse)?.error?.message ?? text.slice(0, 400)
    throw new AiResponseError(`AI provider returned ${status}: ${message}`)
  }
  const data = parsed as OpenAiStyleResponse
  const content = data.choices?.[0]?.message?.content ?? ''
  const promptTokens = data.usage?.prompt_tokens ?? estimateTokens(`${request.system ?? ''}${request.prompt}`)
  const completionTokens = data.usage?.completion_tokens ?? estimateTokens(content)
  return {
    text: content,
    provider: baseUrl.includes('openrouter') ? 'openrouter' : baseUrl.includes('11434') ? 'ollama' : 'openai',
    model: data.model ?? model,
    promptTokens,
    completionTokens,
    totalTokens: data.usage?.total_tokens ?? promptTokens + completionTokens,
    costCents: estimateCostCents(data.model ?? model, promptTokens, completionTokens),
    latencyMs: Date.now() - started,
    finishReason: data.choices?.[0]?.finish_reason,
  }
}

type AnthropicResponse = {
  content?: { type: string; text?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
  model?: string
  stop_reason?: string
  error?: { message?: string }
}

async function callAnthropic(
  apiKey: string,
  request: GenerateRequest,
  model: string,
): Promise<GenerateResult> {
  const started = Date.now()
  const system = request.json
    ? `${request.system ?? ''}\n\nRespond with a single valid JSON object and nothing else.`
    : request.system

  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? env.AI_MAX_TOKENS,
    temperature: request.temperature ?? Number(env.AI_TEMPERATURE),
    messages: [{ role: 'user', content: request.prompt }],
  }
  if (system) body.system = system

  const { status, body: parsed, text } = await httpJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    timeoutMs: request.timeoutMs ?? env.AI_TIMEOUT_MS,
  })

  if (status >= 400) {
    const message = (parsed as AnthropicResponse)?.error?.message ?? text.slice(0, 400)
    throw new AiResponseError(`Anthropic returned ${status}: ${message}`)
  }
  const data = parsed as AnthropicResponse
  const content = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  const promptTokens = data.usage?.input_tokens ?? estimateTokens(`${system ?? ''}${request.prompt}`)
  const completionTokens = data.usage?.output_tokens ?? estimateTokens(content)
  return {
    text: content,
    provider: 'anthropic',
    model: data.model ?? model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costCents: estimateCostCents(data.model ?? model, promptTokens, completionTokens),
    latencyMs: Date.now() - started,
    finishReason: data.stop_reason,
  }
}

/* ------------------------------------------------------------------ public */

export async function generate(request: GenerateRequest): Promise<GenerateResult> {
  const provider = resolveAiProvider()
  const apiKey = resolveAiKey()
  if (provider === 'none' || !apiKey) throw new AiUnavailableError()
  if (!env.AI_ALLOW_NETWORK) throw new AiUnavailableError('AI_ALLOW_NETWORK is disabled')

  const model = configuredModel(request.tier ?? 'standard')
  let result: GenerateResult
  switch (provider) {
    case 'anthropic':
      result = await callAnthropic(apiKey, request, model)
      break
    case 'openrouter':
      result = await callOpenAiCompatible('https://openrouter.ai/api/v1', apiKey, request, model)
      break
    case 'ollama':
      result = await callOpenAiCompatible(`${env.OLLAMA_BASE_URL ?? 'http://localhost:11434'}/v1`, apiKey, request, model)
      break
    case 'custom':
      result = await callOpenAiCompatible(env.AI_BASE_URL ?? 'https://api.openai.com/v1', apiKey, request, model)
      break
    default:
      result = await callOpenAiCompatible(env.AI_BASE_URL ?? 'https://api.openai.com/v1', apiKey, request, model)
  }

  if (request.json) {
    const parsed = extractJson(result.text)
    if (parsed === undefined) throw new AiResponseError('Model did not return parseable JSON', result.text.slice(0, 600))
    result.data = parsed
  }

  await recordUsage(result, request, 'ok').catch(() => undefined)
  return result
}

export async function generateText(request: GenerateRequest): Promise<GenerateResult> {
  return generate({ ...request, json: false })
}

/** Generate and validate against a zod schema; throws when the model drifts. */
export async function generateJson<T>(request: GenerateRequest, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const result = await generate({ ...request, json: true })
  const parsed = schema.safeParse(result.data)
  if (!parsed.success) {
    throw new AiResponseError(
      `Model output failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      JSON.stringify(result.data).slice(0, 600),
    )
  }
  return parsed.data
}

/** Tolerant JSON extraction: handles ```json fences and leading/trailing prose. */
export function extractJson(text: string): unknown {
  if (!text) return undefined
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  const firstBracket = trimmed.indexOf('[')
  const lastBracket = trimmed.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) candidates.push(trimmed.slice(firstBracket, lastBracket + 1))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return undefined
}

async function recordUsage(
  result: GenerateResult,
  request: GenerateRequest,
  status: 'ok' | 'error',
  error?: string,
): Promise<void> {
  try {
    const { getDb, apiUsage } = await import('../db')
    const db = await getDb()
    await db.insert(apiUsage).values({
      workspaceId: request.workspaceId ?? null,
      provider: result.provider,
      model: result.model,
      operation: request.schemaName ?? 'generate',
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      costCents: String(result.costCents),
      endpoint: request.agentKey ?? null,
      latencyMs: result.latencyMs,
      status,
      error: error ?? null,
    })
    if (result.costCents > 0 && request.workspaceId) {
      const { recordExpense } = await import('../budget')
      await recordExpense({
        workspaceId: request.workspaceId,
        amountCents: result.costCents,
        category: 'ai_api',
        description: `${result.provider}/${result.model} — ${request.schemaName ?? 'generate'}`,
        provider: result.provider,
        verification: 'verified_integration',
        metadata: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          agentKey: request.agentKey ?? null,
        },
      })
    }
  } catch (err) {
    log.debug('usage recording skipped', { message: err instanceof Error ? err.message : String(err) })
  }
}

/** Probe the configured provider with a 1-token request. */
export async function testAiConnection(): Promise<{ ok: boolean; provider: string; model: string; latencyMs: number; error?: string }> {
  const status = aiStatus()
  if (!status.configured) {
    return { ok: false, provider: status.provider, model: configuredModel(), latencyMs: 0, error: status.reason }
  }
  const started = Date.now()
  try {
    const result = await generate({
      prompt: 'Reply with the single word: ok',
      maxTokens: 5,
      temperature: 0,
      tier: 'cheap',
      schemaName: 'healthcheck',
    })
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await persistLog({ level: 'warn', source: 'ai', message: `AI health check failed: ${message}` })
    return { ok: false, provider: status.provider, model: configuredModel(), latencyMs: Date.now() - started, error: message }
  }
}

export * as aiPrompts from './prompts'
export * from './schemas'
