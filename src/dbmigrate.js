// Applies every db/*.sql in name order against DATABASE_URL. Each file is
// written with IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so re-running is a
// no-op - that is the whole contract, so keep new migrations that way.
//   npm run db:migrate
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
const { default: pg } = await import('pg')
const { _splitUrl } = await import('./store.js')
const { clean, plain } = _splitUrl(process.env.DATABASE_URL)
const pool = new pg.Pool({ connectionString: clean, ssl: plain ? false : { rejectUnauthorized: false } })

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db')
const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()
for (const f of files) {
  await pool.query(await readFile(join(DIR, f), 'utf8'))
  console.log(`  applied ${f}`)
}
const { rows } = await pool.query(
  `select table_name, count(*)::int cols from information_schema.columns
   where table_schema='public' group by table_name order by 1`)
console.log('  tables:', rows.map((r) => `${r.table_name}(${r.cols})`).join(', '))
await pool.end()
