// What the agent can DO. Note what is NOT here: there is no "estimate calories"
// tool. Estimating is thinking, and the model already thinks. Tools exist only
// for what it CANNOT do - read the table, write the table.
import { getFood, getFoods, putFood, appendLog, getLog, normalize, localDate } from './store.js'

const S = 'STRING'
const N = 'NUMBER'

export const declarations = [
  {
    name: 'lookup_food',
    description:
      "Check the user's personal food table for foods you have already learned. " +
      'ALWAYS call this first for every food mentioned, before estimating anything. ' +
      'Pass every food name in one call.',
    parameters: {
      type: 'OBJECT',
      properties: { names: { type: 'ARRAY', items: { type: S } } },
      required: ['names'],
    },
  },
  {
    name: 'save_food',
    description:
      'Teach the table a food it does not know yet, stored PER SINGLE UNIT. ' +
      'Only call this once the user has confirmed your estimate is about right.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: S, description: 'Plain name, e.g. "dosa", not "2 dosa"' },
        unit: { type: S, description: 'piece, bowl, cup, glass, slice, serving, g' },
        grams_per_unit: { type: N },
        kcal: { type: N, description: 'Calories in ONE unit' },
        protein_g: { type: N },
        carbs_g: { type: N },
        fat_g: { type: N },
        sugar_g: { type: N },
      },
      required: ['name', 'unit', 'grams_per_unit', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g'],
    },
  },
  {
    name: 'log_meal',
    description:
      'Propose writing a meal to the log. Every food must already exist in the ' +
      'table. This does NOT write - the user must confirm first. Totals are ' +
      'computed by the app, so never add anything up yourself.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: S, description: 'YYYY-MM-DD, omit for today' },
        meal: { type: S, description: 'breakfast, lunch, dinner or snack. Infer from the words ("had for lunch") or the time of day; omit only if you truly cannot tell.' },
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { name: { type: S }, qty: { type: N } },
            required: ['name', 'qty'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'query_history',
    description:
      'Read back what the user already logged. Use it for questions about past ' +
      'days, and when they refer to a previous meal ("same as yesterday").',
    parameters: {
      type: 'OBJECT',
      properties: { from: { type: S }, to: { type: S } },
      required: ['from', 'to'],
    },
  },
]

const round = (n) => Math.round(n * 10) / 10

// ---------------------------------------------------------------- matching
// The model is told the whole food table and STILL created "bread with
// bbutter" next to "bread with butter". Prompting is not enough, so near
// duplicates are refused in code - the same way log_meal refuses an unknown
// food. A typo must resolve to the food you already have.
const squash = (s) => normalize(s).replace(/[^a-z0-9 ]/g, '')

function editDistance(a, b) {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1))
      last = tmp
    }
  }
  return prev[b.length]
}

// Multi-digit numbers in a food name are usually its calorie count, so they
// carry meaning that edit distance throws away: "200cal snacks" and
// "100 cal snacks" differ by one character and are NOT the same food.
// Single digits are ignored because they turn up inside typos ("icecre3am").
const bigNumbers = (s) => (String(s).match(/\d{2,}/g) ?? []).sort().join(',')

export const similarity = (a, b) => {
  const x = squash(a), y = squash(b)
  if (!x || !y) return 0
  if (bigNumbers(x) !== bigNumbers(y)) return 0
  return 1 - editDistance(x, y) / Math.max(x.length, y.length)
}

// 0.85 keeps genuine typos together and genuine differences apart:
//   bread with butter / bread with bbutter  0.94  -> same
//   eggs with oil     / egg with oil        0.96  -> same
//   chicken           / chicken curry       0.54  -> different
//   icecream          / 120cals icecream    0.50  -> different (300 vs 120 kcal)
const SAME = 0.85

export async function findSimilar(userId, name, foods) {
  const all = foods ?? (await getFoods(userId))
  return Object.values(all)
    .map((f) => ({ food: f, score: similarity(name, f.name) }))
    .filter((x) => x.score >= SAME)
    .sort((a, b) => b.score - a.score)[0] ?? null
}

// Weights and volumes are stated PER 100 - the way every nutrition label does
// it - so a stored value of 180 kcal for unit "g" means 180 per 100g. Anything
// countable (piece, bowl, cup) is per one. Without this, "400g of chicken"
// multiplies a per-100g figure by 400 and logs 72,000 kcal.
const BASIS = { g: 100, ml: 100 }
export const basisOf = (unit) => BASIS[String(unit).toLowerCase()] ?? 1

// The model passes quantities. The MATH happens here, in plain JavaScript,
// so totals are deterministic and cannot be hallucinated.
const scale = (food, qty) => {
  const basis = basisOf(food.unit)
  const f = qty / basis
  return {
    name: food.name,
    qty,
    unit: food.unit,
    // per-unit values and the basis ride along so the review card can edit
    // them and recompute live, without a round trip
    kcal_per_unit: food.kcal,
    basis,
    grams: round((basis === 1 ? food.grams_per_unit * qty : qty)),
    kcal: Math.round(food.kcal * f),
    protein_g: round(food.protein_g * f),
    carbs_g: round(food.carbs_g * f),
    fat_g: round(food.fat_g * f),
    sugar_g: round(food.sugar_g * f),
  }
}

export const totals = (rows) => ({
  kcal: rows.reduce((t, r) => t + r.kcal, 0),
  protein_g: round(rows.reduce((t, r) => t + r.protein_g, 0)),
  carbs_g: round(rows.reduce((t, r) => t + r.carbs_g, 0)),
  fat_g: round(rows.reduce((t, r) => t + r.fat_g, 0)),
  sugar_g: round(rows.reduce((t, r) => t + r.sugar_g, 0)),
})

// Turns {name, qty} pairs into real rows by reading the table. Used by the
// agent to PROPOSE and again at commit time to RECOMPUTE - the numbers are
// never carried across the network and trusted.
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']

// When the model gives no meal and the entry is for today, the clock decides.
// For a backfilled day the clock means nothing, so it stays unset.
export function inferMeal(meal, day) {
  if (MEALS.includes(meal)) return meal
  if (day !== localDate()) return null
  const h = new Date().getHours()
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 22 ? 'dinner' : 'snack'
}

export async function buildProposal(userId, { date, meal, items = [] }, fallbackDate) {
  // Precedence: a date the model worked out from the sentence ("yesterday"),
  // then the day the user has selected in the UI, then today.
  const day = date || fallbackDate || localDate()
  const slot = inferMeal(meal, day)
  const rows = []
  for (const item of items) {
    const food = await getFood(userId, item.name)
    // A missing food is a hard stop, not a guess. This is what forces the
    // model to look up and save before anything can ever be written.
    if (!food) return { error: 'unknown_food', name: item.name }
    rows.push({ ...scale(food, Number(item.qty)), date: day, meal: slot })
  }
  return { date: day, meal: slot, rows, totals: totals(rows) }
}

// A per-unit calorie the user typed on the review card is a CORRECTION, not a
// number to distrust. It overwrites the stored food, so the fix applies to
// every future log of it - the mistake is corrected once, not every time.
// Macros scale with the change, since we only know the ratio, not a new
// breakdown.
export async function applyCorrections(userId, items = []) {
  const corrected = []
  for (const item of items) {
    const edit = Number(item.kcal_per_unit)
    if (!Number.isFinite(edit) || edit <= 0) continue
    const food = await getFood(userId, item.name)
    if (!food || Math.abs(food.kcal - edit) < 0.5) continue

    const ratio = edit / (food.kcal || edit)
    await putFood(userId, {
      ...food,
      kcal: edit,
      protein_g: round(food.protein_g * ratio),
      carbs_g: round(food.carbs_g * ratio),
      fat_g: round(food.fat_g * ratio),
      sugar_g: round(food.sugar_g * ratio),
    })
    corrected.push({ name: food.name, from: food.kcal, to: edit })
  }
  return corrected
}

export async function commitProposal(userId, { date, meal, items }) {
  const corrected = await applyCorrections(userId, items)
  // Rebuilt AFTER the corrections land, so totals reflect the edits and are
  // still computed here rather than trusted from the client.
  const proposal = await buildProposal(userId, { date, meal, items })
  if (proposal.error) return proposal
  await appendLog(userId, proposal.rows)
  return { written: true, corrected, ...proposal }
}

// `propose` differs by front end: the CLI asks y/n inline, the web app hands
// the proposal to the UI and waits for a button. The model cannot tell.
export function makeTools({ propose, forDate, userId = null }) {
  return {
    async lookup_food({ names = [] }) {
      const all = await getFoods(userId)
      const hits = {}
      const misses = []
      for (const raw of names) {
        const exact = all[normalize(raw)]
        if (exact) { hits[normalize(raw)] = exact; continue }
        // A near match is reported as a hit under the name already stored, so
        // the model logs against the existing food instead of making a twin.
        const near = await findSimilar(userId, raw, all)
        if (near) hits[near.food.name] = { ...near.food, matched_your_text: raw }
        else misses.push(raw)
      }
      return { hits, misses }
    },

    async save_food(args) {
      const all = await getFoods(userId)
      const near = all[normalize(args.name)] ? null : await findSimilar(userId, args.name, all)
      if (near) {
        return {
          error: 'similar_food_already_exists',
          existing: near.food.name,
          detail: `"${args.name}" is the same as "${near.food.name}" which you already have. ` +
            `Use "${near.food.name}" in log_meal. Only save a new food if it is genuinely different ` +
            `(a different size or product), and then give it a clearly different name.`,
        }
      }
      await putFood(userId, {
        name: args.name.trim(),
        unit: args.unit,
        grams_per_unit: args.grams_per_unit,
        kcal: args.kcal,
        protein_g: args.protein_g,
        carbs_g: args.carbs_g,
        fat_g: args.fat_g,
        sugar_g: args.sugar_g,
      })
      return { saved: normalize(args.name) }
    },

    async log_meal(args) {
      const proposal = await buildProposal(userId, args, forDate)
      if (proposal.error) return proposal
      return propose(proposal)
    },

    async query_history({ from, to }) {
      const rows = await getLog(userId, from, to)
      const byDay = {}
      for (const r of rows) {
        byDay[r.date] ??= { kcal: 0, protein_g: 0, sugar_g: 0, items: [] }
        byDay[r.date].kcal += r.kcal
        byDay[r.date].protein_g = round(byDay[r.date].protein_g + r.protein_g)
        byDay[r.date].sugar_g = round(byDay[r.date].sugar_g + r.sugar_g)
        byDay[r.date].items.push(`${r.qty} x ${r.name}`)
      }
      return { days: byDay, entry_count: rows.length }
    },
  }
}
