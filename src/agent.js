import { llm } from './llm.js'
import { declarations } from './tools.js'
import { localDate, getFoods } from './store.js'

const MAX_STEPS = 8 // a stuck model shouldn't be able to bill you forever

// The known-foods list is injected up front rather than fetched with a tool
// call. A round trip to Gemini costs seconds and counts against a ~5/minute
// free tier, while a hundred foods is a few hundred tokens - so for a meal of
// foods you have eaten before the model can go straight to log_meal, halving
// the latency of the common case. lookup_food stays for anything not listed.
const MAX_INLINE_FOODS = 150

export const systemPrompt = async (forDate, userId = null) => {
  const foods = Object.values(await getFoods(userId))
  const known = foods.length && foods.length <= MAX_INLINE_FOODS
    ? `\n\nFoods you already know (per single unit) - use these directly, do NOT look them up:\n` +
      foods.map((f) => `- ${f.name}: 1 ${f.unit} = ${f.grams_per_unit}g, ${f.kcal} kcal, ${f.protein_g}g protein`).join('\n')
    : ''

  const today = localDate()
  const backfill = forDate && forDate !== today
    ? `\n\nThe user is BACKFILLING an earlier day: ${forDate}. Log everything to
that date unless they name a different one. Do not say it is in the past.`
    : ''

  return `
You are a food logging assistant. Today is ${today}.${backfill}

How to handle a meal the user describes:
1. If every food is in the known list below, skip straight to step 5.
2. Otherwise call lookup_food for the names you do not already have.
3. For anything still unknown, estimate the nutrition yourself from what you
   know about food, per single serving. Say what you assumed ("a dosa, about
   120g"). If a portion is genuinely ambiguous or a brand matters, ask - one
   short question, not a list.
4. Once the user is happy with your estimate, call save_food for each new food.
   NEVER create a food that is a re-wording or misspelling of one you already
   have - "bread with bbutter" IS "bread with butter". Reuse the stored name.
   save_food will refuse a near duplicate and tell you which food to use.
5. Then call log_meal with the names, quantities and the meal - breakfast,
   lunch, dinner or snack. Take it from the words if they say ("for lunch I
   had"); otherwise from the time of day: it is currently ${new Date().getHours()}:00.

Reading quantities correctly matters more than anything else here. A number
touching a unit is NEVER a count:
- "400g of chicken" is a WEIGHT: unit "g", qty 400 - never 4 servings.
- "300cal icecream" states the CALORIES of ONE serving: qty 1, kcal 300.
- "50g of biscuits" is 50 grams, not 5 biscuits.
- "500ml milk" is a volume, not 5 of anything.
- Only a bare number before a countable food is a count: "5 chapati" is 5.
If the user has already told you the calories, USE THAT NUMBER. Do not
estimate over it.

Units and what "kcal" means for each, when you call save_food:
- Countable things (piece, bowl, cup, plate, slice, glass): kcal is for ONE of
  them. grams_per_unit is what one weighs.
- Weights and volumes (unit "g" or "ml"): kcal is PER 100, exactly as a
  nutrition label states it. Set grams_per_unit to 100. So chicken at
  180 kcal/100g is saved as unit "g", kcal 180 - and logged with qty 400.

Rules:
- Never do arithmetic. log_meal computes every total from the table.
- Never invent numbers for a food you did not look up first.
- Estimate in the user's own food culture; assume Indian home cooking unless
  they say otherwise.
- Be terse. This person logs three meals a day and does not want a paragraph.
${known}
`.trim()
}

// THE LOOP. This is the whole difference between an agent and a prompt call:
// the model's own output decides whether we go round again.
// `stop` lets a front end end the turn the moment it has what it needs. When
// log_meal parks a proposal the UI already renders the card, so asking the
// model for a closing sentence costs an entire extra round trip - seconds, and
// one of about five requests a minute - to say nothing the user needs.
export async function runTurn({ history, tools, onToolCall, complete = llm, stop, forDate, userId = null, apiKey }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const { text, calls, _raw } = await complete({
      system: await systemPrompt(forDate, userId),
      messages: history,
      tools: declarations,
      thinking: 'low',
      apiKey,
    })

    history.push({ role: 'model', text, calls, _raw })

    // No tool calls means the model considers its turn finished.
    if (calls.length === 0) return text

    for (const call of calls) {
      onToolCall?.(call)
      const fn = tools[call.name]
      const result = fn
        ? await fn(call.args).catch((e) => ({ error: String(e.message ?? e) }))
        : { error: `no such tool: ${call.name}` }
      history.push({ role: 'tool', name: call.name, result })
    }

    if (stop?.()) return ''
  }
  return "I got stuck in a loop there - can you rephrase that?"
}
