'use client'

/**
 * UI primitives.
 *
 * Deliberately small and dependency-free: the same components render the
 * marketing site and the operator console, so the product looks and behaves
 * consistently. Nothing here is decorative for its own sake — every state shown
 * (loading, empty, error, live) corresponds to a real condition.
 */
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'subtle'
type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-300 shadow-sm',
  secondary: 'bg-white text-ink-800 border border-ink-200 hover:bg-ink-50 disabled:text-ink-400',
  ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  danger: 'bg-signal-critical text-white hover:brightness-110 disabled:opacity-60',
  success: 'bg-signal-positive text-white hover:brightness-110 disabled:opacity-60',
  subtle: 'bg-ink-100 text-ink-700 hover:bg-ink-200',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-4 w-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* -------------------------------------------------------------------- cards */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('surface p-5', className)}>{children}</div>
}

export function CardHeader({ title, subtitle, action, icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {icon ? <div className="mt-0.5 text-ink-400">{icon}</div> : null}
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </div>
  )
}

/* ------------------------------------------------------------------ badges */

type Tone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info' | 'demo'

const TONES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 border-ink-200',
  positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  critical: 'bg-red-50 text-red-700 border-red-200',
  info: 'bg-accent-50 text-accent-700 border-accent-200',
  demo: 'bg-violet-50 text-violet-700 border-violet-200',
}

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', TONES[tone], className)}
    >
      {children}
    </span>
  )
}

/** Always visible on demo rows — the label is never optional. */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge tone="demo" className={className} title="This row is demo data and is excluded from real revenue totals.">
      DEMO DATA
    </Badge>
  )
}

export function EstimateBadge({ label = 'estimate', className }: { label?: string; className?: string }) {
  return (
    <Badge tone="warning" className={className} title="Projected or estimated figure — not verified actual revenue.">
      {label}
    </Badge>
  )
}

/* ------------------------------------------------------------------- inputs */

export function Field({ label, hint, error, children, required }: { label: string; hint?: string; error?: string | null; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-xs font-medium text-ink-700">
        {label}
        {required ? <span className="text-signal-critical">*</span> : null}
      </span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-ink-500">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-signal-critical">{error}</span> : null}
    </label>
  )
}

const INPUT_CLASS =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-400 focus:outline-none disabled:bg-ink-50'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(INPUT_CLASS, className)} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(INPUT_CLASS, 'pr-8', className)}>
      {children}
    </select>
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(INPUT_CLASS, 'min-h-24 resize-y', className)} />
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium text-ink-800">{label}</p>
        {description ? <p className="text-xs text-ink-500">{description}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-accent-600' : 'bg-ink-300',
        )}
      >
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
      </button>
    </div>
  )
}

/* -------------------------------------------------------------- data display */

export function Stat({ label, value, hint, tone = 'neutral', icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-ink-500 uppercase">{label}</span>
        {icon ? <span className="text-ink-400">{icon}</span> : null}
      </div>
      <div className={cn('tabular mt-2 text-2xl font-semibold', tone === 'critical' ? 'text-signal-critical' : tone === 'positive' ? 'text-signal-positive' : tone === 'warning' ? 'text-signal-warning' : 'text-ink-900')}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-ink-500">{hint}</div> : null}
    </div>
  )
}

export function EmptyState({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-200 bg-white/60 px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-ink-300">{icon}</div> : null}
      <p className="text-sm font-semibold text-ink-800">{title}</p>
      <p className="mt-1 max-w-md text-xs text-ink-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="font-medium underline">
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-ink-100', className)} />
}

export function ProgressBar({ value, tone = 'info', label }: { value: number; tone?: Tone; label?: string }) {
  const pct = Math.max(0, Math.min(100, value))
  const colour = tone === 'critical' ? 'bg-signal-critical' : tone === 'warning' ? 'bg-signal-warning' : tone === 'positive' ? 'bg-signal-positive' : 'bg-accent-500'
  return (
    <div>
      {label ? (
        <div className="mb-1 flex items-center justify-between text-xs text-ink-500">
          <span>{label}</span>
          <span className="tabular">{pct.toFixed(0)}%</span>
        </div>
      ) : null}
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
        <div className={cn('h-full rounded-full transition-all', colour)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-ink-100">
      {items.map((item) => (
        <div key={item.label} className="flex items-start justify-between gap-6 py-2">
          <dt className="text-xs text-ink-500">{item.label}</dt>
          <dd className="text-right text-xs font-medium text-ink-800">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* -------------------------------------------------------------------- tables */

export function Table({ headers, children, className }: { headers: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-left">
            {headers.map((header, index) => (
              <th key={index} className="px-3 py-2 text-[11px] font-semibold tracking-wide text-ink-500 uppercase whitespace-nowrap">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">{children}</tbody>
      </table>
    </div>
  )
}

/* ---------------------------------------------------------------- overlays */

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/50 p-4 sm:items-center">
      <div className={cn('surface w-full', wide ? 'max-w-3xl' : 'max-w-lg')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: string; count?: number }[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-ink-200">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
            active === tab.key ? 'border-accent-600 text-accent-700' : 'border-transparent text-ink-500 hover:text-ink-800',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function Toast({ message, tone = 'info', onDismiss }: { message: string; tone?: Tone; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000)
    return () => clearTimeout(timer)
  }, [message, onDismiss])
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
      <div className={cn('flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg', TONES[tone])}>
        <span>{message}</span>
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  )
}

/** Copy-to-clipboard with real feedback. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="subtle"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setCopied(false)
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function Sparkline({ points, className, tone = 'info' }: { points: number[]; className?: string; tone?: Tone }) {
  if (points.length === 0) return <div className={cn('h-8', className)} />
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const range = max - min || 1
  const width = 100
  const height = 32
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width
      const y = height - ((point - min) / range) * height
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const stroke = tone === 'positive' ? 'var(--color-signal-positive)' : tone === 'critical' ? 'var(--color-signal-critical)' : 'var(--color-accent-500)'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn('h-8 w-full', className)} preserveAspectRatio="none" aria-hidden>
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
