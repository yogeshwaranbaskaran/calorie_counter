// Loads data/usda.json into food_library. Idempotent: rows upsert on
// (source, fdc_id).   npm run library:load
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
const { default: pg } = await import('pg')
const { _splitUrl } = await import('./store.js')
const { clean, plain } = _splitUrl(process.env.DATABASE_URL)
const pool = new pg.Pool({ connectionString: clean, ssl: plain ? false : { rejectUnauthorized: false } })

const rows = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'usda.json'), 'utf8'))

// One multi-row insert per batch: 8k single inserts to another region would
// take minutes.
const BATCH = 500
let done = 0
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH)
  const params = [], tuples = []
  chunk.forEach((r, j) => {
    const b = j * 10
    tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`)
    params.push(r.source, r.fdc_id, r.name, r.category, r.kcal, r.protein_g, r.carbs_g, r.fat_g, r.sugar_g, r.fiber_g ?? null)
  })
  await pool.query(
    `insert into food_library (source, fdc_id, name, category, kcal, protein_g, carbs_g, fat_g, sugar_g, fiber_g)
     values ${tuples.join(',')}
     on conflict (source, fdc_id) do update set name = excluded.name, category = excluded.category,
       kcal = excluded.kcal, protein_g = excluded.protein_g, carbs_g = excluded.carbs_g,
       fat_g = excluded.fat_g, sugar_g = excluded.sugar_g, fiber_g = excluded.fiber_g`,
    params)
  done += chunk.length
  process.stdout.write(`\r  ${done}/${rows.length}`)
}
const { rows: [c] } = await pool.query('select count(*)::int n from food_library')
console.log(`\n  food_library now holds ${c.n} foods`)
await pool.end()
