'use client'

/**
 * Authentication forms.
 *
 * Each form performs a real request against the API and surfaces the server's
 * own message — including "too many attempts" and lockout states. Nothing is
 * simulated: a failed sign-in stays failed, and a successful one navigates.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button, ErrorNote, Field, Input } from '@/components/ui'
import { ApiClientError, api } from '@/lib/client/api'

function messageOf(error: unknown): string {
  if (error instanceof ApiClientError) return error.message
  return error instanceof Error ? error.message : 'Something went wrong. Try again.'
}

/**
 * Confirm the browser actually kept the session cookie.
 *
 * A successful `POST /api/auth/login` only means the server created a session; it
 * still has to be *stored*. Browsers silently discard cookies when the page runs
 * inside a cross-site frame (SameSite=Lax), when third-party cookies are blocked
 * (Safari, Brave, Chrome with blocking enabled) or when the cookie is marked
 * Secure but the page is served over plain http. In that case the very next page
 * load is anonymous and the user is bounced back to the sign-in page with no
 * explanation — which looks exactly like "my password does not work".
 *
 * So: ask the server who we are. If there is no session, say plainly what
 * happened and what to do about it, instead of looping.
 */
async function assertSessionStored(): Promise<void> {
  const session = await api.get<{ user: { email: string } | null }>('/api/auth/session').catch(() => null)
  if (session?.data?.user) return
  throw new ApiClientError(
    'Signed in, but this browser did not keep the session cookie, so the next page would ask you to sign in again. ' +
      'This happens when the app is shown inside a frame or when third-party cookies are blocked. ' +
      'Open the app in its own browser tab (or allow cookies for this site) and sign in again.',
    'cookie_blocked',
    0,
  )
}

export function LoginForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const result = await api.post<{ user: { onboarded: boolean }; nextStep: string }>('/api/auth/login', { email, password })
      await assertSessionStored()
      router.replace(nextPath && nextPath.startsWith('/') ? nextPath : result.data.nextStep ?? '/dashboard')
      router.refresh()
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {error ? <ErrorNote message={error} /> : null}
      <Field label="Email" required>
        <Input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
      </Field>
      <Field label="Password" required>
        <Input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        Sign in
      </Button>
      <p className="text-center text-xs text-ink-500">
        <Link href="/forgot-password" className="hover:underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  )
}

export function RegisterForm() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await api.post('/api/auth/register', {
        name: form.name,
        email: form.email,
        password: form.password,
        workspaceName: form.workspaceName || undefined,
      })
      await assertSessionStored()
      router.replace('/onboarding')
      router.refresh()
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {error ? <ErrorNote message={error} /> : null}
      <Field label="Your name" required>
        <Input required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Alex Morgan" />
      </Field>
      <Field label="Email" required>
        <Input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" />
      </Field>
      <Field label="Password" required hint="At least 10 characters, with upper and lower case and a number.">
        <Input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
        />
      </Field>
      <Field label="Workspace name" hint="Optional. Defaults to your name.">
        <Input value={form.workspaceName} onChange={(event) => setForm({ ...form, workspaceName: event.target.value })} placeholder="Acme Operations" />
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        Create workspace
      </Button>
    </form>
  )
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const result = await api.post<{ message: string }>('/api/auth/forgot-password', { email })
      setMessage(result.data.message)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {error ? <ErrorNote message={error} /> : null}
      {message ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{message}</p>
      ) : null}
      <Field label="Email" required>
        <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        Send reset link
      </Button>
      <p className="text-center text-xs text-ink-500">
        <Link href="/login" className="hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  )
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const result = await api.post<{ message: string }>('/api/auth/reset-password', { token, password })
      setMessage(result.data.message)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {error ? <ErrorNote message={error} /> : null}
      {message ? (
        <>
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{message}</p>
          <Button type="button" className="w-full" onClick={() => router.push('/login')}>
            Go to sign in
          </Button>
        </>
      ) : (
        <>
          <Field label="New password" required hint="At least 10 characters, with upper and lower case and a number.">
            <Input type="password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            Set new password
          </Button>
        </>
      )}
    </form>
  )
}

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>(token ? 'idle' : 'error')
  const [message, setMessage] = useState<string | null>(token ? null : 'The verification link is missing its token.')

  async function submit() {
    setState('pending')
    try {
      await api.post('/api/auth/verify-email', { token })
      setState('done')
      setMessage('Your email address is verified.')
    } catch (caught) {
      setState('error')
      setMessage(messageOf(caught))
    }
  }

  return (
    <div className="mt-4 space-y-4">
      {message ? (
        <p
          className={`rounded-lg border px-3 py-2 text-xs ${
            state === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          {message}
        </p>
      ) : null}
      {state === 'idle' ? (
        <Button onClick={submit} className="w-full">
          Verify this address
        </Button>
      ) : null}
      {state === 'pending' ? <Button loading className="w-full">Verifying…</Button> : null}
      <p className="text-center text-xs text-ink-500">
        <Link href="/dashboard" className="hover:underline">
          Continue to the dashboard
        </Link>
      </p>
    </div>
  )
}
