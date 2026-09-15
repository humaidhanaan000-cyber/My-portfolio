import { getSession } from '@/lib/auth'
import { loadProjectOptions } from '@/lib/server/workspace'
import { RevenueLedger } from '@/components/dashboard/money'

export const dynamic = 'force-dynamic'

export default async function RevenuePage() {
  const session = await getSession()
  const projects = session ? await loadProjectOptions(session.workspaceId) : []
  return <RevenueLedger projects={projects} />
}
