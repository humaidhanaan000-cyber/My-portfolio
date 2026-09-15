/**
 * AIBA — Database schema (PostgreSQL / Drizzle ORM)
 *
 * Design rules
 * ------------
 *  - Every tenant-scoped table carries `workspaceId` with a FK + index so the
 *    query layer can enforce isolation. There is no cross-tenant query helper.
 *  - Money is stored as integer minor units (cents) to avoid float drift.
 *  - Soft deletion (`deletedAt`) is used where history matters (users, workspaces,
 *    opportunities, projects, content assets) and hard deletes elsewhere.
 *  - Enum-like columns are `text` + application-level (zod) validation, so that
 *    business vocabulary can evolve without a database migration lock.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

/* ------------------------------------------------------------------ identity */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull().default('user'), // user | admin
    status: text('status').notNull().default('active'), // active | suspended
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: now(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), index('users_status_idx').on(t.status)],
)

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planKey: text('plan_key').notNull().default('free'),
    demoMode: boolean('demo_mode').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('workspaces_slug_uq').on(t.slug), index('workspaces_owner_idx').on(t.ownerId)],
)

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'), // owner | admin | member | viewer
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('memberships_ws_user_uq').on(t.workspaceId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
)

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    legalName: text('legal_name'),
    country: text('country').notNull().default('US'),
    currency: text('currency').notNull().default('USD'),
    interests: text('interests').array().notNull().default([]),
    skills: text('skills').array().notNull().default([]),
    industries: text('industries').array().notNull().default([]),
    businessModels: text('business_models').array().notNull().default([]),
    monetizationPreferences: text('monetization_preferences').array().notNull().default([]),
    riskTolerance: text('risk_tolerance').notNull().default('balanced'), // conservative | balanced | aggressive
    automationLevel: text('automation_level').notNull().default('approval_required'), // recommend_only | approval_required | autonomous_low_risk
    dailyBudgetCents: integer('daily_budget_cents').notNull().default(500),
    monthlyBudgetCents: integer('monthly_budget_cents').notNull().default(5000),
    maxProjectBudgetCents: integer('max_project_budget_cents').notNull().default(20000),
    perAgentDailyLimitCents: integer('per_agent_daily_limit_cents').notNull().default(2000),
    scoreThreshold: integer('score_threshold').notNull().default(70),
    minTimeToRevenueDays: integer('min_time_to_revenue_days').notNull().default(0),
    maxOperatingCostCentsMonth: integer('max_operating_cost_cents_month').notNull().default(10000),
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifyBrowser: boolean('notify_browser').notNull().default(true),
    notifyTelegram: boolean('notify_telegram').notNull().default(false),
    telegramChatId: text('telegram_chat_id'),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('profiles_ws_uq').on(t.workspaceId)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('sessions_token_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
)

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // email_verify | password_reset | invite
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_uq').on(t.tokenHash),
    index('auth_tokens_user_type_idx').on(t.userId, t.type),
  ],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: text('actor_type').notNull().default('user'), // user | agent | system
    actorKey: text('actor_key'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: now(),
  },
  (t) => [
    index('audit_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('audit_entity_idx').on(t.entityType, t.entityId),
  ],
)

/* ------------------------------------------------------- billing & settings */

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    tagline: text('tagline').notNull().default(''),
    priceMonthlyCents: integer('price_monthly_cents').notNull().default(0),
    priceYearlyCents: integer('price_yearly_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    features: jsonb('features').$type<string[]>().notNull().default([]),
    limits: jsonb('limits')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    providerPriceId: text('provider_price_id'),
    isPublic: boolean('is_public').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('plans_key_uq').on(t.key)],
)

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planKey: text('plan_key').notNull().default('free'),
    status: text('status').notNull().default('active'), // active|trialing|past_due|canceled|incomplete|none
    provider: text('provider').notNull().default('none'), // stripe | manual | none
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('subscriptions_ws_uq').on(t.workspaceId),
    index('subscriptions_provider_uq').on(t.providerSubscriptionId),
  ],
)

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    type: text('type').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    payload: jsonb('payload'),
    status: text('status').notNull().default('received'), // received|processed|ignored|failed
    error: text('error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [uniqueIndex('payment_events_provider_uq').on(t.provider, t.providerEventId)],
)

export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedAt: updated(),
    createdAt: now(),
  },
  (t) => [uniqueIndex('settings_scope_key_uq').on(t.workspaceId, t.key)],
)

/* ------------------------------------------------------------ agent runtime */

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default('core'),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status').notNull().default('idle'), // idle | running | error | disabled
    modelTier: text('model_tier').notNull().default('standard'), // cheap | standard | reasoning
    maxDailyRuns: integer('max_daily_runs').notNull().default(500),
    maxCostCentsPerRun: integer('max_cost_cents_per_run').notNull().default(25),
    timeoutSeconds: integer('timeout_seconds').notNull().default(120),
    avgDurationMs: integer('avg_duration_ms').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('agents_key_uq').on(t.key)],
)

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key').notNull(),
    jobId: uuid('job_id'),
    triggeredBy: text('triggered_by').notNull().default('system'), // system|schedule|user|api|agent
    status: text('status').notNull().default('running'), // running|succeeded|failed|timeout|cancelled
    input: jsonb('input'),
    output: jsonb('output').$type<unknown>(),
    error: text('error'),
    attempt: integer('attempt').notNull().default(1),
    provider: text('provider'),
    model: text('model'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    index('agent_runs_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('agent_runs_agent_idx').on(t.agentKey, t.startedAt),
    index('agent_runs_status_idx').on(t.status),
  ],
)

export const agentMemory = pgTable(
  'agent_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key').notNull(),
    kind: text('kind').notNull(), // insight | decision | preference | pattern | summary
    key: text('key').notNull(),
    content: text('content').notNull(),
    importance: integer('importance').notNull().default(3), // 1..5
    refType: text('ref_type'),
    refId: text('ref_id'),
    data: jsonb('data'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    index('agent_memory_ws_agent_idx').on(t.workspaceId, t.agentKey),
    index('agent_memory_key_idx').on(t.workspaceId, t.key),
  ],
)

export const memorySummaries = pgTable(
  'memory_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(), // workspace | category | project
    scopeKey: text('scope_key'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    summary: text('summary').notNull(),
    metrics: jsonb('metrics'),
    createdAt: now(),
  },
  (t) => [index('memory_summaries_ws_idx').on(t.workspaceId, t.scope, t.periodEnd)],
)

/* ------------------------------------------------------- opportunity engine */

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull().default('api'), // api | rss | public_dataset | manual | partner
    url: text('url'),
    apiEndpoint: text('api_endpoint'),
    permissionStatus: text('permission_status').notNull().default('public_api'), // public_api | permitted | manual_only | prohibited
    termsUrl: text('terms_url'),
    requiresCredentials: boolean('requires_credentials').notNull().default(false),
    credentialEnvVar: text('credential_env_var'),
    rateLimitPerHour: integer('rate_limit_per_hour').notNull().default(60),
    reliabilityScore: numeric('reliability_score', { precision: 5, scale: 2 }).notNull().default('50'),
    categories: text('categories').array().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
    lastScanStatus: text('last_scan_status'),
    lastError: text('last_error'),
    scanCount: integer('scan_count').notNull().default(0),
    discoveredCount: integer('discovered_count').notNull().default(0),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('sources_name_ws_uq').on(t.name, t.workspaceId),
    index('sources_ws_idx').on(t.workspaceId),
    index('sources_enabled_idx').on(t.enabled),
  ],
)

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceName: text('source_name').notNull().default('manual'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    url: text('url'),
    category: text('category').notNull().default('other'),
    tags: text('tags').array().notNull().default([]),
    region: text('region'),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('discovered'), // discovered|cleaned|scored|strategy_ready|approved|rejected|archived
    spamScore: numeric('spam_score', { precision: 5, scale: 2 }).notNull().default('0'),
    relevancyScore: numeric('relevancy_score', { precision: 5, scale: 2 }).notNull().default('0'),
    urlValid: boolean('url_valid').notNull().default(true),
    isDuplicateOf: uuid('is_duplicate_of'),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    cleanedAt: timestamp('cleaned_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    decision: text('decision'), // approved | rejected | archived
    decisionNote: text('decision_note'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    demo: boolean('demo').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('opportunities_fingerprint_uq').on(t.workspaceId, t.fingerprint),
    index('opportunities_ws_status_idx').on(t.workspaceId, t.status),
    index('opportunities_ws_category_idx').on(t.workspaceId, t.category),
    index('opportunities_discovered_idx').on(t.workspaceId, t.discoveredAt),
  ],
)

export const opportunityScores = pgTable(
  'opportunity_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    demand: integer('demand').notNull().default(50),
    competition: integer('competition').notNull().default(50),
    monetization: integer('monetization').notNull().default(50),
    startupCost: integer('startup_cost').notNull().default(50),
    operatingCost: integer('operating_cost').notNull().default(50),
    automationPotential: integer('automation_potential').notNull().default(50),
    scalability: integer('scalability').notNull().default(50),
    timeToRevenue: integer('time_to_revenue').notNull().default(50),
    difficulty: integer('difficulty').notNull().default(50),
    risk: integer('risk').notNull().default(50),
    finalScore: numeric('final_score', { precision: 5, scale: 2 }).notNull(),
    confidence: integer('confidence').notNull().default(60),
    verdict: text('verdict').notNull().default('consider'), // strong_buy | consider | watch | avoid
    rationale: jsonb('rationale').$type<Record<string, string>>().notNull().default({}),
    summary: text('summary').notNull().default(''),
    weights: jsonb('weights').$type<Record<string, number>>().notNull().default({}),
    engine: text('engine').notNull().default('heuristic'),
    provider: text('provider'),
    model: text('model'),
    version: integer('version').notNull().default(1),
    createdAt: now(),
  },
  (t) => [
    index('opp_scores_opp_idx').on(t.opportunityId, t.createdAt),
    index('opp_scores_ws_score_idx').on(t.workspaceId, t.finalScore),
  ],
)

export const strategies = pgTable(
  'strategies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('draft'), // draft | approved | archived
    title: text('title').notNull().default(''),
    problem: text('problem').notNull().default(''),
    targetCustomer: text('target_customer').notNull().default(''),
    solution: text('solution').notNull().default(''),
    businessModel: text('business_model').notNull().default(''),
    monetization: text('monetization').notNull().default(''),
    acquisition: text('acquisition').notNull().default(''),
    operatingModel: text('operating_model').notNull().default(''),
    costEstimate: jsonb('cost_estimate').$type<Record<string, unknown>>(),
    scenarios: jsonb('scenarios').$type<Record<string, unknown>>(),
    risks: jsonb('risks').$type<unknown[]>().notNull().default([]),
    techRequirements: jsonb('tech_requirements').$type<unknown[]>().notNull().default([]),
    launchPlan: jsonb('launch_plan').$type<unknown[]>().notNull().default([]),
    successMetrics: jsonb('success_metrics').$type<unknown[]>().notNull().default([]),
    engine: text('engine').notNull().default('heuristic'),
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    index('strategies_opp_idx').on(t.opportunityId, t.version),
    index('strategies_ws_idx').on(t.workspaceId, t.createdAt),
  ],
)

/* ------------------------------------------------------------------ projects */

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    strategyId: uuid('strategy_id').references(() => strategies.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    objective: text('objective').notNull().default(''),
    status: text('status').notNull().default('DISCOVERED'),
    businessModel: text('business_model').notNull().default(''),
    revenueModel: text('revenue_model').notNull().default(''),
    costModel: jsonb('cost_model').$type<Record<string, unknown>>(),
    automationLevel: text('automation_level').notNull().default('approval_required'),
    budgetCents: integer('budget_cents').notNull().default(0),
    spentCents: integer('spent_cents').notNull().default(0),
    revenueCents: integer('revenue_cents').notNull().default(0),
    profitCents: integer('profit_cents').notNull().default(0),
    progress: integer('progress').notNull().default(0),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    demo: boolean('demo').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_ws_slug_uq').on(t.workspaceId, t.slug),
    index('projects_ws_status_idx').on(t.workspaceId, t.status),
    index('projects_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('todo'), // todo|in_progress|blocked|done|failed|cancelled
    priority: integer('priority').notNull().default(3),
    assigneeAgentKey: text('assignee_agent_key'),
    dependsOn: uuid('depends_on').array().notNull().default([]),
    position: integer('position').notNull().default(0),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    estimatedCostCents: integer('estimated_cost_cents').notNull().default(0),
    actualCostCents: integer('actual_cost_cents').notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    result: jsonb('result'),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    index('tasks_project_idx').on(t.projectId, t.position),
    index('tasks_ws_status_idx').on(t.workspaceId, t.status),
  ],
)

export const projectEvents = pgTable(
  'project_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message').notNull(),
    actor: text('actor').notNull().default('system'),
    data: jsonb('data'),
    createdAt: now(),
  },
  (t) => [index('project_events_project_idx').on(t.projectId, t.createdAt)],
)

/* ----------------------------------------------------------------- workflows */

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    definition: jsonb('definition').$type<{ nodes: unknown[]; edges: unknown[] }>().notNull(),
    schedule: text('schedule'), // cron expression or null
    scheduleTimezone: text('schedule_timezone').notNull().default('UTC'),
    status: text('status').notNull().default('active'), // active | paused | archived
    enabled: boolean('enabled').notNull().default(true),
    isTemplate: boolean('is_template').notNull().default(false),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    runCount: integer('run_count').notNull().default(0),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [index('workflows_ws_idx').on(t.workspaceId), index('workflows_next_run_idx').on(t.nextRunAt)],
)

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull().default('manual'), // manual | schedule | api
    status: text('status').notNull().default('running'), // running|succeeded|failed|partial|awaiting_approval
    steps: jsonb('steps').$type<unknown[]>().notNull().default([]),
    contextData: jsonb('context_data').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    attempt: integer('attempt').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: now(),
  },
  (t) => [index('workflow_runs_wf_idx').on(t.workflowId, t.createdAt)],
)

/* ----------------------------------------------------------------- approvals */

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    workflowRunId: uuid('workflow_run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
    actionType: text('action_type').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull().default(''),
    expectedCostCents: integer('expected_cost_cents').notNull().default(0),
    potentialBenefit: text('potential_benefit').notNull().default(''),
    risk: text('risk').notNull().default('medium'), // low | medium | high
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'), // pending|approved|rejected|deferred|expired|executed|failed
    requestedByAgent: text('requested_by_agent').notNull().default('system'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decisionNote: text('decision_note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    deferUntil: timestamp('defer_until', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    executionResult: jsonb('execution_result'),
    executionError: text('execution_error'),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    index('approvals_ws_status_idx').on(t.workspaceId, t.status),
    index('approvals_project_idx').on(t.projectId),
  ],
)

/* ------------------------------------------------------------ content assets */

export const contentAssets = pgTable(
  'content_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull().default(''),
    summary: text('summary').notNull().default(''),
    body: text('body').notNull().default(''),
    format: text('format').notNull().default('markdown'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    version: integer('version').notNull().default(1),
    parentVersionId: uuid('parent_version_id'),
    status: text('status').notNull().default('draft'), // draft|in_review|approved|published|archived
    publishedUrl: text('published_url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    engine: text('engine').notNull().default('heuristic'),
    provider: text('provider'),
    model: text('model'),
    storageKey: text('storage_key'),
    demo: boolean('demo').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('content_assets_ws_type_idx').on(t.workspaceId, t.type),
    index('content_assets_project_idx').on(t.projectId),
    index('content_assets_status_idx').on(t.workspaceId, t.status),
  ],
)

/* ------------------------------------------------------- money & guardrails */

export const revenueTransactions = pgTable(
  'revenue_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('manual'),
    provider: text('provider'),
    providerTransactionId: text('provider_transaction_id'),
    description: text('description').notNull().default(''),
    grossCents: integer('gross_cents').notNull().default(0),
    feeCents: integer('fee_cents').notNull().default(0),
    netCents: integer('net_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    status: text('status').notNull().default('confirmed'), // pending|confirmed|refunded|disputed
    verification: text('verification').notNull().default('manual'), // verified_integration | manual | imported
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    demo: boolean('demo').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    index('revenue_ws_occurred_idx').on(t.workspaceId, t.occurredAt),
    index('revenue_project_idx').on(t.projectId),
    uniqueIndex('revenue_provider_tx_uq').on(t.provider, t.providerTransactionId),
  ],
)

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    category: text('category').notNull().default('other'),
    description: text('description').notNull().default(''),
    amountCents: integer('amount_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    provider: text('provider'),
    verification: text('verification').notNull().default('manual'), // verified_integration | manual | metered_estimate
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    demo: boolean('demo').notNull().default(false),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    index('expenses_ws_occurred_idx').on(t.workspaceId, t.occurredAt),
    index('expenses_category_idx').on(t.workspaceId, t.category),
  ],
)

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('workspace'), // workspace | project | agent
    scopeKey: text('scope_key'),
    period: text('period').notNull().default('monthly'), // daily | monthly | total
    limitCents: integer('limit_cents').notNull().default(0),
    alertThresholdPct: integer('alert_threshold_pct').notNull().default(80),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('budgets_scope_uq').on(t.workspaceId, t.scope, t.scopeKey, t.period)],
)

export const budgetLedger = pgTable(
  'budget_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('workspace'),
    scopeKey: text('scope_key'),
    direction: text('direction').notNull().default('debit'), // debit | credit (reservation release)
    amountCents: integer('amount_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    reason: text('reason').notNull().default(''),
    refType: text('ref_type'),
    refId: text('ref_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    index('budget_ledger_ws_time_idx').on(t.workspaceId, t.occurredAt),
    index('budget_ledger_scope_idx').on(t.workspaceId, t.scope, t.scopeKey),
  ],
)

/* --------------------------------------------------- analytics & operations */

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    name: text('name').notNull().default(''),
    value: numeric('value', { precision: 14, scale: 4 }).notNull().default('0'),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
    visitorId: text('visitor_id'),
    url: text('url'),
    demo: boolean('demo').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    index('analytics_ws_type_time_idx').on(t.workspaceId, t.type, t.occurredAt),
    index('analytics_project_idx').on(t.projectId, t.occurredAt),
  ],
)

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('info'), // info | success | warning | critical
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    channels: text('channels').array().notNull().default([]),
    status: text('status').notNull().default('unread'), // unread | read
    delivery: jsonb('delivery').$type<Record<string, string>>().notNull().default({}),
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    index('notifications_ws_status_idx').on(t.workspaceId, t.status, t.createdAt),
    index('notifications_dedupe_idx').on(t.workspaceId, t.dedupeKey, t.createdAt),
  ],
)

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('warning'),
    title: text('title').notNull(),
    message: text('message').notNull().default(''),
    source: text('source').notNull().default('system'),
    status: text('status').notNull().default('open'), // open | acknowledged | resolved
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [index('alerts_ws_status_idx').on(t.workspaceId, t.status, t.lastSeenAt)],
)

export const apiUsage = pgTable(
  'api_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model'),
    operation: text('operation').notNull().default('generate'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    costCents: numeric('cost_cents', { precision: 12, scale: 4 }).notNull().default('0'),
    endpoint: text('endpoint'),
    latencyMs: integer('latency_ms').notNull().default(0),
    status: text('status').notNull().default('ok'),
    error: text('error'),
    createdAt: now(),
  },
  (t) => [index('api_usage_ws_time_idx').on(t.workspaceId, t.createdAt)],
)

export const systemLogs = pgTable(
  'system_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('info'), // debug|info|warn|error|fatal
    source: text('source').notNull().default('app'),
    message: text('message').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms'),
    createdAt: now(),
  },
  (t) => [
    index('system_logs_level_time_idx').on(t.level, t.createdAt),
    index('system_logs_ws_time_idx').on(t.workspaceId, t.createdAt),
  ],
)

/* -------------------------------------------------------- jobs & scheduler */

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queue: text('queue').notNull().default('default'),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'), // queued|running|succeeded|failed|dead|cancelled
    priority: integer('priority').notNull().default(5),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    timeoutMs: integer('timeout_ms').notNull().default(120000),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    stack: text('stack'),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key'),
    result: jsonb('result'),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    index('jobs_poll_idx').on(t.status, t.runAt, t.priority),
    index('jobs_queue_idx').on(t.queue, t.status),
    index('jobs_ws_idx').on(t.workspaceId, t.createdAt),
    // Dedupe only applies to jobs that are still live. A (dedupe_key, status)
    // unique index would also forbid a second job from being *marked* succeeded,
    // failed or dead — which dead-lettered completed work in production. The
    // writer (`enqueue`) checks exactly these two statuses before inserting, and
    // migration 0001_fix_jobs_dedupe swaps the old index for this one.
    uniqueIndex('jobs_dedupe_active_uq')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
    index('jobs_dedupe_idx').on(t.dedupeKey),
  ],
)

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    jobName: text('job_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    system: boolean('system').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    runCount: integer('run_count').notNull().default(0),
    createdAt: now(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('schedules_key_ws_uq').on(t.key, t.workspaceId),
    index('schedules_due_idx').on(t.enabled, t.nextRunAt),
  ],
)

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workerId: text('worker_id').notNull(),
    role: text('role').notNull().default('worker'), // worker | scheduler | web
    hostname: text('hostname').notNull().default('unknown'),
    version: text('version').notNull().default('1.0.0'),
    status: text('status').notNull().default('online'), // online | degraded | offline
    processedCount: integer('processed_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('worker_heartbeats_worker_uq').on(t.workerId, t.role),
    index('worker_heartbeats_time_idx').on(t.lastHeartbeatAt),
  ],
)

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('daily'), // daily | weekly
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    summary: text('summary').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    recommendations: jsonb('recommendations').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('ready'),
    demo: boolean('demo').notNull().default(false),
    createdAt: now(),
  },
  (t) => [index('reports_ws_type_idx').on(t.workspaceId, t.type, t.periodEnd)],
)

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    html: text('html'),
    provider: text('provider').notNull().default('console'),
    status: text('status').notNull().default('queued'), // queued|sent|failed
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [index('email_outbox_status_idx').on(t.status, t.createdAt)],
)

export const storageObjects = pgTable(
  'storage_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('local'),
    bucket: text('bucket').notNull().default('aiba-assets'),
    key: text('key').notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    checksumSha256: text('checksum_sha256'),
    url: text('url'),
    isPublic: boolean('is_public').notNull().default(false),
    createdByAgent: text('created_by_agent'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('storage_objects_key_uq').on(t.provider, t.bucket, t.key),
    index('storage_objects_ws_idx').on(t.workspaceId),
  ],
)

export const opportunityCandidates = pgTable(
  'opportunity_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    reason: text('reason').notNull().default(''),
    actor: text('actor').notNull().default('user'),
    scoreAtDecision: numeric('score_at_decision', { precision: 5, scale: 2 }),
    createdAt: now(),
  },
  (t) => [index('opp_decisions_opp_idx').on(t.opportunityId, t.createdAt)],
)
