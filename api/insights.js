import { computeRange } from './range.js'
import { getInsights } from '../src/insights.js'
import { send, requireUser } from '../src/http.js'
import { keyForUser } from '../src/auth.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  const { key, missingKey } = keyForUser(who.user)
  if (missingKey) return send(res, 402, { error: 'Add your Gemini API key first.', code: 'no_key' })

  // Everything is inside the try now. The previous version computed the range
  // outside it, so a throw there escaped to the server's catch-all and the
  // user saw "server error" with nothing to act on.
  try {
    const days = new URL(req.url, 'http://x').searchParams.get('days') || 14
    const range = await computeRange(who.userId, { days })
    if (!range.daysLogged) {
      return send(res, 200, { empty: true, message: 'Log a few meals first - there is nothing to read yet.' })
    }
    return send(res, 200, {
      range: { from: range.from, to: range.to },
      ...(await getInsights(range, key)),
    })
  } catch (err) {
    console.error('insights', err)
    const msg = err.code === 'rate_limit'
      ? "Gemini's free tier is rate limited - try again in a minute."
      : err.code === 'timeout'
        ? 'Gemini did not answer in time. Try again.'
        : `Could not generate insights: ${String(err.message ?? err).slice(0, 120)}`
    return send(res, err.code === 'rate_limit' ? 429 : 500, { error: msg })
  }
}
