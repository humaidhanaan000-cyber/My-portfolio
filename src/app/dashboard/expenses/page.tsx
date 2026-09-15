import { getSession } from '@/lib/auth'
import { loadProjectOptions } from '@/lib/server/workspace'
import { ExpenseLedger } from '@/components/dashboard/money'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  const session = await getSession()
  const projects = session ? await loadProjectOptions(session.workspaceId) : []
  return <ExpenseLedger projects={projects} />
}
