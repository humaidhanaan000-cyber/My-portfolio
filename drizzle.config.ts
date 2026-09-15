import type { Config } from 'drizzle-kit'

// Migrations are generated as plain SQL so they can be applied identically to
// PostgreSQL (production) and to the embedded PGlite engine (local/preview).
export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: false,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aiba:aiba@localhost:5432/aiba',
  },
} satisfies Config
