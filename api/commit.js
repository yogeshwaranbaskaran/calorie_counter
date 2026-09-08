import { commitProposal } from '../src/tools.js'
import { send, requireUser, readBody } from '../src/http.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const who = await requireUser(req, res)
  if (!who) return

  const { date, items } = await readBody(req)
  if (!Array.isArray(items) || !items.length) return send(res, 400, { error: 'no items' })

  try {
    // Only names and quantities cross the network. Every number is recomputed
    // here from the food table, so a tampered client cannot log fake calories.
    const result = await commitProposal(who.userId, { date, items })
    return send(res, result.error ? 400 : 200, result)
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
