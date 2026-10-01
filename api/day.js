import { getLog, getTargets, moveDay, localDate } from '../src/store.js'
import { totals } from '../src/tools.js'
import { send, requireUser, readBody } from '../src/http.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  if (req.method === 'PATCH') {
    const { from, to } = await readBody(req)
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '')
    if (!ok(from) || !ok(to)) return send(res, 400, { error: 'from and to must be YYYY-MM-DD' })
    try { return send(res, 200, { moved: await moveDay(who.userId, from, to), from, to }) }
    catch (err) { return send(res, 500, { error: String(err.message ?? err) }) }
  }

  const url = new URL(req.url, 'http://x')
  const date = url.searchParams.get('date') || localDate()
  try {
    const [rows, targets] = await Promise.all([getLog(who.userId, date, date), getTargets(who.userId)])
    return send(res, 200, { date, rows, totals: totals(rows), targets })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
