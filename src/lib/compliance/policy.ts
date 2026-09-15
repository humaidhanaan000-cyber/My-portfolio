/**
 * Compliance & autonomy policy engine.
 *
 * This module is the single place where the platform decides whether an action
 * is (a) permitted at all, and (b) executable autonomously or only after an
 * explicit human approval. Every agent, workflow and API route funnels through
 * `evaluateAction()`. There is no code path that executes an action without it
 * (the execution engine asserts this too).
 *
 * Prohibited categories are enforced structurally, not by prompt instructions:
 * the platform has no capability to perform them and the policy engine refuses
 * any payload that attempts them.
 */

export type ActionType =
  | 'research_scan'
  | 'clean_data'
  | 'analyze_opportunity'
  | 'generate_strategy'
  | 'generate_product_spec'
  | 'generate_content'
  | 'create_project'
  | 'update_project'
  | 'publish_content'
  | 'update_website_page'
  | 'send_transactional_email'
  | 'send_marketing_email'
  | 'create_account'
  | 'run_ad_campaign'
  | 'make_purchase'
  | 'spend_money'
  | 'financial_trade'
  | 'crypto_mining'
  | 'scrape_private_data'
  | 'bypass_captcha'
  | 'bypass_paywall'
  | 'bulk_scrape'
  | 'post_review'
  | 'delete_data'
  | 'system_maintenance'

export type RiskLevel = 'low' | 'medium' | 'high' | 'prohibited'

export type AutomationLevel = 'recommend_only' | 'approval_required' | 'autonomous_low_risk'

export type PolicyRule = {
  action: ActionType
  label: string
  risk: RiskLevel
  /** Cost ceiling above which the action always needs approval, in cents. */
  autonomousCostCeilingCents: number
  /** True when the action changes state outside the operator's own account. */
  isExternalSideEffect: boolean
  reason: string
}

/**
 * The autonomy matrix. `low` risk actions may run unattended (subject to the
 * user's automation level); `medium` and `high` always involve a human decision
 * unless the user explicitly selected the autonomous tier AND the action has no
 * external side effect and no cost.
 */
export const POLICY_RULES: Record<ActionType, PolicyRule> = {
  research_scan: { action: 'research_scan', label: 'Scan authorised sources', risk: 'low', autonomousCostCeilingCents: 50, isExternalSideEffect: false, reason: 'Read-only access to public APIs/RSS the operator is permitted to consume.' },
  clean_data: { action: 'clean_data', label: 'Normalise and de-duplicate data', risk: 'low', autonomousCostCeilingCents: 25, isExternalSideEffect: false, reason: 'Internal data hygiene only.' },
  analyze_opportunity: { action: 'analyze_opportunity', label: 'Score an opportunity', risk: 'low', autonomousCostCeilingCents: 60, isExternalSideEffect: false, reason: 'Pure analysis; no external effect.' },
  generate_strategy: { action: 'generate_strategy', label: 'Generate a business strategy', risk: 'low', autonomousCostCeilingCents: 150, isExternalSideEffect: false, reason: 'Internal document generation.' },
  generate_product_spec: { action: 'generate_product_spec', label: 'Generate a product specification', risk: 'low', autonomousCostCeilingCents: 150, isExternalSideEffect: false, reason: 'Internal document generation.' },
  generate_content: { action: 'generate_content', label: 'Draft content assets', risk: 'low', autonomousCostCeilingCents: 150, isExternalSideEffect: false, reason: 'Drafting is internal; publication is a separate, approval-gated action.' },
  create_project: { action: 'create_project', label: 'Create an internal project', risk: 'low', autonomousCostCeilingCents: 0, isExternalSideEffect: false, reason: 'Creates a container inside AIBA only.' },
  update_project: { action: 'update_project', label: 'Update project state', risk: 'low', autonomousCostCeilingCents: 0, isExternalSideEffect: false, reason: 'Internal state change.' },
  publish_content: { action: 'publish_content', label: 'Publish content publicly', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Irreversible public output and reputation risk. Human approval required.' },
  update_website_page: { action: 'update_website_page', label: 'Update a live website page', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Changes a public-facing asset the operator owns; approval required.' },
  send_transactional_email: { action: 'send_transactional_email', label: 'Send a transactional message', risk: 'medium', autonomousCostCeilingCents: 5, isExternalSideEffect: true, reason: 'Outbound message to a person who initiated contact.' },
  send_marketing_email: { action: 'send_marketing_email', label: 'Send marketing email', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Requires consent and human review to avoid spam.' },
  create_account: { action: 'create_account', label: 'Create an account on a third-party service', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Account creation must be performed by the human operator under the platform terms.' },
  run_ad_campaign: { action: 'run_ad_campaign', label: 'Launch a paid advertising campaign', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Spends real money publicly.' },
  make_purchase: { action: 'make_purchase', label: 'Purchase a good or service', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Directly spends money.' },
  spend_money: { action: 'spend_money', label: 'Incur a metered cost', risk: 'medium', autonomousCostCeilingCents: 25, isExternalSideEffect: false, reason: 'Metered API/compute cost inside the configured budget.' },
  financial_trade: { action: 'financial_trade', label: 'Execute a financial trade', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'AIBA never trades financial instruments or crypto.' },
  crypto_mining: { action: 'crypto_mining', label: 'Cryptocurrency mining', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Never performed; prohibited by platform policy.' },
  scrape_private_data: { action: 'scrape_private_data', label: 'Collect non-public personal data', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Privacy violation; structurally impossible in AIBA.' },
  bypass_captcha: { action: 'bypass_captcha', label: 'Circumvent a CAPTCHA', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Circumvention is never attempted.' },
  bypass_paywall: { action: 'bypass_paywall', label: 'Circumvent a paywall', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Paywall circumvention is never attempted.' },
  bulk_scrape: { action: 'bulk_scrape', label: 'Bulk scrape a website', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Only official APIs and permitted feeds are consumed.' },
  post_review: { action: 'post_review', label: 'Post a review or rating', risk: 'prohibited', autonomousCostCeilingCents: 0, isExternalSideEffect: true, reason: 'Fabricated or automated reviews are never generated.' },
  delete_data: { action: 'delete_data', label: 'Permanently delete data', risk: 'high', autonomousCostCeilingCents: 0, isExternalSideEffect: false, reason: 'Irreversible; requires explicit confirmation.' },
  system_maintenance: { action: 'system_maintenance', label: 'Internal maintenance task', risk: 'low', autonomousCostCeilingCents: 50, isExternalSideEffect: false, reason: 'Platform housekeeping.' },
}

/** Phrases that must never appear in generated, publishable content. */
export const PROHIBITED_CLAIM_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bguarantee(d|s)?\b[^.\n]{0,60}\b(income|profit|revenue|returns?|money|earn(ings)?)\b/i, label: 'guaranteed income/profit claim' },
  { pattern: /\bguaranteed?\b/i, label: 'guarantee claim' },
  { pattern: /\bmake\s+money\s+(while\s+)?(you\s+)?(sleep|do(ing)?\s+nothing)\b/i, label: 'money-while-doing-nothing claim' },
  { pattern: /\bpassive\s+income\s+(guaranteed|for\s+sure)\b/i, label: 'guaranteed passive income claim' },
  { pattern: /\bget\s+rich\s+quick\b/i, label: 'get-rich-quick claim' },
  { pattern: /\brisk[- ]free\s+(investment|returns?|profit)\b/i, label: 'risk-free return claim' },
  { pattern: /\b100%\s+(guaranteed|profit|safe)\b/i, label: 'absolute guarantee claim' },
  { pattern: /\bdouble\s+your\s+(money|revenue)\s+in\s+\d+\s+(days|weeks)\b/i, label: 'unrealistic growth promise' },
  { pattern: /\bno\s+work\s+(at\s+all\s+)?required\b/i, label: 'no-work claim' },
]

export type PolicyInput = {
  actionType: ActionType
  automationLevel: AutomationLevel
  estimatedCostCents?: number
  payload?: Record<string, unknown>
}

export type PolicyDecision = {
  allowed: boolean
  requiresApproval: boolean
  risk: RiskLevel
  reason: string
  policyLabel: string
  violations: string[]
  estimatedCostCents: number
}

/**
 * Decide whether an action may proceed, and whether it needs a human.
 * Callers MUST honour `allowed === false` (fail closed).
 */
export function evaluateAction(input: PolicyInput): PolicyDecision {
  const rule = POLICY_RULES[input.actionType]
  const cost = Math.max(0, Math.round(input.estimatedCostCents ?? 0))

  if (!rule) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: 'high',
      reason: `Unknown action type "${input.actionType}" — refused by default (fail-closed policy).`,
      policyLabel: 'unknown action',
      violations: ['unrecognised_action'],
      estimatedCostCents: cost,
    }
  }

  if (rule.risk === 'prohibited') {
    return {
      allowed: false,
      requiresApproval: false,
      risk: 'prohibited',
      reason: `${rule.reason} This class of action is permanently disabled in AIBA.`,
      policyLabel: rule.label,
      violations: [`prohibited:${input.actionType}`],
      estimatedCostCents: cost,
    }
  }

  const violations = input.payload ? inspectPayload(input.actionType, input.payload) : []
  if (violations.length > 0) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: 'high',
      reason: `Payload failed compliance inspection: ${violations.join('; ')}`,
      policyLabel: rule.label,
      violations,
      estimatedCostCents: cost,
    }
  }

  const overBudgetCeiling = cost > rule.autonomousCostCeilingCents && rule.autonomousCostCeilingCents >= 0
  const needsApproval =
    rule.risk === 'high' ||
    rule.risk === 'medium' ||
    overBudgetCeiling ||
    input.automationLevel === 'recommend_only' ||
    (input.automationLevel === 'approval_required' && rule.risk !== 'low')

  if (input.automationLevel === 'autonomous_low_risk' && rule.risk === 'low' && !overBudgetCeiling) {
    return {
      allowed: true,
      requiresApproval: false,
      risk: rule.risk,
      reason: `${rule.reason} Executed autonomously (user chose "autonomous low-risk").`,
      policyLabel: rule.label,
      violations: [],
      estimatedCostCents: cost,
    }
  }

  if (input.automationLevel === 'recommend_only') {
    return {
      allowed: false,
      requiresApproval: true,
      risk: rule.risk,
      reason: 'Automation level is "recommendation only": AIBA will describe the action and wait for you to perform or approve it.',
      policyLabel: rule.label,
      violations: [],
      estimatedCostCents: cost,
    }
  }

  if (needsApproval) {
    const costNote = cost > 0 ? ` Estimated cost ${(cost / 100).toFixed(2)}.` : ''
    return {
      allowed: false,
      requiresApproval: true,
      risk: rule.risk,
      reason: `${rule.reason}${costNote} Human approval required before execution.`,
      policyLabel: rule.label,
      violations: [],
      estimatedCostCents: cost,
    }
  }

  return {
    allowed: true,
    requiresApproval: false,
    risk: rule.risk,
    reason: rule.reason,
    policyLabel: rule.label,
    violations: [],
    estimatedCostCents: cost,
  }
}

const SUSPICIOUS_PAYLOAD_KEYS = [
  'captcha',
  'paywall',
  'credentials',
  'password',
  'creditCard',
  'credit_card',
  'seedPhrase',
  'privateKey',
  'scrapeHtml',
  'bulkDownload',
  'fakeAccount',
  'autoReview',
]

function inspectPayload(action: ActionType, payload: Record<string, unknown>): string[] {
  const violations: string[] = []
  const flat = JSON.stringify(payload ?? {}).toLowerCase()
  for (const key of SUSPICIOUS_PAYLOAD_KEYS) {
    if (flat.includes(key.toLowerCase())) {
      violations.push(`payload references "${key}" which AIBA cannot process`)
    }
  }
  if (action === 'spend_money' && typeof payload.amountCents === 'number' && payload.amountCents < 0) {
    violations.push('negative spend amount')
  }
  return violations
}

export type ContentInspection = {
  clean: boolean
  violations: string[]
  blockedPhrases: string[]
}

/** Scan generated copy before it can be stored as a publishable asset. */
export function inspectContent(content: string): ContentInspection {
  const violations: string[] = []
  const blockedPhrases: string[] = []
  for (const { pattern, label } of PROHIBITED_CLAIM_PATTERNS) {
    const match = pattern.exec(content)
    if (match) {
      violations.push(label)
      blockedPhrases.push(match[0])
    }
  }
  return { clean: violations.length === 0, violations, blockedPhrases }
}

/**
 * Rewrite risky claims into honest language. Used on AI output before storage —
 * the operator always sees the original wording in the run log if it changed.
 */
export function sanitizeClaims(content: string): { content: string; changed: string[] } {
  let result = content
  const changed: string[] = []
  const replacements: [RegExp, string][] = [
    [/\bguaranteed\s+(income|profit|revenue|returns?|money)\b/gi, '$1 can be projected but is never guaranteed'],
    [/\bguarantees?\s+(income|profit|revenue|returns?|money)\b/gi, 'can only project $1 — never guaranteed'],
    [/\bmake\s+money\s+(while\s+you\s+)?(sleep|do(?:ing)?\s+nothing)\b/gi, 'operate with limited ongoing manual effort'],
    [/\brisk[- ]free\s+(investment|returns?|profit)\b/gi, 'lower-risk (still uncertain) $1'],
    [/\b100%\s+(guaranteed|profit|safe)\b/gi, 'not guaranteed'],
    [/\bget\s+rich\s+quick\b/gi, 'unrealistic returns promise (removed)'],
    [/\bno\s+work\s+(at\s+all\s+)?required\b/gi, 'ongoing maintenance is still required'],
  ]
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(result)) {
      const before = result
      result = result.replace(pattern, replacement)
      if (before !== result) changed.push(String(pattern))
    }
  }
  return { content: result, changed }
}

/** Human-readable summary of the platform's boundaries, surfaced in the UI. */
export const POLICY_SUMMARY = [
  'Only official APIs, permitted feeds and manual entries are used as data sources.',
  'No CAPTCHA, paywall, authentication or anti-bot circumvention — ever.',
  'No account creation, no impersonation, no automated reviews, no spam.',
  'No financial trading, no cryptocurrency mining, no unauthorised purchases.',
  'Any action that is paid, public, irreversible or external stops for approval.',
  'All financial figures are estimates or projections until verified by real financial data.',
]
