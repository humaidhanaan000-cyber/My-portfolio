import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { RegisterForm } from '@/components/auth/forms'
import { getSession } from '@/lib/auth'
import { publicConfig } from '@/lib/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Create your workspace',
  description: 'Create an AIBA workspace: your own agents, budgets, projects and revenue ledger.',
}

export default async function RegisterPage() {
  const session = await getSession().catch(() => null)
  if (session) redirect('/dashboard')
  const config = publicConfig()

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Create your workspace</h1>
      <p className="mt-1 text-xs text-ink-500">
        One workspace per operator. You will choose your risk tolerance, budget limits and automation level in the next step.
      </p>
      <RegisterForm />
      <p className="mt-4 text-[11px] text-ink-400">
        {config.requireEmailVerification
          ? 'Email verification is enabled on this deployment: you will receive a link before some features unlock.'
          : 'Email verification is disabled on this deployment.'}{' '}
        Passwords are stored only as scrypt hashes.
      </p>
      <p className="mt-6 text-center text-xs text-ink-500">
        Already registered?{' '}
        <Link href="/login" className="font-medium text-accent-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  )
}
