import { llm } from './llm.js'

// The insights pass is deliberately NOT a tool loop. Two weeks of daily totals
// is small enough to hand over whole, so a loop would only add round trips -
// and on a 5-requests-per-minute free tier every extra call is a real cost.
// The logging agent is where tool use earns its place; this is one careful read.
const SYSTEM = `
You are reading someone's food log and telling them what to change.

Be specific and short. Ground every claim in their numbers - name the food, the
day, the amount. No generic nutrition advice, no "consult a professional", no
preamble.

Return EXACTLY this shape, nothing else:

PATTERN: <one sentence on the clearest pattern in the data>
INCREASE: <one thing to eat more of, and why, from their data>
REDUCE: <one thing to cut back, and why, from their data>
NOTE: <one honest caveat - thin data, missing meals, or a day that skews it>

Assume Indian home cooking. If there is too little data to say something
honest, say so in NOTE rather than inventing a trend.
`.trim()

export async function getInsights(range, apiKey) {
  const rows = range.days.map((d) =>
    `${d.date}: ${d.kcal} kcal, ${d.protein_g}g protein, ${d.carbs_g}g carbs, ` +
    `${d.fat_g}g fat, ${d.sugar_g}g sugar` +
    (d.items.length ? ` — ${d.items.map((i) => `${i.qty}x ${i.name}`).join(', ')}` : ' — nothing logged')
  ).join('\n')

  const summary =
    `Days logged: ${range.daysLogged} of ${range.days.length}\n` +
    `Daily average on logged days: ${range.averages.kcal} kcal, ` +
    `${range.averages.protein_g}g protein, ${range.averages.carbs_g}g carbs, ` +
    `${range.averages.fat_g}g fat, ${range.averages.sugar_g}g sugar\n\n${rows}`

  const { text } = await llm({ system: SYSTEM, messages: [{ role: 'user', text: summary }], apiKey })

  const field = (label) =>
    text.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`))?.[1]?.trim() ?? ''

  return {
    pattern: field('PATTERN'),
    increase: field('INCREASE'),
    reduce: field('REDUCE'),
    note: field('NOTE'),
    raw: text,
  }
}
