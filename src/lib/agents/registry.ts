/**
 * Agent registry — the single source of truth for which agents exist, how they
 * are scheduled and how they are addressed by the API and the queue.
 */
import { researchAgent } from './definitions/research'
import { cleaningAgent } from './definitions/cleaning'
import { analysisAgent } from './definitions/analysis'
import { strategyAgent } from './definitions/strategy'
import { productAgent } from './definitions/product'
import { contentAgent } from './definitions/content'
import { executionAgent } from './definitions/execution'
import { monitoringAgent } from './definitions/monitoring'
import { learningAgent } from './definitions/learning'
import type { AgentDefinition, AgentKey } from './types'

export const AGENTS: Record<AgentKey, AgentDefinition<never, never>> = {
  research: researchAgent as unknown as AgentDefinition<never, never>,
  cleaning: cleaningAgent as unknown as AgentDefinition<never, never>,
  analysis: analysisAgent as unknown as AgentDefinition<never, never>,
  strategy: strategyAgent as unknown as AgentDefinition<never, never>,
  product: productAgent as unknown as AgentDefinition<never, never>,
  content: contentAgent as unknown as AgentDefinition<never, never>,
  execution: executionAgent as unknown as AgentDefinition<never, never>,
  monitoring: monitoringAgent as unknown as AgentDefinition<never, never>,
  learning: learningAgent as unknown as AgentDefinition<never, never>,
}

export const AGENT_ORDER: AgentKey[] = [
  'research',
  'cleaning',
  'analysis',
  'strategy',
  'product',
  'content',
  'execution',
  'monitoring',
  'learning',
]

export function getAgent(key: string): AgentDefinition<never, never> | undefined {
  return AGENTS[key as AgentKey]
}

export function agentCatalogue() {
  return AGENT_ORDER.map((key) => {
    const agent = AGENTS[key]
    return {
      key,
      name: agent.name,
      description: agent.description,
      category: agent.category,
      policyAction: agent.policyAction,
      estimatedCostCents: agent.estimatedCostCents,
      modelTier: agent.modelTier,
      cadenceMinutes: agent.cadenceMinutes,
      timeoutSeconds: agent.timeoutSeconds,
    }
  })
}

/** Run any agent by key with the same runtime guarantees. */
export async function runAgentByKey(
  key: string,
  input: unknown,
  options: Parameters<typeof import('./runtime').runAgent>[2],
) {
  const { runAgent } = await import('./runtime')
  const agent = getAgent(key)
  if (!agent) throw new Error(`Unknown agent "${key}". Known agents: ${AGENT_ORDER.join(', ')}`)
  return runAgent(agent, input, options)
}
