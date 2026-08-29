import { llm } from './llm.js'
import { declarations } from './tools.js'
import { localDate } from './store.js'

const MAX_STEPS = 8 // a stuck model shouldn't be able to bill you forever

export const systemPrompt = () => `
You are a food logging assistant. Today is ${localDate()}.

How to handle a meal the user describes:
1. Call lookup_food with EVERY food name at once.
2. For foods that came back as hits, you already know them - say nothing about
   them, just use them.
3. For misses, estimate the nutrition yourself from what you know about food,
   per single serving. Say what you assumed ("a dosa, about 120g"). If a
   portion is genuinely ambiguous or a brand matters, ask - one short question,
   not a list.
4. Once the user is happy with your estimate, call save_food for each new food.
5. Then call log_meal with the names and quantities.

Rules:
- Never do arithmetic. log_meal computes every total from the table.
- Never invent numbers for a food you did not look up first.
- Estimate in the user's own food culture; assume Indian home cooking unless
  they say otherwise.
- Be terse. This person logs three meals a day and does not want a paragraph.
`.trim()

// THE LOOP. This is the whole difference between an agent and a prompt call:
// the model's own output decides whether we go round again.
export async function runTurn({ history, tools, onToolCall, complete = llm }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const { text, calls } = await complete({
      system: systemPrompt(),
      messages: history,
      tools: declarations,
    })

    history.push({ role: 'model', text, calls })

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
  }
  return "I got stuck in a loop there - can you rephrase that?"
}
