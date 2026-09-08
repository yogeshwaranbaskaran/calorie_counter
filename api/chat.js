import { runTurn } from '../src/agent.js'
import { makeTools } from '../src/tools.js'
import { send, requireUser, readBody } from '../src/http.js'
import { keyForUser } from '../src/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const who = await requireUser(req, res)
  if (!who) return

  const { key, plan, missingKey, unpaid } = keyForUser(who.user)
  if (missingKey) {
    return send(res, 402, {
      error: 'Add your own Gemini API key in settings, or switch to the hosted plan.',
      code: 'no_key', needsKey: true,
    })
  }

  const { messages = [], date } = await readBody(req)
  const forDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : undefined
  const history = messages.slice(-40) // keep the context window bounded

  // The web confirm gate: log_meal cannot write. It parks a proposal, the loop
  // reports it, and the UI shows buttons. Committing is a separate request.
  let pending = null
  const tools = makeTools({
    userId: who.userId,
    forDate,
    propose: async (proposal) => {
      pending = proposal
      return { status: 'awaiting_user_confirmation', shown_to_user: true }
    },
  })

  try {
    const calls = []
    const reply = await runTurn({
      history, tools, forDate,
      userId: who.userId,
      apiKey: key,
      onToolCall: (c) => calls.push(c.name),
      stop: () => pending !== null,
    })
    // `unpaid` rides along so the UI can show the subscription notice without
    // a second request, and without blocking the meal that just worked.
    return send(res, 200, { reply, proposal: pending, calls, history, plan, unpaid })
  } catch (err) {
    const message = {
      rate_limit: "Gemini's free tier is rate limited - wait a few seconds and say that again.",
      bad_key: 'The Gemini API key is missing or wrong.',
      bad_request: 'Gemini rejected the request. Check the server logs.',
    }[err.code] ?? 'Something broke upstream. Try again.'
    // The proposal survives the error: if log_meal already ran, the user can
    // still confirm it rather than retyping the whole meal.
    return send(res, err.code === 'rate_limit' ? 429 : 500, {
      error: message, code: err.code ?? 'unknown', proposal: pending, history,
    })
  }
}
