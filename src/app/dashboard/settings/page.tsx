import { getSession } from '@/lib/auth'
import { SettingsPanel } from '@/components/dashboard/settings'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const session = await getSession()
  return <SettingsPanel isAdmin={session?.role === 'admin'} />
}
