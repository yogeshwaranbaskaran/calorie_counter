// Copies the local JSON data into the database in DATABASE_URL.
//   DATABASE_URL="postgres://..." npm run migrate
//
// Safe to re-run: foods upsert by name and log entries carry their existing
// id, so a repeat run conflicts on the id and does nothing.
//
// Do NOT dedupe on (date, name, qty) - eating the same thing twice in one day
// is normal, and that key silently drops the second one.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL first')

const { default: pg } = await import('pg')
const url = process.env.DATABASE_URL
const pool = new pg.Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
})

const foods = JSON.parse(await readFile(join(DATA, 'foods.json'), 'utf8'))
const log = JSON.parse(await readFile(join(DATA, 'log.json'), 'utf8'))

let f = 0
for (const v of Object.values(foods)) {
  await pool.query(
    `insert into foods (name, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, sugar_g, confirmed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (name) do update set
       unit = excluded.unit, grams_per_unit = excluded.grams_per_unit, kcal = excluded.kcal,
       protein_g = excluded.protein_g, carbs_g = excluded.carbs_g, fat_g = excluded.fat_g,
       sugar_g = excluded.sugar_g`,
    [v.name, v.unit, v.grams_per_unit, v.kcal, v.protein_g, v.carbs_g, v.fat_g, v.sugar_g]
  )
  f++
}

let inserted = 0, skipped = 0
for (const e of log) {
  const { rowCount } = await pool.query(
    `insert into log_entries (id, date, name, qty, unit, grams, kcal, protein_g, carbs_g, fat_g, sugar_g)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do nothing`,
    [e.id, e.date, e.name, e.qty, e.unit, e.grams, e.kcal, e.protein_g, e.carbs_g, e.fat_g, e.sugar_g]
  )
  rowCount ? inserted++ : skipped++
}

// Rows were inserted with explicit ids, so the sequence is still at 1 and the
// next entry logged in the app would collide. Move it past the highest id.
await pool.query(`select setval(pg_get_serial_sequence('log_entries','id'),
                                coalesce((select max(id) from log_entries), 1))`)

const { rows: [check] } = await pool.query(
  'select count(*)::int as entries, coalesce(sum(kcal),0)::int as kcal from log_entries'
)
console.log(`foods upserted : ${f}`)
console.log(`entries added  : ${inserted}  (skipped ${skipped} already present)`)
console.log(`database now   : ${check.entries} entries, ${check.kcal} kcal total`)
await pool.end()
