-- Fix the job dedupe index.
--
-- `jobs_dedupe_uq` was UNIQUE (dedupe_key, status). That is wrong in two ways:
--
--   1. it only allowed ONE row per (key, status) for the whole lifetime of the
--      table, so a second job with the same key could never even be *marked*
--      'succeeded' — the UPDATE failed with a unique violation, the job retried
--      three times and was dead-lettered, while its work had actually completed;
--   2. 'failed' and 'dead' rows were locked out for the same reason.
--
-- Deduplication only needs to cover rows that are still live, and those two
-- statuses ('queued', 'running') happen to be exactly the ones the writer checks
-- before inserting. A partial unique index expresses that, keeps terminal rows
-- free to repeat, and makes duplicate-queue rows impossible.
DROP INDEX IF EXISTS "jobs_dedupe_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_active_uq" ON "jobs" USING btree ("dedupe_key") WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
-- +rollback
DROP INDEX IF EXISTS "jobs_dedupe_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "jobs_dedupe_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key","status");
-- +end-rollback
