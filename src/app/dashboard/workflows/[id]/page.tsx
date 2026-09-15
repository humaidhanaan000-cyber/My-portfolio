import { WorkflowDetailView } from '@/components/dashboard/workflow-detail'

export const dynamic = 'force-dynamic'

export default async function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <WorkflowDetailView id={id} />
}
