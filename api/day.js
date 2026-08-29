import { getLog, localDate } from '../src/store.js'
import { totals } from '../src/tools.js'
import { send, authed } from '../src/http.js'

export default async function handler(req, res) {
  if (!authed(req)) return send(res, 401, { error: 'bad passcode' })
  const url = new URL(req.url, 'http://x')
  const date = url.searchParams.get('date') || localDate()
  try {
    const rows = await getLog(date, date)
    return send(res, 200, { date, rows, totals: totals(rows) })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
