import range from './range.js'
import { getInsights } from '../src/insights.js'
import { send, requireUser } from '../src/http.js'
import { keyForUser } from '../src/auth.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  const { key, missingKey } = keyForUser(who.user)
  if (missingKey) return send(res, 402, { error: 'Add your Gemini API key first.', code: 'no_key' })

  // Reuse the range handler rather than recomputing the window, by capturing
  // what it would have sent.
  let captured = null
  const sink = { statusCode: 200, setHeader() {}, end: (b) => (captured = JSON.parse(b)) }
  await range({ ...req, url: req.url.replace('/api/insights', '/api/range') }, sink)

  if (!captured || captured.error) return send(res, 500, { error: captured?.error ?? 'no data' })
  if (!captured.daysLogged) {
    return send(res, 200, { empty: true, message: 'Log a few meals first - there is nothing to read yet.' })
  }

  try {
    return send(res, 200, { range: { from: captured.from, to: captured.to }, ...(await getInsights(captured, key)) })
  } catch (err) {
    const msg = err.code === 'rate_limit'
      ? "Gemini's free tier is rate limited - try again in a minute."
      : 'Could not generate insights.'
    return send(res, err.code === 'rate_limit' ? 429 : 500, { error: msg })
  }
}
