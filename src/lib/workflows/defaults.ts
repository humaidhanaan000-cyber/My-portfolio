/**
 * Workflow definitions.
 *
 * A workflow is a directed graph of typed nodes. The engine executes nodes in
 * dependency order, stopping at approval nodes (which create a real approval
 * request) and recording every step into `workflow_runs.steps`.
 */
export type WorkflowNodeType =
  | 'trigger'
  | 'research'
  | 'filter'
  | 'score'
  | 'analyze'
  | 'strategy'
  | 'approval'
  | 'build'
  | 'launch'
  | 'monitor'
  | 'optimize'
  | 'notify'
  | 'delay'

export type WorkflowNode = {
  id: string
  type: WorkflowNodeType
  label: string
  config?: Record<string, unknown>
  /** Node ids that must complete before this node runs. */
  dependsOn?: string[]
  continueOnError?: boolean
}

export type WorkflowEdge = { from: string; to: string }
export type WorkflowDefinition = { nodes: WorkflowNode[]; edges: WorkflowEdge[] }

export function defaultWorkflowDefinition(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: 'trigger', type: 'trigger', label: 'Trigger (schedule or manual)', config: { schedule: '0 * * * *' } },
    { id: 'research', type: 'research', label: 'Research: discover opportunities', dependsOn: ['trigger'], config: { limitPerSource: 15 } },
    { id: 'filter', type: 'filter', label: 'Filter: clean, dedupe and validate', dependsOn: ['research'] },
    { id: 'score', type: 'score', label: 'Score against your threshold', dependsOn: ['filter'], config: { threshold: 70 } },
    { id: 'analyze', type: 'analyze', label: 'Analyse high scorers (10 dimensions)', dependsOn: ['score'], config: { batchSize: 10 } },
    { id: 'strategy', type: 'strategy', label: 'Generate business strategy', dependsOn: ['analyze'], config: { createProject: true } },
    { id: 'approval', type: 'approval', label: 'Request your approval', dependsOn: ['strategy'], config: { actionType: 'create_project' } },
    { id: 'build', type: 'build', label: 'Build approved assets', dependsOn: ['approval'], config: { assets: ['product_spec', 'landing_page', 'faq', 'content'] } },
    { id: 'launch', type: 'launch', label: 'Launch project', dependsOn: ['build'], config: { requiresApproval: true } },
    { id: 'monitor', type: 'monitor', label: 'Monitor performance', dependsOn: ['launch'] },
    { id: 'optimize', type: 'optimize', label: 'Optimise from results', dependsOn: ['monitor'], config: { windowDays: 30 } },
  ]
  const edges: WorkflowEdge[] = nodes
    .filter((node) => node.dependsOn?.length)
    .flatMap((node) => node.dependsOn!.map((from) => ({ from, to: node.id })))
  return { nodes, edges }
}

export const NODE_LABELS: Record<WorkflowNodeType, string> = {
  trigger: 'Trigger',
  research: 'Research',
  filter: 'Filter',
  score: 'Score',
  analyze: 'Analyze',
  strategy: 'Strategy',
  approval: 'Approval',
  build: 'Build',
  launch: 'Launch',
  monitor: 'Monitor',
  optimize: 'Optimize',
  notify: 'Notify',
  delay: 'Delay',
}

export const NODE_COLORS: Record<string, string> = {
  trigger: 'slate',
  research: 'cyan',
  filter: 'blue',
  score: 'violet',
  analyze: 'violet',
  strategy: 'amber',
  approval: 'amber',
  build: 'emerald',
  launch: 'emerald',
  monitor: 'sky',
  optimize: 'sky',
  notify: 'slate',
  delay: 'slate',
}

/* ------------------------------------------------------------------ templates */

export type WorkflowTemplate = {
  key: string
  name: string
  description: string
  schedule: string | null
  definition: WorkflowDefinition
}

/**
 * Templates are real, runnable definitions — not illustrations. The dashboard
 * offers them from the visual builder, and creating a workflow from a template
 * stores exactly this graph.
 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'full-pipeline',
    name: 'Full pipeline (discover → launch)',
    description:
      'Scans sources, cleans and scores everything, analyses the best candidates, writes a strategy, then stops at your approval before anything is built or launched.',
    schedule: '0 */6 * * *',
    definition: defaultWorkflowDefinition(),
  },
  {
    key: 'research-only',
    name: 'Research & score only',
    description: 'Read-only discovery. Nothing is created and nothing is published.',
    schedule: '0 * * * *',
    definition: {
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'Trigger', config: {} },
        { id: 'research', type: 'research', label: 'Research: discover opportunities', dependsOn: ['trigger'], config: { limitPerSource: 15 } },
        { id: 'filter', type: 'filter', label: 'Clean & dedupe', dependsOn: ['research'] },
        { id: 'score', type: 'score', label: 'Score', dependsOn: ['filter'], config: { threshold: 70 } },
        { id: 'notify', type: 'notify', label: 'Notify me about new high scorers', dependsOn: ['score'], config: { template: 'high_score_opportunity' } },
      ],
      edges: [
        { from: 'trigger', to: 'research' },
        { from: 'research', to: 'filter' },
        { from: 'filter', to: 'score' },
        { from: 'score', to: 'notify' },
      ],
    },
  },
  {
    key: 'build-approved',
    name: 'Build & launch an approved project',
    description:
      'Takes an already-approved project through asset generation, asks for launch approval, then monitors it and feeds results back into learning.',
    schedule: null,
    definition: {
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'Trigger', config: {} },
        { id: 'build', type: 'build', label: 'Build deliverables (drafts only)', dependsOn: ['trigger'], config: { assets: ['product_spec', 'landing_page', 'faq', 'seo_metadata'] } },
        { id: 'approval', type: 'approval', label: 'Request launch approval', dependsOn: ['build'], config: { actionType: 'update_project' } },
        { id: 'launch', type: 'launch', label: 'Launch', dependsOn: ['approval'], config: { requiresApproval: true } },
        { id: 'monitor', type: 'monitor', label: 'Monitor performance', dependsOn: ['launch'] },
        { id: 'optimize', type: 'optimize', label: 'Optimise from results', dependsOn: ['monitor'], config: { windowDays: 30 } },
      ],
      edges: [
        { from: 'trigger', to: 'build' },
        { from: 'build', to: 'approval' },
        { from: 'approval', to: 'launch' },
        { from: 'launch', to: 'monitor' },
        { from: 'monitor', to: 'optimize' },
      ],
    },
  },
  {
    key: 'daily-report',
    name: 'Daily operations report',
    description: 'Collects the day’s numbers, checks every running project and emails you a summary.',
    schedule: '0 8 * * *',
    definition: {
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'Daily at 08:00', config: {} },
        { id: 'monitor', type: 'monitor', label: 'Check projects & budgets', dependsOn: ['trigger'] },
        { id: 'notify', type: 'notify', label: 'Send the daily report', dependsOn: ['monitor'], config: { template: 'report_ready' } },
      ],
      edges: [
        { from: 'trigger', to: 'monitor' },
        { from: 'monitor', to: 'notify' },
      ],
    },
  },
]

export function templateByKey(key: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.key === key)
}
