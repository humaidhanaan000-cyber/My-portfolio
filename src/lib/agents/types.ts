import type { z } from 'zod'
import type { ActionType, AutomationLevel, PolicyDecision } from '../compliance/policy'

export type AgentKey =
  | 'research'
  | 'cleaning'
  | 'analysis'
  | 'strategy'
  | 'product'
  | 'content'
  | 'execution'
  | 'monitoring'
  | 'learning'

export type AgentCategory = 'discovery' | 'analysis' | 'creation' | 'execution' | 'operations'

export type ModelTier = 'cheap' | 'standard' | 'reasoning'

export type AgentDefinition<TInput = unknown, TOutput = unknown> = {
  key: AgentKey
  name: string
  description: string
  category: AgentCategory
  /** Policy action evaluated before every run. */
  policyAction: ActionType
  /** Estimated cost ceiling for a single run, in cents. */
  estimatedCostCents: number
  modelTier: ModelTier
  timeoutSeconds: number
  /** Minimum interval between scheduled runs, in minutes. */
  cadenceMinutes: number
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>
  run: (input: TInput, ctx: AgentContext) => Promise<AgentOutput<TOutput>>
  /** Optional post-run memory write. */
  memory?: (output: AgentOutput<TOutput>, input: TInput, ctx: AgentContext) => Promise<void>
  requiresWorkspace?: boolean
}

export type AgentContext = {
  workspaceId: string
  userId?: string | null
  runId: string
  jobId?: string | null
  triggeredBy: 'manual' | 'schedule' | 'api' | 'agent' | 'system' | 'user'
  logger: {
    debug: (message: string, context?: Record<string, unknown>) => void
    info: (message: string, context?: Record<string, unknown>) => void
    warn: (message: string, context?: Record<string, unknown>) => void
    error: (message: string, error?: unknown, context?: Record<string, unknown>) => void
  }
  automationLevel: AutomationLevel
  /** Ask a model; throws AiUnavailableError when unconfigured. */
  ai: {
    available: boolean
    provider: string
    generate: typeof import('../ai').generate
    generateJson: typeof import('../ai').generateJson
  }
  /** Budget helper — returns null when no reservation is needed. */
  reserveSpend: (amountCents: number, description: string, refId?: string) => Promise<{ ledgerId?: string } | { blocked: string }>
  signal: AbortSignal
  now: Date
  /** Learning state derived from history, consumed by scoring/analysis. */
  learning: import('./scoring').LearningAdjustments
}

export type AgentOutput<T> = {
  data: T
  summary: string
  /** Human-readable findings surfaced in the run log and UI. */
  notes?: string[]
  costCents?: number
  provider?: string
  model?: string
  tokens?: number
  metrics?: Record<string, number>
  /** When set, the run stopped and an approval was raised. */
  approvalId?: string | null
  /** Anything the user should be warned about. */
  warnings?: string[]
}

export type AgentRunStatus = 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval' | 'timeout'

export type AgentRunOutcome<T = unknown> = {
  runId: string
  agentKey: AgentKey
  status: AgentRunStatus
  output?: AgentOutput<T>
  error?: string
  policy: PolicyDecision
  durationMs: number
  costCents: number
  approvalId?: string | null
}
