import { getFoods, getFood, putFood } from '../src/store.js'
import { findSimilar } from '../src/tools.js'
import { send, requireUser, readBody } from '../src/http.js'

// The personal food table over HTTP, for agents that live outside this app
// (the local Suno worker). Inside the app the Gemini agent reaches the table
// through its tools; this gives an external model the same two moves:
//   GET  /api/foods?names=dosa,sambar   -> what the table already knows
//   POST /api/foods {name, unit, ...}   -> teach it one food, per single unit
const FIELDS = ['unit', 'grams_per_unit', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g']

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return

  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams
    const names = (q.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean)
    try {
      const foods = await getFoods(who.userId)
      if (!names.length) return send(res, 200, { foods: Object.values(foods) })
      const found = {}, missing = [], similar = {}
      for (const name of names) {
        const hit = await getFood(who.userId, name)
        if (hit) { found[name] = hit; continue }
        missing.push(name)
        const near = await findSimilar(who.userId, name, foods)
        if (near) similar[name] = near.food
      }
      return send(res, 200, { found, missing, similar })
    } catch (err) {
      return send(res, 500, { error: String(err.message ?? err) })
    }
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    if (!body.name) return send(res, 400, { error: 'name required' })
    const bad = FIELDS.filter((k) => k !== 'unit' && !Number.isFinite(Number(body[k])))
    if (bad.length || !body.unit) return send(res, 400, { error: `missing or non-numeric: ${[...bad, ...(body.unit ? [] : ['unit'])].join(', ')}` })
    const food = { name: body.name, unit: String(body.unit) }
    for (const k of FIELDS) if (k !== 'unit') food[k] = Number(body[k])
    try {
      await putFood(who.userId, food)
      return send(res, 200, { saved: await getFood(who.userId, body.name) })
    } catch (err) {
      return send(res, 500, { error: String(err.message ?? err) })
    }
  }

  return send(res, 405, { error: 'GET or POST only' })
}
