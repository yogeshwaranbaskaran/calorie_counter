import { getWeights, putWeight, deleteWeight, localDate } from '../src/store.js'
import { send, requireUser, readBody } from '../src/http.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  try {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      return send(res, 200, { weights: await getWeights(who.userId, q.get('from'), q.get('to')) })
    }
    if (req.method === 'POST') {
      const { date, kg } = await readBody(req)
      const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : localDate()
      const n = Number(kg)
      if (!Number.isFinite(n) || n < 20 || n > 400) return send(res, 400, { error: 'weight must be 20-400 kg' })
      await putWeight(who.userId, day, Math.round(n * 10) / 10)
      return send(res, 200, { ok: true, date: day, kg: Math.round(n * 10) / 10 })
    }
    if (req.method === 'DELETE') {
      const date = new URL(req.url, 'http://x').searchParams.get('date')
      return send(res, 200, { deleted: await deleteWeight(who.userId, date) })
    }
    return send(res, 405, { error: 'GET, POST or DELETE' })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
