#!/usr/bin/env tsx
/**
 * Generate docs/SCHEMA.md from src/lib/db/schema.ts.
 *
 *   npm run docs:schema
 *
 * The document is derived from the source of truth rather than hand-written, so
 * it cannot drift: every table, column, type, nullability, default and foreign
 * key below comes from the Drizzle definitions that actually build the database.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SCHEMA_PATH = resolve(process.cwd(), 'src/lib/db/schema.ts')
const OUTPUT_PATH = resolve(process.cwd(), 'docs/SCHEMA.md')

type Column = {
  name: string
  type: string
  attributes: string[]
}

type Table = {
  variable: string
  name: string
  columns: Column[]
  indexes: string[]
  comment?: string
  area?: string
}

const COLUMN_TYPE_HINTS: Record<string, string> = {
  uuid: 'uuid',
  text: 'text',
  varchar: 'varchar',
  integer: 'integer',
  bigint: 'bigint',
  smallint: 'smallint',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  date: 'date',
  numeric: 'numeric',
  jsonb: 'jsonb',
  json: 'json',
  real: 'real',
  doublePrecision: 'double precision',
  inet: 'inet',
  bytea: 'bytea',
}

/** Nearest preceding section marker (e.g. `/* ---------- money *\/`) as the area name. */
function precedingSection(lines: string[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0 && index - cursor < 200; cursor -= 1) {
    const line = lines[cursor]!
    const section = /^\/\*\s*-+\s*([a-z0-9 &/,.()-]+?)\s*\*\/$/i.exec(line.trim())
    if (section) return section[1]!.trim().replace(/\s+/g, ' ')
    const docComment = /^\*\s+([A-Z].{4,120})$/.exec(line)
    if (docComment) return undefined
  }
  return undefined
}

/** Nearest preceding block comment, used as the table's purpose. */
function precedingComment(lines: string[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0 && index - cursor < 14; cursor -= 1) {
    const line = lines[cursor]!
    if (/^\s*\*\//.test(line)) {
      const collected: string[] = []
      for (let inner = cursor - 1; inner >= 0 && !/^\s*\/\*\*/.test(lines[inner]!); inner -= 1) {
        const text = lines[inner]!.replace(/^\s*\*\s?/, '').trim()
        if (text) collected.unshift(text)
      }
      const joined = collected.join(' ').replace(/\s+/g, ' ').trim()
      if (joined) return joined.length > 220 ? `${joined.slice(0, 217)}…` : joined
      return undefined
    }
    if (/^\s*(export const|\/\/)/.test(line)) continue
    if (line.trim() === '') continue
    return undefined
  }
  return undefined
}

function parse(): Table[] {
  const source = readFileSync(SCHEMA_PATH, 'utf8')
  const lines = source.split('\n')
  const tables: Table[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const declaration = /^export const (\w+) = pgTable\($/.exec(lines[index]!)
    if (!declaration) continue

    const variable = declaration[1]!
    const nameLine = /^\s{2}'([^']+)',$/.exec(lines[index + 1] ?? '')
    if (!nameLine) continue
    const name = nameLine[1]!

    const columns: Column[] = []
    const indexes: string[] = []
    const commentLines: string[] = []
    const purpose = precedingComment(lines, index)
    const area = precedingSection(lines, index)
    let cursor = index + 2
    let sawClosing = false

    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!
      if (/^\)/.test(line)) {
        sawClosing = true
        break
      }
      if (/^\s{2}\(\w+\) =>/.test(line)) break

      const column = /^\s{4}(\w+):\s*([\w.]+)\(([^)]*)\)(.*)$/.exec(line)
      if (column) {
        const [, field, factory, args, rest] = column
        const dbName = /'([^']+)'/.exec(args ?? '')?.[1] ?? field!
        const type = COLUMN_TYPE_HINTS[factory!.split('.').pop()!] ?? factory!
        const attributes: string[] = []
        const tail = `${rest ?? ''}${lines[cursor + 1] ?? ''}`

        if (/\.primaryKey\(/.test(tail)) attributes.push('primary key')
        if (/\.notNull\(/.test(tail)) attributes.push('not null')
        if (/\.unique\(/.test(tail)) attributes.push('unique')
        if (/\.array\(/.test(tail)) attributes.push('array')

        const defaultMatch = /\.default(?:Now)?\(([^)]*)\)/.exec(tail)
        if (/defaultRandom\(\)/.test(tail)) attributes.push('default random uuid')
        else if (/defaultNow\(\)/.test(tail)) attributes.push('default now()')
        else if (defaultMatch && defaultMatch[1] !== '') attributes.push(`default ${defaultMatch[1]!.trim()}`)

        const reference = /references\(\(\) => (\w+)\.(\w+)/.exec(tail)
        if (reference) {
          const target = tables.find((table) => table.variable === reference[1])
          attributes.push(`references ${target ? target.name : reference[1]}.${reference[2]}`)
        }
        const onDelete = /onDelete: '([^']+)'/.exec(tail)
        if (onDelete) attributes.push(`on delete ${onDelete[1]}`)

        columns.push({ name: dbName, type, attributes })
        continue
      }

      const indexMatch = /index\('([^']+)'\)/.exec(line)
      if (indexMatch) indexes.push(`index \`${indexMatch[1]}\``)
      const uniqueMatch = /uniqueIndex\('([^']+)'\)/.exec(line)
      if (uniqueMatch && !indexMatch) indexes.push(`unique index \`${uniqueMatch[1]}\``)

      const inlineComment = /^\s{4}\/\/\s*(.+)$/.exec(line)
      if (inlineComment && columns.length === 0) commentLines.push(inlineComment[1]!)
    }

    if (!sawClosing && columns.length === 0) continue
    tables.push({ variable, name, columns, indexes, comment: purpose ?? commentLines[0], area })
    index = cursor
  }

  return tables
}

function main() {
  const tables = parse()
  const totalColumns = tables.reduce((sum, table) => sum + table.columns.length, 0)

  const lines: string[] = []
  lines.push('# Database schema')
  lines.push('')
  lines.push('> Generated from `src/lib/db/schema.ts` — do not edit by hand. Regenerate with `npm run docs:schema` after changing the schema (and add a migration).')
  lines.push('')
  lines.push(`**${tables.length} tables · ${totalColumns} columns.** All money is stored as integer cents (\`amount_cents\`, \`net_cents\`, …); no floating point arithmetic is used for financial values.`)
  lines.push('')
  lines.push('## Conventions')
  lines.push('')
  lines.push('| Convention | Detail |')
  lines.push('| --- | --- |')
  lines.push('| Primary keys | `uuid` generated by the database (`default random uuid`) |')
  lines.push('| Money | integer cents, never `float`/`numeric(2)`; currency stored alongside the amount where relevant |')
  lines.push('| Timestamps | `timestamptz` (`timestamp with time zone`), always UTC |')
  lines.push('| Tenant scope | every business table carries `workspace_id` with a foreign key to `workspaces` |')
  lines.push('| Soft delete | long-lived entities (users, workspaces, projects, opportunities) use `deleted_at` instead of hard deletes |')
  lines.push('| Demo separation | tables that can hold sample data carry a `demo` boolean; demo rows are excluded from real totals by default |')
  lines.push('| Audit | `audit_logs` is append-only and records the actor, action, entity, before/after values and IP |')
  lines.push('')
  lines.push('## Tables')
  lines.push('')
  const hasComments = tables.some((table) => table.comment)
  lines.push(hasComments ? '| Table | Area | Columns | Purpose |' : '| Table | Area | Columns |')
  lines.push(hasComments ? '| --- | --- | --- | --- |' : '| --- | --- | --- |')
  for (const table of tables) {
    const cells = `[\`${table.name}\`](#${table.name.replace(/_/g, '-')}) | ${table.area ?? '—'} | ${table.columns.length}`
    lines.push(hasComments ? `| ${cells} | ${table.comment ?? ''} |` : `| ${cells} |`)
  }
  lines.push('')

  const areas = [...new Set(tables.map((table) => table.area ?? 'Other'))]
  lines.push('## Areas')
  lines.push('')
  for (const area of areas) {
    const inArea = tables.filter((table) => (table.area ?? 'Other') === area)
    lines.push(`- **${area}** — ${inArea.length} table(s): ${inArea.map((table) => `\`${table.name}\``).join(', ')}`)
  }
  lines.push('')

  for (const table of tables) {
    lines.push(`### ${table.name}`)
    lines.push('')
    lines.push(`Drizzle export: \`${table.variable}\``)
    lines.push('')
    lines.push('| Column | Type | Attributes |')
    lines.push('| --- | --- | --- |')
    for (const column of table.columns) {
      lines.push(`| \`${column.name}\` | ${column.type} | ${column.attributes.join(', ') || '—'} |`)
    }
    if (table.indexes.length > 0) {
      lines.push('')
      lines.push(`Indexes: ${table.indexes.join(', ')}`)
    }
    lines.push('')
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf8')
  console.log(`[schema-doc] wrote ${OUTPUT_PATH} — ${tables.length} tables, ${totalColumns} columns`)
  if (tables.length === 0 || totalColumns === 0) {
    console.error('[schema-doc] parsed nothing — the schema file format probably changed.')
    process.exitCode = 1
  }
}

main()
