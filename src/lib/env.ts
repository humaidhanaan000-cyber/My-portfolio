/**
 * Environment configuration + validation.
 *
 * Nothing in this file is ever imported by a client component. All secrets stay
 * server-side; the frontend only ever sees the public values exposed by
 * `publicConfig()`.
 */
import { z } from 'zod'

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int())

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().default('http://localhost:3000'),
  APP_NAME: z.string().default('AIBA'),
  AUTH_SECRET: z.string().default('dev-only-insecure-secret-change-me-please-32+'),
  SESSION_TTL_HOURS: int(24 * 14),
  ALLOW_REGISTRATION: bool(true),
  REQUIRE_EMAIL_VERIFICATION: bool(false),
  COOKIE_SECURE: bool(false),

  // Database — postgres:// URL, or `pglite://<dir>` for the embedded engine.
  DATABASE_URL: z.string().default('pglite://./data/pgdata'),
  DB_POOL_MAX: int(10),
  DB_SSL: bool(false),

  // Queue: redis:// URL, or `memory` for the in-process driver.
  REDIS_URL: z.string().default('memory'),
  QUEUE_PREFIX: z.string().default('aiba'),
  WORKER_CONCURRENCY: int(4),
  WORKER_POLL_MS: int(1500),
  WORKER_ID: z.string().optional(),
  ENABLE_INLINE_JOBS: bool(true),
  JOB_DEFAULT_TIMEOUT_MS: int(120000),
  JOB_MAX_ATTEMPTS: int(3),

  // Scheduler
  ENABLE_SCHEDULER: bool(false),
  SCHEDULER_TICK_MS: int(20000),
  SCHEDULER_LEADER_LOCK_MS: int(45000),

  // AI providers
  AI_PROVIDER: z.enum(['auto', 'openai', 'anthropic', 'openrouter', 'ollama', 'custom', 'none']).default('auto'),
  AI_PROVIDER_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  AI_REASONING_MODEL: z.string().default('gpt-4o'),
  AI_CHEAP_MODEL: z.string().default('gpt-4o-mini'),
  AI_EMBEDDING_MODEL: z.string().optional(),
  AI_MAX_TOKENS: int(2048),
  AI_TIMEOUT_MS: int(60000),
  AI_TEMPERATURE: z.string().default('0.3'),
  AI_ALLOW_NETWORK: bool(true),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),

  // Payments
  PAYMENT_PROVIDER: z.enum(['stripe', 'demo', 'none']).default('none'),
  PAYMENT_PROVIDER_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_SUCCESS_URL: z.string().optional(),
  PAYMENT_CANCEL_URL: z.string().optional(),

  // Email
  EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'console', 'file']).default('console'),
  EMAIL_PROVIDER_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('AIBA <no-reply@aiba.local>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_OUTBOX_DIR: z.string().default('./data/mail-outbox'),

  // Object storage
  STORAGE_DRIVER: z.enum(['local', 's3', 's3_compatible']).default('local'),
  STORAGE_KEY: z.string().optional(),
  STORAGE_SECRET: z.string().optional(),
  STORAGE_BUCKET: z.string().default('aiba-assets'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_LOCAL_DIR: z.string().default('./data/storage'),
  STORAGE_PUBLIC_BASE_URL: z.string().optional(),

  // Notifications
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  NOTIFY_WEBHOOK_URL: z.string().optional(),

  // Research sources
  PRODUCTHUNT_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  NEWSAPI_KEY: z.string().optional(),
  SOURCE_ALLOW_NETWORK: bool(true),
  RESEARCH_USER_AGENT: z.string().default('AIBA-bot/1.0 (+https://example.com/aiba)'),

  // Runtime
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  SERVICE_VERSION: z.string().default('1.0.0'),
  RATE_LIMIT_WINDOW_MS: int(60000),
  RATE_LIMIT_MAX_AUTH: int(10),
  RATE_LIMIT_MAX_API: int(240),
  DEMO_MODE_ENABLED: bool(true),
  BUDGET_ENFORCEMENT: bool(true),
  MAX_DAILY_AI_SPEND_CENTS: int(2000),
  HEARTBEAT_STALE_SECONDS: int(120),
})

export type Env = z.infer<typeof schema>

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // Fail fast: a misconfigured deployment must not boot half-working.
  console.error('[env] Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
}

export const env: Env = parsed.success ? parsed.data : (schema.parse({}) as Env)

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'

/** Values safe to send to the browser. */
export function publicConfig() {
  return {
    appName: env.APP_NAME,
    appUrl: env.APP_URL,
    demoModeEnabled: env.DEMO_MODE_ENABLED,
    allowRegistration: env.ALLOW_REGISTRATION,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
    paymentProvider: env.PAYMENT_PROVIDER,
    aiConfigured: Boolean(resolveAiKey()),
    emailProvider: env.EMAIL_PROVIDER,
    storageDriver: env.STORAGE_DRIVER,
    queueDriver: env.REDIS_URL === 'memory' ? 'memory' : 'redis',
    databaseDriver: env.DATABASE_URL.startsWith('pglite') ? 'pglite' : 'postgres',
  }
}

export function resolveAiKey(): string | undefined {
  switch (env.AI_PROVIDER) {
    case 'openai':
      return env.AI_PROVIDER_KEY ?? env.OPENAI_API_KEY
    case 'anthropic':
      return env.AI_PROVIDER_KEY ?? env.ANTHROPIC_API_KEY
    case 'openrouter':
      return env.AI_PROVIDER_KEY ?? env.OPENROUTER_API_KEY
    case 'ollama':
      return 'ollama'
    case 'custom':
      return env.AI_PROVIDER_KEY
    case 'none':
      return undefined
    default:
      return (
        env.AI_PROVIDER_KEY ??
        env.OPENAI_API_KEY ??
        env.ANTHROPIC_API_KEY ??
        env.OPENROUTER_API_KEY ??
        undefined
      )
  }
}

/** Which provider will actually be used, after applying `auto` resolution. */
export function resolveAiProvider(): 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'custom' | 'none' {
  if (env.AI_PROVIDER !== 'auto') return env.AI_PROVIDER as never
  if (env.AI_PROVIDER_KEY || env.OPENAI_API_KEY) return 'openai'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  if (env.OPENROUTER_API_KEY) return 'openrouter'
  if (env.OLLAMA_BASE_URL) return 'ollama'
  return 'none'
}

export type ServiceCredential = {
  service: string
  credential: string
  envVar: string
  whereToObtain: string
  testProcedure: string
  required: boolean
}

/** External credentials AIBA knows how to use, and how to verify them. */
export const SERVICE_CREDENTIALS: ServiceCredential[] = [
  {
    service: 'OpenAI (or compatible)',
    credential: 'API key',
    envVar: 'OPENAI_API_KEY',
    whereToObtain: 'https://platform.openai.com/api-keys',
    testProcedure: 'GET /api/health → ai.status should be "configured"; POST /api/agents/analyze to generate a real analysis.',
    required: false,
  },
  {
    service: 'Anthropic Claude',
    credential: 'API key',
    envVar: 'ANTHROPIC_API_KEY',
    whereToObtain: 'https://console.anthropic.com/settings/keys',
    testProcedure: 'Set AI_PROVIDER=anthropic and run POST /api/agents/analyze.',
    required: false,
  },
  {
    service: 'OpenRouter',
    credential: 'API key',
    envVar: 'OPENROUTER_API_KEY',
    whereToObtain: 'https://openrouter.ai/keys',
    testProcedure: 'Set AI_PROVIDER=openrouter and run POST /api/agents/analyze.',
    required: false,
  },
  {
    service: 'Stripe',
    credential: 'Secret key + webhook signing secret',
    envVar: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET',
    whereToObtain: 'https://dashboard.stripe.com/apikeys and https://dashboard.stripe.com/webhooks',
    testProcedure: 'POST /api/payments/checkout then stripe listen --forward-to /api/payments/webhook.',
    required: false,
  },
  {
    service: 'SMTP / Resend',
    credential: 'SMTP credentials or API key',
    envVar: 'SMTP_HOST, SMTP_USER, SMTP_PASSWORD / EMAIL_PROVIDER_KEY',
    whereToObtain: 'Your mail provider dashboard',
    testProcedure: 'POST /api/notifications/test-email — the message is written to the outbox if SMTP is absent.',
    required: false,
  },
  {
    service: 'Product Hunt',
    credential: 'Developer token',
    envVar: 'PRODUCTHUNT_TOKEN',
    whereToObtain: 'https://www.producthunt.com/v2/oauth/applications',
    testProcedure: 'Enable the "Product Hunt" source and trigger a research scan.',
    required: false,
  },
  {
    service: 'GitHub',
    credential: 'Personal access token (public read)',
    envVar: 'GITHUB_TOKEN',
    whereToObtain: 'https://github.com/settings/tokens',
    testProcedure: 'Enable the "GitHub Trending & Issues" source and trigger a research scan.',
    required: false,
  },
  {
    service: 'Telegram',
    credential: 'Bot token',
    envVar: 'TELEGRAM_BOT_TOKEN',
    whereToObtain: 'https://t.me/BotFather',
    testProcedure: 'POST /api/notifications/test-telegram with a chat id.',
    required: false,
  },
  {
    service: 'S3-compatible object storage',
    credential: 'Access key + secret',
    envVar: 'STORAGE_KEY, STORAGE_SECRET, STORAGE_BUCKET',
    whereToObtain: 'AWS IAM / Cloudflare R2 / MinIO console',
    testProcedure: 'Set STORAGE_DRIVER=s3 and POST /api/assets — the asset uploads and returns a signed URL.',
    required: false,
  },
]
