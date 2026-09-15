'use client'

export { cn, formatCompactMoney, formatDate, formatMoney, formatNumber, formatPercent, relativeTime, truncate } from '@/lib/utils'

export const STATUS_TONE: Record<string, string> = {
  discovered: 'border-ink-200 bg-ink-50 text-ink-600',
  cleaned: 'border-ink-200 bg-ink-50 text-ink-600',
  scored: 'border-accent-200 bg-accent-50 text-accent-700',
  strategy_ready: 'border-violet-200 bg-violet-50 text-violet-700',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  rejected: 'border-red-200 bg-red-50 text-red-700',
  archived: 'border-ink-200 bg-ink-100 text-ink-500',
}
