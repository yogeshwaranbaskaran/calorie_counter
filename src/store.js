// Two backends, one interface. Local dev uses JSON files; production uses
// Postgres (Neon). Nothing above this file knows which is running.
//
// A food row is FLAT and stored PER SINGLE UNIT:
//   { name, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, sugar_g }
// For unit "g" / "ml" the values are per 100 - see basisOf() in tools.js.
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_URL = process.env.DATABASE_URL
const remote = Boolean(DB_URL)

// "2 Dosa " and "dosa" must land on the same row.
export const normalize = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ')

// toISOString() is UTC, which in JST dates anything before 09:00 to yesterday.
// A food log is entirely calendar-day-bound, so that bug would be constant.
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* ---------------------------------------------------------------- postgres */

let poolPromise = null
// Imported lazily so local development needs no database driver at all and the
// JSON path stays dependency-free.
// SSL is decided by the `ssl` option below, so sslmode is stripped from the
// URL. Leaving both in place makes pg warn that it currently treats
// sslmode=require as verify-full and will change that in v9 - ambiguity we do
// not need, since the intent is expressed once, here.
function splitUrl(url) {
  try {
    const u = new URL(url)
    const local = ['localhost', '127.0.0.1'].includes(u.hostname)
    const disabled = u.searchParams.get('sslmode') === 'disable'
    for (const k of ['sslmode', 'ssl', 'channel_binding']) u.searchParams.delete(k)
    return { clean: u.toString(), plain: local || disabled }
  } catch {
    return { clean: url, plain: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) }
  }
}

async function pool() {
  poolPromise ??= (async () => {
    const { default: pg } = await import('pg')
    const { clean, plain } = splitUrl(DB_URL)
    return new pg.Pool({
      connectionString: clean,
      // Neon terminates TLS at its proxy with a chain Node does not ship, so
      // verification is off there; a local database over plain TCP has no TLS
      // at all, so do not demand it.
      ssl: plain ? false : { rejectUnauthorized: false },
      max: 3, // a free Render instance serving one person needs very little
      idleTimeoutMillis: 30_000,
    })
  })()
  return poolPromise
}

export const _splitUrl = splitUrl // exported for tests only

const q = async (text, params = []) => (await (await pool()).query(text, params)).rows

// Postgres returns DATE as a JS Date in the server's timezone, which can shift
// the calendar day. Selecting it as text keeps YYYY-MM-DD exactly as stored.
const DAY = `to_char(date, 'YYYY-MM-DD') as date`

// numeric comes back as a string to preserve precision; the app wants numbers.
const num = (r) => {
  const out = {}
  for (const [k, v] of Object.entries(r)) {
    out[k] = v !== null && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && k !== 'date'
      ? Number(v) : v
  }
  return out
}

/* -------------------------------------------------------------------- json */

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA, file), 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, v) => writeFile(join(DATA, file), JSON.stringify(v, null, 2))

/* ------------------------------------------------------------------ public */

export async function getFoods() {
  if (!remote) return readJson('foods.json', {})
  const rows = await q('select * from foods')
  return Object.fromEntries(rows.map(num).map((r) => [r.name, r]))
}

export async function getFood(name) {
  const key = normalize(name)
  if (!remote) return (await getFoods())[key] ?? null
  const rows = await q('select * from foods where name = $1', [key])
  return rows[0] ? num(rows[0]) : null
}

export async function putFood(food) {
  const row = { ...food, name: normalize(food.name), confirmed_at: new Date().toISOString() }
  if (!remote) {
    const foods = await getFoods()
    foods[row.name] = row
    return writeJson('foods.json', foods)
  }
  // Upsert, so re-confirming a food amends it in place rather than inserting a
  // second conflicting row.
  await q(
    `insert into foods (name, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, sugar_g, confirmed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (name) do update set
       unit = excluded.unit, grams_per_unit = excluded.grams_per_unit,
       kcal = excluded.kcal, protein_g = excluded.protein_g, carbs_g = excluded.carbs_g,
       fat_g = excluded.fat_g, sugar_g = excluded.sugar_g, confirmed_at = now()`,
    [row.name, row.unit, row.grams_per_unit, row.kcal, row.protein_g, row.carbs_g, row.fat_g, row.sugar_g]
  )
}

export async function getLog(from, to) {
  if (!remote) {
    const all = await readJson('log.json', [])
    return from ? all.filter((r) => r.date >= from && r.date <= to) : all
  }
  const rows = from
    ? await q(`select id, ${DAY}, name, qty, unit, grams, kcal, protein_g, carbs_g, fat_g, sugar_g
               from log_entries where date between $1 and $2 order by date, id`, [from, to])
    : await q(`select id, ${DAY}, name, qty, unit, grams, kcal, protein_g, carbs_g, fat_g, sugar_g
               from log_entries order by date, id`)
  return rows.map(num)
}

export async function appendLog(entries) {
  if (!remote) {
    const log = await readJson('log.json', [])
    // Postgres gives rows a bigserial id; the JSON backend has to mint its own
    // so the two behave identically to everything above this file.
    let next = log.reduce((m, r) => Math.max(m, r.id ?? 0), 0)
    log.push(...entries.map((e) => ({ id: ++next, ...e })))
    return writeJson('log.json', log)
  }
  for (const e of entries) {
    await q(
      `insert into log_entries (date, name, qty, unit, grams, kcal, protein_g, carbs_g, fat_g, sugar_g)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.date, e.name, e.qty, e.unit, e.grams, e.kcal, e.protein_g, e.carbs_g, e.fat_g, e.sugar_g]
    )
  }
}

export async function deleteEntry(id) {
  if (!remote) {
    const log = await readJson('log.json', [])
    const kept = log.filter((r) => String(r.id) !== String(id))
    if (kept.length === log.length) return false
    await writeJson('log.json', kept)
    return true
  }
  const rows = await q('delete from log_entries where id = $1 returning id', [id])
  return rows.length > 0
}

export const backend = () => (remote ? 'postgres' : 'json')
