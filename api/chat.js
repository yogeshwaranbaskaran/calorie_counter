import { runTurn } from '../src/agent.js'
import { makeTools } from '../src/tools.js'
import { send, authed, readBody } from '../src/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  if (!authed(req)) return send(res, 401, { error: 'bad passcode' })

  const { messages = [] } = await readBody(req)
  const history = messages.slice(-40) // keep the context window bounded

  // The web confirm gate: log_meal cannot write. It parks a proposal, the loop
  // reports it, and the UI shows buttons. Committing is a separate request.
  let pending = null
  const tools = makeTools({
    propose: async (proposal) => {
      pending = proposal
      return { status: 'awaiting_user_confirmation', shown_to_user: true }
    },
  })

  try {
    const calls = []
    const reply = await runTurn({ history, tools, onToolCall: (c) => calls.push(c.name) })
    return send(res, 200, { reply, proposal: pending, calls, history })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
