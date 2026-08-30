// Two backends, one interface. Local dev uses JSON files; production uses
// Supabase over PostgREST. Nothing above this file knows which is running.
//
// A food row is FLAT and stored PER SINGLE UNIT:
//   { name, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, sugar_g }
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY // server-side only, never shipped
const remote = Boolean(URL_ && KEY)

// "2 Dosa " and "dosa" must land on the same row.
export const normalize = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ')

// toISOString() is UTC, which in JST dates anything before 09:00 to yesterday.
// A food log is entirely calendar-day-bound, so that bug would be constant.
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* ---------------------------------------------------------------- supabase */

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`db ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? null : res.json()
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
  const rows = await rest('foods?select=*')
  return Object.fromEntries(rows.map((r) => [r.name, r]))
}

export async function getFood(name) {
  const key = normalize(name)
  if (!remote) return (await getFoods())[key] ?? null
  const rows = await rest(`foods?select=*&name=eq.${encodeURIComponent(key)}`)
  return rows[0] ?? null
}

export async function putFood(food) {
  const row = { ...food, name: normalize(food.name), confirmed_at: new Date().toISOString() }
  if (!remote) {
    const foods = await getFoods()
    foods[row.name] = row
    return writeJson('foods.json', foods)
  }
  // merge-duplicates = upsert, so re-confirming a food amends it in place
  // rather than inserting a second conflicting row.
  await rest('foods', { method: 'POST', body: [row], prefer: 'resolution=merge-duplicates' })
}

export async function getLog(from, to) {
  if (!remote) {
    const all = await readJson('log.json', [])
    return from ? all.filter((r) => r.date >= from && r.date <= to) : all
  }
  const range = from ? `&date=gte.${from}&date=lte.${to}` : ''
  return rest(`log_entries?select=*${range}&order=date.asc`)
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
  await rest('log_entries', { method: 'POST', body: entries })
}

export async function deleteEntry(id) {
  if (!remote) {
    const log = await readJson('log.json', [])
    const kept = log.filter((r) => String(r.id) !== String(id))
    if (kept.length === log.length) return false
    await writeJson('log.json', kept)
    return true
  }
  await rest(`log_entries?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' })
  return true
}

export const backend = () => (remote ? 'supabase' : 'json')
