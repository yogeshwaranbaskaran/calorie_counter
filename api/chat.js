import { runTurn } from '../src/agent.js'
import { makeTools } from '../src/tools.js'
import { send, requireUser, readBody } from '../src/http.js'
import { keyForUser } from '../src/auth.js'
import { quickParse } from '../src/quicklog.js'
import { buildProposal, inferMeal } from '../src/tools.js'

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

  // Foods you have eaten before, with a clear quantity, need no model at all -
  // every number is already in your table. The agent still handles anything
  // new, ambiguous, or phrased as a question. On a congested free tier this is
  // the difference between instant and half a minute.
  const said = messages.at(-1)?.role === 'user' ? messages.at(-1).text : null
  if (said) {
    const items = await quickParse(who.userId, said)
    if (items) {
      const proposal = await buildProposal(who.userId, { items, meal: inferMeal(null, forDate ?? undefined) }, forDate)
      if (!proposal.error) {
        return send(res, 200, {
          reply: '', proposal, calls: ['from your food table'], fast: true,
          // No model turn here on purpose: it would have no parts, and a
          // request ending on a model turn is a 400 from Gemini.
          history: messages,
        })
      }
    }
  }
  let history = messages.slice(-40) // keep the context window bounded
  // Gemini: "Requests ending with a model turn are not supported." Older
  // clients still hold a transcript that ends that way, so trim it here.
  while (history.length && history.at(-1).role === 'model') history.pop()

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

  // Indian mobile carriers and NATs drop IDLE connections, often inside a
  // minute, and a food the table has never seen leaves this request silent for
  // 10-30s while the agent works. The same request, to the same server,
  // survives on fibre in Japan and dies on mobile in India - and it dies after
  // save_food has already run, so the user is left with a food she can see but
  // never managed to log. A busy connection is not an idle one, so answer with
  // headers at once and trickle a line every few seconds. The real payload is
  // the LAST line; the client reads only that.
  const startedAt = Date.now()
  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson')
  res.setHeader('cache-control', 'no-store')
  res.flushHeaders?.()
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(`{"wait":${Math.round((Date.now() - startedAt) / 1000)}}\n`)
  }, Number(process.env.HEARTBEAT_MS || 5000))
  // If she closes the app mid-request, stop writing into a dead socket.
  res.on('close', () => clearInterval(beat))
  const finish = (bodyObj) => {
    clearInterval(beat)
    if (!res.writableEnded) res.end(JSON.stringify(bodyObj) + '\n')
  }

  const calls = []
  const run = (msgs) => runTurn({
    history: msgs, tools, forDate,
    userId: who.userId,
    apiKey: key,
    onToolCall: (c) => calls.push(c.name),
    stop: () => pending !== null,
  })

  let reply
  try {
    reply = await run(history)
  } catch (err) {
    // A 400 that is NOT about the key means Gemini refused the conversation,
    // not the credentials. The history lives in the browser and there is no
    // way for the user to clear it, so without this every later message fails
    // the same way for ever. Throw the history away and retry with nothing but
    // what they just said.
    if (err.code !== 'bad_request' || !said) return fail(finish, err, who, pending, history)
    console.error(`chat: bad_request for user ${who.userId} - ${err.message}`)
    pending = null
    calls.length = 0
    history = [{ role: 'user', text: said }]
    try {
      reply = await run(history)
      console.warn(`chat: user ${who.userId} recovered after dropping ${messages.length} turns`)
    } catch (again) {
      return fail(finish, again, who, pending, history)
    }
  }
  // `unpaid` rides along so the UI can show the subscription notice without
  // a second request, and without blocking the meal that just worked.
  return finish({ reply, proposal: pending, calls, history, plan, unpaid })
}

// Every upstream failure records the real reason before it is turned into a
// sentence. What the user sees must never be the only account of what broke -
// that is how "check the server logs" came to point at an empty log.
// The status line is long gone by the time anything fails - headers went out
// before the agent started - so an error travels in the last line with its
// code, exactly where the client already looks for it.
function fail(finish, err, who, pending, history) {
  console.error(`chat: ${err.code ?? 'unknown'} for user ${who.userId} - ${err.message}`)
  const message = {
    rate_limit: "Gemini's free tier is rate limited - wait a few seconds and say that again.",
    bad_key: 'The Gemini API key is missing or wrong.',
    bad_request: 'Gemini could not read that one. Try saying it in fewer words.',
  }[err.code] ?? 'Something broke upstream. Try again.'
  // The proposal survives the error: if log_meal already ran, the user can
  // still confirm it rather than retyping the whole meal.
  return finish({ error: message, code: err.code ?? 'unknown', proposal: pending, history })
}
