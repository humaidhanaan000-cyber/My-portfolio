import type { Metadata } from 'next'
import { VerifyEmailForm } from '@/components/auth/forms'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Verify your email',
  robots: { index: false, follow: false },
}

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const token = typeof params.token === 'string' ? params.token : ''
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Verify your email address</h1>
      <VerifyEmailForm token={token} />
    </>
  )
}
