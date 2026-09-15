/** Project lifecycle states and their allowed transitions. */
export const PROJECT_STATUSES = [
  'DISCOVERED',
  'ANALYZING',
  'STRATEGY_READY',
  'WAITING_FOR_APPROVAL',
  'APPROVED',
  'BUILDING',
  'LAUNCHED',
  'MONITORING',
  'OPTIMIZING',
  'PAUSED',
  'FAILED',
  'COMPLETED',
] as const

export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DISCOVERED: ['ANALYZING', 'FAILED'],
  ANALYZING: ['STRATEGY_READY', 'FAILED'],
  STRATEGY_READY: ['WAITING_FOR_APPROVAL', 'APPROVED', 'FAILED'],
  WAITING_FOR_APPROVAL: ['APPROVED', 'PAUSED', 'FAILED'],
  APPROVED: ['BUILDING', 'PAUSED', 'FAILED'],
  BUILDING: ['LAUNCHED', 'PAUSED', 'FAILED'],
  LAUNCHED: ['MONITORING', 'OPTIMIZING', 'PAUSED', 'FAILED', 'COMPLETED'],
  MONITORING: ['OPTIMIZING', 'PAUSED', 'FAILED', 'COMPLETED'],
  OPTIMIZING: ['MONITORING', 'PAUSED', 'FAILED', 'COMPLETED'],
  PAUSED: ['BUILDING', 'LAUNCHED', 'MONITORING', 'FAILED', 'COMPLETED'],
  FAILED: ['PAUSED', 'COMPLETED'],
  COMPLETED: [],
}

export function canTransition(from: string, to: string): boolean {
  const allowed = PROJECT_TRANSITIONS[from as ProjectStatus]
  if (!allowed) return false
  return allowed.includes(to as ProjectStatus)
}

export const STATUS_LABELS: Record<string, string> = {
  DISCOVERED: 'Discovered',
  ANALYZING: 'Analyzing',
  STRATEGY_READY: 'Strategy ready',
  WAITING_FOR_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved',
  BUILDING: 'Building',
  LAUNCHED: 'Launched',
  MONITORING: 'Monitoring',
  OPTIMIZING: 'Optimizing',
  PAUSED: 'Paused',
  FAILED: 'Failed',
  COMPLETED: 'Completed',
}

export const ACTIVE_STATUSES: string[] = ['APPROVED', 'BUILDING', 'LAUNCHED', 'MONITORING', 'OPTIMIZING']
