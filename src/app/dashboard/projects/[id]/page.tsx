import { ProjectDetailView } from '@/components/dashboard/project-detail'

export const dynamic = 'force-dynamic'

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ProjectDetailView id={id} />
}
