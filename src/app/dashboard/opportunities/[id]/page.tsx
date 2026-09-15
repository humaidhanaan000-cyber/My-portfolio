import { OpportunityDetail } from '@/components/dashboard/opportunity-detail'

export const dynamic = 'force-dynamic'

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <OpportunityDetail id={id} />
}
