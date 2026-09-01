import range from './range.js'
import { getInsights } from '../src/insights.js'
import { send, authed } from '../src/http.js'

export default async function handler(req, res) {
  if (!authed(req)) return send(res, 401, { error: 'bad passcode' })

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
    return send(res, 200, { range: { from: captured.from, to: captured.to }, ...(await getInsights(captured)) })
  } catch (err) {
    const msg = err.code === 'rate_limit'
      ? "Gemini's free tier is rate limited - try again in a minute."
      : 'Could not generate insights.'
    return send(res, err.code === 'rate_limit' ? 429 : 500, { error: msg })
  }
}
