import type { Metadata } from 'next'
import { ForgotPasswordForm } from '@/components/auth/forms'

export const metadata: Metadata = {
  title: 'Reset your password',
  robots: { index: false, follow: false },
}

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Reset your password</h1>
      <p className="mt-1 text-xs text-ink-500">
        Enter your email address. If an account exists, we send a single-use reset link. The response is identical either way, so the
        form cannot be used to discover which addresses are registered.
      </p>
      <ForgotPasswordForm />
    </>
  )
}
