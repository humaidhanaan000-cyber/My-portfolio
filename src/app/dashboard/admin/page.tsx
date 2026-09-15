import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { AdminConsole } from '@/components/dashboard/admin'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await getSession()
  if (!session) redirect('/login?next=/dashboard/admin')
  if (session.role !== 'admin') redirect('/dashboard')
  return <AdminConsole />
}
