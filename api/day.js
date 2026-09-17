import { getLog, getTargets, localDate } from '../src/store.js'
import { totals } from '../src/tools.js'
import { send, requireUser } from '../src/http.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  const url = new URL(req.url, 'http://x')
  const date = url.searchParams.get('date') || localDate()
  try {
    const [rows, targets] = await Promise.all([getLog(who.userId, date, date), getTargets(who.userId)])
    return send(res, 200, { date, rows, totals: totals(rows), targets })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
