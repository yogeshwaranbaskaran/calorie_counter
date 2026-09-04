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

export const systemPrompt = async (forDate) => {
  const foods = Object.values(await getFoods())
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
5. Then call log_meal with the names and quantities.

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
export async function runTurn({ history, tools, onToolCall, complete = llm, stop, forDate }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const { text, calls, _raw } = await complete({
      system: await systemPrompt(forDate),
      messages: history,
      tools: declarations,
      thinking: 'low',
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
