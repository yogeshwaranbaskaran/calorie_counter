import { getFoods, getFood, putFood, deleteFood, normalize } from '../src/store.js'
import { findSimilar } from '../src/tools.js'
import { send, requireUser, readBody } from '../src/http.js'

// The personal food table over HTTP, for agents that live outside this app
// (the local Suno worker). Inside the app the Gemini agent reaches the table
// through its tools; this gives an external model the same two moves, with
// the same shapes and the same near-duplicate refusal:
//   GET  /api/foods?names=dosa,sambar   -> { hits, misses }
//   POST /api/foods {name, unit, ...}   -> { saved } | { error: similar_food_already_exists }
//   DELETE /api/foods?name=dal          -> { deleted } - forget a food (its logged rows stay)
const NUMS = ['grams_per_unit', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g']

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return

  try {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      const names = (q.get('names') || '').split(',').map((s) => s.trim()).filter(Boolean)
      const all = await getFoods(who.userId)
      if (!names.length) return send(res, 200, { foods: Object.values(all) })
      const hits = {}, misses = []
      for (const raw of names) {
        const exact = all[normalize(raw)]
        if (exact) { hits[normalize(raw)] = exact; continue }
        const near = await findSimilar(who.userId, raw, all)
        if (near) hits[near.food.name] = { ...near.food, matched_your_text: raw }
        else misses.push(raw)
      }
      return send(res, 200, { hits, misses })
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!body.name || !body.unit) return send(res, 400, { error: 'name and unit required' })
      const bad = NUMS.filter((k) => !Number.isFinite(Number(body[k])))
      if (bad.length) return send(res, 400, { error: `missing or non-numeric: ${bad.join(', ')}` })

      const all = await getFoods(who.userId)
      const near = all[normalize(body.name)] ? null : await findSimilar(who.userId, body.name, all)
      if (near) {
        return send(res, 409, {
          error: 'similar_food_already_exists', existing: near.food.name,
          detail: `"${body.name}" is the same as "${near.food.name}" which you already have. ` +
            `Use "${near.food.name}" in log_meal, or give a genuinely different food a clearly different name.`,
        })
      }
      const food = { name: body.name.trim(), unit: String(body.unit) }
      for (const k of NUMS) food[k] = Number(body[k])
      await putFood(who.userId, food)
      return send(res, 200, { saved: await getFood(who.userId, body.name) })
    }

    if (req.method === 'DELETE') {
      const name = new URL(req.url, 'http://x').searchParams.get('name')
      if (!name) return send(res, 400, { error: 'name required' })
      return send(res, 200, { deleted: await deleteFood(who.userId, name) })
    }

    return send(res, 405, { error: 'GET, POST or DELETE only' })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
