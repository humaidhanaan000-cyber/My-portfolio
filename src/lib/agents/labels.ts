/** Human-facing labels shared by the API and the dashboard. */
import { AGENT_ORDER, AGENTS } from './registry'

export function AGENT_ORDERSchemaTag() {
  return AGENT_ORDER.map((key) => {
    const agent = AGENTS[key]
    return {
      key,
      name: agent.name,
      description: agent.description,
      category: agent.category,
      estimatedCostCents: agent.estimatedCostCents,
      modelTier: agent.modelTier,
      cadenceMinutes: agent.cadenceMinutes,
      timeoutSeconds: agent.timeoutSeconds,
      policyAction: agent.policyAction,
    }
  })
}

export const AGENT_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_ORDER.map((key) => [key, AGENTS[key].name]),
)
