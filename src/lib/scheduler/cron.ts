/**
 * Cron expression support (5-field: minute hour day-of-month month day-of-week).
 * Supports wildcards, lists (1,2), ranges (1-5), steps (star-slash-15, 0-30/5)
 * and named days/months. Implemented locally so scheduling has no runtime
 * dependency.
 */

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields, got ${parts.length}`)
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12, MONTH_NAMES),
    // Standard cron allows 7 for Sunday as well as 0; both map to 0.
    dayOfWeek: [...new Set(parseField(parts[4]!, 0, 7, DAY_NAMES).map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b),
  }
}

function parseField(raw: string, min: number, max: number, names: Record<string, number> = {}): number[] {
  const values = new Set<number>()
  for (const chunk of raw.split(',')) {
    const [rangePart, stepPart] = chunk.split('/')
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1
    if (!Number.isFinite(step) || step < 1) throw new Error(`Invalid cron step in "${chunk}"`)

    let start: number
    let end: number
    if (rangePart === '*' || rangePart === '') {
      start = min
      end = max
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-')
      start = resolve(a!, names)
      end = resolve(b!, names)
    } else {
      start = resolve(rangePart!, names)
      end = stepPart ? max : start
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Invalid cron value in "${chunk}"`)
    // Out-of-range values (a minute of 99, a month of 13) must be rejected rather
    // than silently clamped: clamping produced empty fields that "validated" and
    // then failed at scheduling time.
    if (start < min || start > max) throw new Error(`Invalid cron value ${start} in "${chunk}" (expected ${min}-${max})`)
    if (end < min || end > max) throw new Error(`Invalid cron value ${end} in "${chunk}" (expected ${min}-${max})`)
    if (start > end) throw new Error(`Invalid cron range "${chunk}" (start is after end)`)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`Cron field "${raw}" matches no value`)
  return [...values].sort((a, b) => a - b)
}

function resolve(token: string, names: Record<string, number>): number {
  const lower = token.toLowerCase()
  if (lower in names) return names[lower]!
  return Number.parseInt(token, 10)
}

/** Next time the expression fires, strictly after `from`. */
export function nextCronRun(expression: string, from: Date = new Date(), timezone: 'UTC' = 'UTC'): Date {
  const fields = parseCron(expression)
  const candidate = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  void timezone // evaluation is in UTC; add tz handling here if per-user schedules need local time
  const limit = 60 * 24 * 366 * 2 // two years of minutes

  for (let i = 0; i < limit; i++) {
    const minute = candidate.getUTCMinutes()
    const hour = candidate.getUTCHours()
    const dom = candidate.getUTCDate()
    const month = candidate.getUTCMonth() + 1
    const dow = candidate.getUTCDay()

    if (
      fields.minute.includes(minute) &&
      fields.hour.includes(hour) &&
      fields.month.includes(month) &&
      (fields.dayOfMonth.includes(dom) || expression.startsWith('*')) &&
      fields.dayOfWeek.includes(dow)
    ) {
      return candidate
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  }
  throw new Error(`Could not find next run for cron "${expression}" within two years`)
}

export function describeCron(expression: string): string {
  const presets: Record<string, string> = {
    '*/15 * * * *': 'Every 15 minutes',
    '0 * * * *': 'Hourly',
    '0 */3 * * *': 'Every 3 hours',
    '0 */6 * * *': 'Every 6 hours',
    '0 8 * * *': 'Daily at 08:00 UTC',
    '0 3 * * *': 'Daily at 03:00 UTC',
    '0 8 * * 1': 'Weekly on Monday 08:00 UTC',
    '0 3 * * 1': 'Weekly on Monday 03:00 UTC',
    '*/5 * * * *': 'Every 5 minutes',
  }
  if (expression in presets) return presets[expression]!
  let fields: CronFields
  try {
    fields = parseCron(expression)
  } catch {
    return 'Invalid schedule'
  }

  // Beyond the named presets, describe the common shapes accurately — an
  // operator reading "custom schedule" cannot tell 07:00 from 03:00.
  const [minuteField, hourField, domField, monthField, dowField] = expression.trim().split(/\s+/)
  const pad = (value: number) => String(value).padStart(2, '0')
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const everyN = /^\*\/(\d+)$/.exec(minuteField ?? '')
  const everyDay = domField === '*' && monthField === '*' && dowField === '*'
  const singleMinute = fields.minute.length === 1 ? fields.minute[0]! : null
  const singleHour = fields.hour.length === 1 ? fields.hour[0]! : null

  if (everyN && hourField === '*' && everyDay) return `Every ${everyN[1]} minutes`
  if (minuteField === '*' && hourField === '*' && everyDay) return 'Every minute'
  if (singleMinute !== null && hourField === '*' && everyDay) return `Every hour at :${pad(singleMinute)} UTC`
  if (singleMinute !== null && singleHour !== null && everyDay) return `Daily at ${pad(singleHour)}:${pad(singleMinute)} UTC`
  if (singleMinute !== null && singleHour !== null && domField === '*' && monthField === '*' && fields.dayOfWeek.length === 1) {
    return `Weekly on ${dayNames[fields.dayOfWeek[0]!]} ${pad(singleHour)}:${pad(singleMinute)} UTC`
  }
  if (singleMinute !== null && singleHour !== null && domField !== '*' && monthField === '*' && dowField === '*') {
    return `Monthly on day ${fields.dayOfMonth[0]} at ${pad(singleHour)}:${pad(singleMinute)} UTC`
  }
  if (hourField === '*' && everyDay && fields.minute.length > 1) {
    return `Several times an hour (minutes ${fields.minute.map((m) => pad(m)).join(', ')})`
  }
  return `Custom schedule (${expression})`
}

export const SCHEDULE_PRESETS = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 3 hours', cron: '0 */3 * * *' },
  { label: 'Daily', cron: '0 8 * * *' },
  { label: 'Weekly', cron: '0 8 * * 1' },
]

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}
