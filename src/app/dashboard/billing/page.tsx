import { getSession } from '@/lib/auth'
import { BillingCenter } from '@/components/dashboard/account'

export const dynamic = 'force-dynamic'

export default async function BillingPage() {
  const session = await getSession()
  return <BillingCenter isAdmin={session?.role === 'admin'} />
}
