import { getLog, localDate } from '../src/store.js'
import { totals } from '../src/tools.js'
import { send, requireUser } from '../src/http.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  const url = new URL(req.url, 'http://x')
  const date = url.searchParams.get('date') || localDate()
  try {
    const rows = await getLog(who.userId, date, date)
    return send(res, 200, { date, rows, totals: totals(rows) })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
