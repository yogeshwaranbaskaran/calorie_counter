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

// Other modules (auth) need the same pool rather than opening a second one.
export const sql = q
export const usingPostgres = () => remote

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
//
// Every function takes the owning userId. `user_id is not distinct from $1`
// matches NULL when the id is NULL and compares normally otherwise, so
// single-user mode (no accounts configured, rows with user_id NULL) and
// multi-user mode share one code path instead of two.

export async function getFoods(userId = null) {
  if (!remote) return readJson('foods.json', {})
  const rows = await q('select * from foods where user_id is not distinct from $1', [userId])
  return Object.fromEntries(rows.map(num).map((r) => [r.name, r]))
}

export async function getFood(userId, name) {
  const key = normalize(name)
  if (!remote) return (await getFoods())[key] ?? null
  const rows = await q(
    'select * from foods where user_id is not distinct from $1 and name = $2', [userId, key])
  return rows[0] ? num(rows[0]) : null
}

export async function putFood(userId, food) {
  const row = { ...food, name: normalize(food.name) }
  if (!remote) {
    const foods = await getFoods()
    foods[row.name] = { ...row, confirmed_at: new Date().toISOString() }
    return writeJson('foods.json', foods)
  }
  // Update-then-insert rather than ON CONFLICT: a unique index treats NULLs as
  // distinct, so in single-user mode (user_id NULL) ON CONFLICT never fires and
  // every correction inserted a second row. This form works for both modes.
  const vals = [row.unit, row.grams_per_unit, row.kcal, row.protein_g, row.carbs_g, row.fat_g, row.sugar_g]
  const updated = await q(
    `update foods set unit=$3, grams_per_unit=$4, kcal=$5, protein_g=$6, carbs_g=$7, fat_g=$8, sugar_g=$9,
       confirmed_at = now()
     where user_id is not distinct from $1 and name = $2 returning id`,
    [userId, row.name, ...vals]
  )
  if (updated.length) return
  await q(
    `insert into foods (user_id, name, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, sugar_g, confirmed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [userId, row.name, ...vals]
  )
}

export async function deleteFood(userId, name) {
  const key = normalize(name)
  if (!remote) {
    const foods = await getFoods()
    const had = key in foods
    delete foods[key]
    await writeJson('foods.json', foods)
    return had
  }
  const rows = await q(
    'delete from foods where user_id is not distinct from $1 and name = $2 returning id', [userId, key])
  return rows.length > 0
}

export async function getLog(userId, from, to) {
  if (!remote) {
    const all = await readJson('log.json', [])
    return from ? all.filter((r) => r.date >= from && r.date <= to) : all
  }
  const cols = `id, ${DAY}, meal, name, qty, unit, grams, kcal, protein_g, carbs_g, fat_g, sugar_g`
  const rows = from
    ? await q(`select ${cols} from log_entries
               where user_id is not distinct from $1 and date between $2 and $3
               order by date, id`, [userId, from, to])
    : await q(`select ${cols} from log_entries
               where user_id is not distinct from $1 order by date, id`, [userId])
  return rows.map(num)
}

export async function appendLog(userId, entries) {
  if (!remote) {
    const log = await readJson('log.json', [])
    // Postgres gives rows a bigserial id; the JSON backend mints its own so the
    // two behave identically to everything above this file.
    let next = log.reduce((m, r) => Math.max(m, r.id ?? 0), 0)
    log.push(...entries.map((e) => ({ id: ++next, ...e })))
    return writeJson('log.json', log)
  }
  for (const e of entries) {
    await q(
      `insert into log_entries (user_id, date, meal, name, qty, unit, grams, kcal, protein_g, carbs_g, fat_g, sugar_g)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [userId, e.date, e.meal ?? null, e.name, e.qty, e.unit, e.grams, e.kcal, e.protein_g, e.carbs_g, e.fat_g, e.sugar_g]
    )
  }
}

export async function deleteEntry(userId, id) {
  if (!remote) {
    const log = await readJson('log.json', [])
    const kept = log.filter((r) => String(r.id) !== String(id))
    if (kept.length === log.length) return false
    await writeJson('log.json', kept)
    return true
  }
  // The user_id clause is what stops one account deleting another's entry by
  // guessing an id.
  const rows = await q(
    'delete from log_entries where id = $1 and user_id is not distinct from $2 returning id',
    [id, userId])
  return rows.length > 0
}

/* ----------------------------------------------------------------- weight */

export async function getWeights(userId, from, to) {
  if (!remote) {
    const all = await readJson('weights.json', [])
    return (from ? all.filter((w) => w.date >= from && w.date <= to) : all)
      .sort((a, b) => a.date.localeCompare(b.date))
  }
  const cols = `${DAY}, kg`
  const rows = from
    ? await q(`select ${cols} from weights where user_id is not distinct from $1 and date between $2 and $3 order by date`, [userId, from, to])
    : await q(`select ${cols} from weights where user_id is not distinct from $1 order by date`, [userId])
  return rows.map(num)
}

// One reading per day; a second weigh-in the same day replaces the first.
export async function putWeight(userId, date, kg) {
  if (!remote) {
    const all = (await readJson('weights.json', [])).filter((w) => w.date !== date)
    all.push({ date, kg })
    return writeJson('weights.json', all)
  }
  // Same NULL-safe update-then-insert as putFood.
  const upd = await q(
    'update weights set kg = $3 where user_id is not distinct from $1 and date = $2 returning id',
    [userId, date, kg])
  if (!upd.length) await q('insert into weights (user_id, date, kg) values ($1,$2,$3)', [userId, date, kg])
}

export async function deleteWeight(userId, date) {
  if (!remote) {
    const all = await readJson('weights.json', [])
    const kept = all.filter((w) => w.date !== date)
    await writeJson('weights.json', kept)
    return kept.length !== all.length
  }
  const rows = await q('delete from weights where user_id is not distinct from $1 and date = $2 returning id', [userId, date])
  return rows.length > 0
}

/* ---------------------------------------------------------------- targets */

const TARGET_KEYS = ['target_kcal', 'target_protein_g', 'target_carbs_g', 'target_fat_g', 'target_sugar_g', 'goal_kg', 'height_cm']

export async function getTargets(userId) {
  if (!remote || userId === null) return readJson('targets.json', {})
  const rows = await q(`select ${TARGET_KEYS.join(', ')} from users where id = $1`, [userId])
  return rows[0] ? num(rows[0]) : {}
}

export async function setTargets(userId, t) {
  const clean = Object.fromEntries(TARGET_KEYS.map((k) => {
    const v = Number(t[k])
    return [k, Number.isFinite(v) && v > 0 ? v : null]
  }))
  if (!remote || userId === null) {
    return writeJson('targets.json', { ...(await readJson('targets.json', {})), ...clean })
  }
  const sets = TARGET_KEYS.map((k, i) => `${k} = $${i + 2}`).join(', ')
  await q(`update users set ${sets} where id = $1`, [userId, ...TARGET_KEYS.map((k) => clean[k])])
}

export const backend = () => (remote ? 'postgres' : 'json')
