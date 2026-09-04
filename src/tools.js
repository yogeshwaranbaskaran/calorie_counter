// What the agent can DO. Note what is NOT here: there is no "estimate calories"
// tool. Estimating is thinking, and the model already thinks. Tools exist only
// for what it CANNOT do - read the table, write the table.
import { getFood, putFood, appendLog, getLog, normalize, localDate } from './store.js'

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
export async function buildProposal({ date, items = [] }, fallbackDate) {
  // Precedence: a date the model worked out from the sentence ("yesterday"),
  // then the day the user has selected in the UI, then today.
  const day = date || fallbackDate || localDate()
  const rows = []
  for (const item of items) {
    const food = await getFood(item.name)
    // A missing food is a hard stop, not a guess. This is what forces the
    // model to look up and save before anything can ever be written.
    if (!food) return { error: 'unknown_food', name: item.name }
    rows.push({ ...scale(food, Number(item.qty)), date: day })
  }
  return { date: day, rows, totals: totals(rows) }
}

// A per-unit calorie the user typed on the review card is a CORRECTION, not a
// number to distrust. It overwrites the stored food, so the fix applies to
// every future log of it - the mistake is corrected once, not every time.
// Macros scale with the change, since we only know the ratio, not a new
// breakdown.
export async function applyCorrections(items = []) {
  const corrected = []
  for (const item of items) {
    const edit = Number(item.kcal_per_unit)
    if (!Number.isFinite(edit) || edit <= 0) continue
    const food = await getFood(item.name)
    if (!food || Math.abs(food.kcal - edit) < 0.5) continue

    const ratio = edit / (food.kcal || edit)
    await putFood({
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

export async function commitProposal({ date, items }) {
  const corrected = await applyCorrections(items)
  // Rebuilt AFTER the corrections land, so totals reflect the edits and are
  // still computed here rather than trusted from the client.
  const proposal = await buildProposal({ date, items })
  if (proposal.error) return proposal
  await appendLog(proposal.rows)
  return { written: true, corrected, ...proposal }
}

// `propose` differs by front end: the CLI asks y/n inline, the web app hands
// the proposal to the UI and waits for a button. The model cannot tell.
export function makeTools({ propose, forDate }) {
  return {
    async lookup_food({ names = [] }) {
      const hits = {}
      const misses = []
      for (const raw of names) {
        const food = await getFood(raw)
        if (food) hits[normalize(raw)] = food
        else misses.push(raw)
      }
      return { hits, misses }
    },

    async save_food(args) {
      await putFood({
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
      const proposal = await buildProposal(args, forDate)
      if (proposal.error) return proposal
      return propose(proposal)
    },

    async query_history({ from, to }) {
      const rows = await getLog(from, to)
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
