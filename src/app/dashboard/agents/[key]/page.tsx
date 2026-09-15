import Link from 'next/link'
import { AgentRunHistory } from '@/components/dashboard/agents'

export const dynamic = 'force-dynamic'

export default async function AgentDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return (
    <div className="space-y-5">
      <header>
        <Link href="/dashboard/agents" className="text-xs font-medium text-ink-500 hover:text-ink-800">
          ← All agents
        </Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-ink-900 capitalize">{key} agent</h1>
        <p className="mt-0.5 text-xs text-ink-500">Every run this agent has performed, with its cost, duration and output summary.</p>
      </header>
      <AgentRunHistory agentKey={key} />
    </div>
  )
}
