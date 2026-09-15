import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function slugify(input: string, max = 60): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return base || 'item'
}

export function truncate(input: string, length = 160): string {
  if (input.length <= length) return input
  return `${input.slice(0, length - 1).trimEnd()}…`
}

/** Stable content fingerprint used for opportunity de-duplication. */
export function fingerprint(...parts: (string | undefined | null)[]): string {
  const normalized = parts
    .filter(Boolean)
    .map((p) =>
      String(p)
        .toLowerCase()
        .replace(/https?:\/\//g, '')
        .replace(/[?&](utm_[^=]+|ref|source|fbclid)=[^&]*/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim(),
    )
    .join('|')
  // FNV-1a 64-bit-ish (two 32-bit passes) — deterministic, no crypto dependency.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + Math.imul(c, 0x85ebca6b)) >>> 0
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

export function formatMoney(cents: number | string | null | undefined, currency = 'USD'): string {
  const value = typeof cents === 'string' ? Number.parseFloat(cents) : (cents ?? 0)
  const amount = Number.isFinite(value) ? value / 100 : 0
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

export function formatCompactMoney(cents: number | null | undefined, currency = 'USD'): string {
  const amount = (cents ?? 0) / 100
  const abs = Math.abs(amount)
  const symbol = currency === 'USD' ? '$' : `${currency} `
  if (abs >= 1_000_000) return `${symbol}${(amount / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${symbol}${(amount / 1_000).toFixed(1)}k`
  return `${symbol}${amount.toFixed(2)}`
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value ?? 0)
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return `${(value ?? 0).toFixed(digits)}%`
}

export function formatDate(value: Date | string | null | undefined, withTime = true): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  })
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  const diff = Date.now() - date.getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  const units: [number, string][] = [
    [1000, 's'],
    [60_000, 'm'],
    [3_600_000, 'h'],
    [86_400_000, 'd'],
  ]
  if (abs < 60_000) return future ? 'in <1m' : 'just now'
  if (abs < 3_600_000) return future ? `in ${Math.round(abs / units[1][0])}m` : `${Math.round(abs / units[1][0])}m ago`
  if (abs < 86_400_000) return future ? `in ${Math.round(abs / units[2][0])}h` : `${Math.round(abs / units[2][0])}h ago`
  return future ? `in ${Math.round(abs / units[3][0])}d` : `${Math.round(abs / units[3][0])}d ago`
}

export function humanDuration(ms: number | null | undefined): string {
  const value = ms ?? 0
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
  const days = Math.floor(value / 86_400_000)
  const hours = Math.floor((value % 86_400_000) / 3_600_000)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`
}

export function uptimeSeconds(): number {
  return Math.floor(process.uptime())
}

export function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T
  } catch {
    return fallback
  }
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function toSentenceCase(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

export function variance(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const varianceValue = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return { mean, stddev: Math.sqrt(varianceValue) }
}

/** Percent change helper used across analytics widgets. */
export function percentChange(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100
  return ((current - previous) / Math.abs(previous)) * 100
}

export function startOfDay(date = new Date()): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export function startOfWeek(date = new Date()): Date {
  const d = startOfDay(date)
  const day = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7))
  return d
}

export function startOfMonth(date = new Date()): Date {
  const d = startOfDay(date)
  d.setUTCDate(1)
  return d
}

export function parseMoneyToCents(input: string | number): number {
  if (typeof input === 'number') return Math.round(input * 100)
  const cleaned = input.replace(/[^0-9.-]/g, '')
  const value = Number.parseFloat(cleaned)
  return Number.isFinite(value) ? Math.round(value * 100) : 0
}

export function centsToInputString(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** `2026-09-14` style bucket key (UTC) for time-series grouping. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'INR', 'LKR', 'SGD', 'AED', 'JPY', 'BRL', 'ZAR']

export const RISK_TOLERANCES = ['conservative', 'balanced', 'aggressive'] as const
export const AUTOMATION_LEVELS = ['recommend_only', 'approval_required', 'autonomous_low_risk'] as const

export const AUTOMATION_LEVEL_LABELS: Record<string, string> = {
  recommend_only: 'Recommendation only',
  approval_required: 'Approval required',
  autonomous_low_risk: 'Autonomous low-risk actions',
}
