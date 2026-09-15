/**
 * Public marketing components.
 *
 * The language here is deliberately restrained: AIBA is a tool that does work
 * for an operator. It does not promise income, and every page states the limits
 * plainly — that is a product requirement, not a style choice.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'

export function SiteNav({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-200/70 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-ink-900 text-xs font-bold text-accent-300">AI</span>
          <span className="text-sm font-semibold tracking-tight text-ink-900">AIBA</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-ink-600 md:flex">
          <Link href="/how-it-works" className="hover:text-ink-900">How it works</Link>
          <Link href="/safety" className="hover:text-ink-900">Safety &amp; limits</Link>
          <Link href="/pricing" className="hover:text-ink-900">Pricing</Link>
          <Link href="/api-docs" className="hover:text-ink-900">API</Link>
          <Link href="/status" className="hover:text-ink-900">Status</Link>
        </nav>
        <div className="flex items-center gap-2">
          {signedIn ? (
            <Link href="/dashboard" className="rounded-lg bg-accent-600 px-3 py-2 text-xs font-medium text-white hover:bg-accent-700">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded-lg px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-100">
                Sign in
              </Link>
              <Link href="/register" className="rounded-lg bg-accent-600 px-3 py-2 text-xs font-medium text-white hover:bg-accent-700">
                Create account
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-sm font-semibold text-ink-900">AIBA</p>
          <p className="mt-2 text-xs text-ink-500">
            Autonomous Internet Business Agent. A self-hosted operations platform for one operator and their workspace.
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">Product</p>
          <ul className="mt-3 space-y-2 text-xs text-ink-600">
            <li><Link href="/how-it-works" className="hover:text-ink-900">How it works</Link></li>
            <li><Link href="/safety" className="hover:text-ink-900">Safety &amp; limits</Link></li>
            <li><Link href="/pricing" className="hover:text-ink-900">Pricing</Link></li>
            <li><Link href="/api-docs" className="hover:text-ink-900">REST API</Link></li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">Operate</p>
          <ul className="mt-3 space-y-2 text-xs text-ink-600">
            <li><Link href="/status" className="hover:text-ink-900">System status</Link></li>
            <li><Link href="/login" className="hover:text-ink-900">Sign in</Link></li>
            <li><Link href="/register" className="hover:text-ink-900">Create account</Link></li>
            <li><Link href="/api/health" className="hover:text-ink-900">Health endpoint</Link></li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">No guarantees</p>
          <p className="mt-3 text-xs text-ink-600">
            AIBA does not promise or guarantee income. Scores are research estimates, not forecasts. Your results depend on
            your market, your execution and your decisions.
          </p>
        </div>
      </div>
      <div className="border-t border-ink-100 px-4 py-4">
        <p className="mx-auto max-w-6xl text-[11px] text-ink-400">
          AIBA never bypasses paywalls, CAPTCHAs or platform terms, never creates fake accounts or reviews, and never trades
          financial instruments. Hard budget limits cannot be exceeded by the software.
        </p>
      </div>
    </footer>
  )
}

export function SectionHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      {eyebrow ? <p className="text-xs font-semibold tracking-widest text-accent-600 uppercase">{eyebrow}</p> : null}
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">{title}</h2>
      {description ? <p className="mt-3 text-sm leading-relaxed text-ink-600">{description}</p> : null}
    </div>
  )
}

export function FeatureCard({ title, description, icon }: { title: string; description: string; icon?: ReactNode }) {
  return (
    <div className="surface p-5">
      {icon ? <div className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-accent-50 text-accent-700">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-600">{description}</p>
    </div>
  )
}

export function Step({ index, title, description }: { index: number; title: string; description: string }) {
  return (
    <div className="flex gap-4">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-900 text-xs font-semibold text-accent-300">{index}</div>
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">{description}</p>
      </div>
    </div>
  )
}

export function Callout({ tone = 'neutral', title, children }: { tone?: 'neutral' | 'warning' | 'info'; title: string; children: ReactNode }) {
  const styles =
    tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : tone === 'info'
        ? 'border-accent-200 bg-accent-50 text-accent-900'
        : 'border-ink-200 bg-white text-ink-700'
  return (
    <div className={`rounded-xl border p-4 ${styles}`}>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-1 text-xs leading-relaxed">{children}</div>
    </div>
  )
}
