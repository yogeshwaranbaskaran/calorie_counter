// A deterministic parser for the common case: foods you have eaten before,
// with an explicit quantity. "200g rice and 150g chicken cooked" needs no
// model - the table already holds every number, and the agent would only be
// re-deriving what we can read directly.
//
// It is deliberately timid. If any part of the sentence does not resolve to a
// known food with a clear quantity, it gives up entirely and the agent runs.
// A wrong fast path would be far worse than a slow one.
import { getFoods, normalize } from './store.js'
import { similarity } from './tools.js'

const WEIGHT_UNITS = new Set(['g', 'gram', 'grams', 'ml', 'millilitre', 'milliliter'])
// Words that mean "one of", and filler that carries no quantity meaning.
const ARTICLES = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }
const NOISE = /\b(of|some|a bowl of|a cup of|a glass of|a plate of)\b/g

const isWeightFood = (f) => ['g', 'ml'].includes(String(f.unit).toLowerCase())

// Edit distance is word-ORDER sensitive: "boiled eggs" vs "egg boiled" scores
// 0.18, so the fast path missed the way people actually talk. Canonicalising
// to a sorted set of singular words makes order and plurals irrelevant, while
// still demanding the SAME words - "chicken" never matches "chicken curry".
const FILLER = new Set(['of', 'with', 'a', 'an', 'the'])
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const canon = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w && !FILLER.has(w)).map(singular).sort().join(' ')

// Split on commas, "and", "+", and newlines - the way people actually list food.
// NOT on "with": half the table is "bread with butter", "chapathi with oil",
// "milk with sugar". Splitting there would tear food names in half.
const pieces = (text) => text.toLowerCase().split(/[,\n+]|\band\b/).map((p) => p.trim()).filter(Boolean)

function resolve(piece, foods, names) {
  let s = piece.replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null

  // "200g rice" | "200 g rice" | "2 dosa" | "a banana"
  let qty = null, unit = null, m
  // A leading number, then OPTIONALLY a weight unit, then the food. The unit
  // is only consumed when it really is one - otherwise "2 egg boiled" would
  // read "egg" as the unit and lose the food.
  m = s.match(/^(\d+(?:\.\d+)?)\s*(g|ml|gram|grams|millilitre|milliliter)\b\s*(.+)$/)
  if (m) {
    qty = Number(m[1]); unit = 'weight'; s = m[3]
  } else if ((m = s.match(/^(\d+(?:\.\d+)?)\s+(.+)$/))) {
    qty = Number(m[1]); s = m[2]
  } else if ((m = s.match(/^([a-z]+)\s+(.+)$/)) && ARTICLES[m[1]] !== undefined) {
    qty = ARTICLES[m[1]]; s = m[2]
  } else return null

  if (!Number.isFinite(qty) || qty <= 0) return null

  const key = normalize(s)
  let food = foods[key]
  if (!food) {
    // Same words, any order: "boiled eggs" finds "egg boiled".
    const c = canon(key)
    const byWords = names.filter((n) => canon(n) === c)
    if (byWords.length === 1) food = foods[byWords[0]]
  }
  if (!food) {
    // Then a near-exact spelling match; anything looser is the agent's job.
    const best = names.map((n) => ({ n, score: similarity(key, n) })).sort((a, b) => b.score - a.score)[0]
    if (!best || best.score < 0.9) return null
    food = foods[best.n]
  }

  // The quantity has to make sense for how the food is stored.
  if (isWeightFood(food)) { if (unit !== 'weight') return null }
  else if (unit === 'weight') return null

  return { name: food.name, qty }
}

// Returns {name, qty}[] when the WHOLE sentence resolves, else null.
export async function quickParse(userId, text) {
  if (!text || /\?|how many|what|calorie|kcal|protein|yesterday|instead|remove|delete/i.test(text)) return null
  const foods = await getFoods(userId)
  const names = Object.keys(foods)
  if (!names.length) return null

  const parts = pieces(text)
  if (!parts.length) return null
  const items = []
  for (const p of parts) {
    const hit = resolve(p, foods, names)
    if (!hit) return null
    items.push(hit)
  }
  return items.length ? items : null
}
