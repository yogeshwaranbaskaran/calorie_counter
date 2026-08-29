import { commitProposal } from '../src/tools.js'
import { send, authed, readBody } from '../src/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  if (!authed(req)) return send(res, 401, { error: 'bad passcode' })

  const { date, items } = await readBody(req)
  if (!Array.isArray(items) || !items.length) return send(res, 400, { error: 'no items' })

  try {
    // Only names and quantities cross the network. Every number is recomputed
    // here from the food table, so a tampered client cannot log fake calories.
    const result = await commitProposal({ date, items })
    return send(res, result.error ? 400 : 200, result)
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
