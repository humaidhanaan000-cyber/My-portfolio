import type { Metadata } from 'next'
import { ResetPasswordForm } from '@/components/auth/forms'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Set a new password',
  robots: { index: false, follow: false },
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const token = typeof params.token === 'string' ? params.token : ''

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Set a new password</h1>
      {token ? (
        <>
          <p className="mt-1 text-xs text-ink-500">Choosing a new password signs out every other session on this account.</p>
          <ResetPasswordForm token={token} />
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This link is missing its token. Request a new reset email from the sign-in page.
        </p>
      )}
    </>
  )
}
