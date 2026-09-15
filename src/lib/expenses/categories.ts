/**
 * Expense categories.
 *
 * Defined once and imported by both the API route and the dashboard, so the
 * picker in the interface can never drift from what the server accepts.
 */
export const EXPENSE_CATEGORIES = [
  'ai_usage',
  'hosting',
  'domain',
  'software_subscription',
  'api_credits',
  'advertising',
  'payment_fees',
  'contractor',
  'content_production',
  'tools',
  'miscellaneous',
  'other',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]
