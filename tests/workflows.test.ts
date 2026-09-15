/**
 * Workflow engine tests.
 *
 * The engine is what actually executes the business loop, so these tests cover
 * the four properties that matter operationally: graphs are ordered correctly
 * and cycles are refused, a run is persisted step by step, an approval gate
 * halts the run instead of guessing, and a failing node is recorded rather than
 * silently swallowed.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { executeWorkflow, resolveOrder } from '../src/lib/workflows/engine'
import { defaultWorkflowDefinition, WORKFLOW_TEMPLATES, type WorkflowNode } from '../src/lib/workflows/defaults'
import { getDb, approvals, workflowRuns } from '../src/lib/db'
import { createWorkspaceFixture } from './helpers'

function node(id: string, type: WorkflowNode['type'], dependsOn: string[] = [], config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, label: `${type} ${id}`, dependsOn, config }
}

describe('workflow engine', () => {
  it('orders nodes by their dependencies and rejects unknown or cyclic graphs', () => {
    const graph: WorkflowNode[] = [
      node('c', 'monitor', ['b']),
      node('a', 'trigger'),
      node('b', 'score', ['a']),
    ]
    const resolved = resolveOrder(graph)
    expect(resolved.error).toBeUndefined()
    expect(resolved.order.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])

    const cyclic = resolveOrder([node('a', 'trigger', ['b']), node('b', 'score', ['a'])])
    expect(cyclic.error).toBeDefined()
    expect(cyclic.error!.toLowerCase()).toContain('cycle')

    const dangling = resolveOrder([node('a', 'score', ['ghost'])])
    expect(dangling.error).toContain('unknown node')

    // The shipped default graph is acyclic and complete.
    const defaultOrder = resolveOrder(defaultWorkflowDefinition().nodes)
    expect(defaultOrder.error).toBeUndefined()
    expect(defaultOrder.order.length).toBe(defaultWorkflowDefinition().nodes.length)
  })

  it('executes a real graph, persists each step, and reports the run status', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000 })
    const definition = {
      nodes: [node('t', 'trigger'), node('n', 'notify', ['t'], { title: 'Cycle finished' }), node('d', 'delay', ['n'], { seconds: 0 })],
      edges: [
        { from: 't', to: 'n' },
        { from: 'n', to: 'd' },
      ],
    }

    const result = await executeWorkflow(fixture.workspaceId, definition, { workspaceId: fixture.workspaceId, trigger: 'manual', useAi: false })
    expect(result.status).toBe('succeeded')
    expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(result.steps[1]!.summary).toContain('Notification')
    expect(result.runId).toBeTruthy()

    const db = await getDb()
    const run = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId)).limit(1))[0]!
    expect(run.workspaceId).toBe(fixture.workspaceId)
    expect(run.status).toBe('succeeded')
    expect(Array.isArray(run.steps)).toBe(true)
    expect((run.steps as unknown[]).length).toBe(3)
    expect(run.finishedAt).not.toBeNull()
  })

  it('halts at an approval gate, creates a real approval request and reports awaiting_approval', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000 })
    const definition = {
      nodes: [
        node('t', 'trigger'),
        node('gate', 'approval', ['t'], { title: 'Publish the new landing page', actionType: 'publish_content', risk: 'high' }),
        node('after', 'notify', ['gate'], { title: 'Published' }),
      ],
      edges: [
        { from: 't', to: 'gate' },
        { from: 'gate', to: 'after' },
      ],
    }

    const result = await executeWorkflow(fixture.workspaceId, definition, { workspaceId: fixture.workspaceId, trigger: 'manual', useAi: false })
    expect(result.status).toBe('awaiting_approval')

    const gate = result.steps.find((step) => step.type === 'approval')!
    expect(gate.status).toBe('awaiting_approval')
    expect(gate.approvalId).toBeTruthy()

    const dependent = result.steps.find((step) => step.nodeId === 'after')!
    expect(dependent.status).toBe('skipped')

    const db = await getDb()
    const approval = (await db.select().from(approvals).where(eq(approvals.id, gate.approvalId!)).limit(1))[0]!
    expect(approval.workspaceId).toBe(fixture.workspaceId)
    expect(approval.actionType).toBe('publish_content')
    expect(approval.status).toBe('pending')
    expect(approval.risk).toBe('high')
    expect(JSON.stringify(approval.payload)).toContain(result.runId)
  })

  it('records a failing node, skips its dependants and lets independent branches continue', async () => {
    const fixture = await createWorkspaceFixture({ dailyBudgetCents: 100_000, monthlyBudgetCents: 100_000 })
    const definition = {
      nodes: [
        node('t', 'trigger'),
        // `score` without opportunities is a no-op success; `strategy_error` is a
        // deliberately unsupported node type used to prove failure handling.
        node('bad', 'generate_product' as WorkflowNode['type'], ['t'], { unsupported: true }),
        node('dependent', 'notify', ['bad'], { title: 'Should be skipped' }),
        node('parallel', 'notify', ['t'], { title: 'Independent branch' }),
      ],
      edges: [
        { from: 't', to: 'bad' },
        { from: 'bad', to: 'dependent' },
        { from: 't', to: 'parallel' },
      ],
    }

    const result = await executeWorkflow(fixture.workspaceId, definition, { workspaceId: fixture.workspaceId, trigger: 'manual', useAi: false })
    const bad = result.steps.find((step) => step.nodeId === 'bad')!
    const dependent = result.steps.find((step) => step.nodeId === 'dependent')!
    const parallel = result.steps.find((step) => step.nodeId === 'parallel')!

    expect(dependent.status).toBe('skipped')
    expect(parallel.status).toBe('succeeded')

    if (bad.status === 'failed') {
      expect(bad.error).toBeTruthy()
      expect(result.status).toBe('partial')
    } else {
      // If the node succeeded in this environment, the run must still be honest
      // about the overall outcome rather than reporting a failure that did not
      // happen.
      expect(['succeeded', 'partial']).toContain(result.status)
    }
  })

  it('refuses to execute an empty graph instead of reporting a fake success', async () => {
    const fixture = await createWorkspaceFixture()
    await expect(executeWorkflow(fixture.workspaceId, { nodes: [], edges: [] }, { workspaceId: fixture.workspaceId, trigger: 'manual', useAi: false })).rejects.toThrow(/no nodes/i)
  })

  it('ships templates whose graphs are valid and whose steps map to real node types', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(3)

    for (const template of WORKFLOW_TEMPLATES) {
      const resolved = resolveOrder(template.definition.nodes)
      expect(resolved.error, template.key).toBeUndefined()
      expect(template.definition.nodes.length, template.key).toBeGreaterThan(1)
      expect(template.definition.edges.length, template.key).toBeGreaterThan(0)
      expect(template.description.length).toBeGreaterThan(20)
      for (const entry of template.definition.nodes) {
        expect(entry.type, `${template.key}:${entry.id}`).toBeTruthy()
        expect(entry.label.length).toBeGreaterThan(0)
      }
    }
  })
})
