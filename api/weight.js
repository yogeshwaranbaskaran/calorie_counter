import { getWeights, putWeight, updateWeight, deleteWeight, localDate } from '../src/store.js'
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
      const kg2 = Math.round(n * 100) / 100   // the scale reads two decimals; keep them
      await putWeight(who.userId, day, kg2)
      return send(res, 200, { ok: true, date: day, kg: kg2 })
    }
    if (req.method === 'PATCH') {
      const { from, date, kg } = await readBody(req)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '')) return send(res, 400, { error: 'from must be YYYY-MM-DD' })
      const row = await updateWeight(who.userId, from, { date, kg: Number(kg) })
      return row ? send(res, 200, { updated: true, ...row }) : send(res, 404, { error: 'no reading on that date' })
    }
    if (req.method === 'DELETE') {
      const date = new URL(req.url, 'http://x').searchParams.get('date')
      return send(res, 200, { deleted: await deleteWeight(who.userId, date) })
    }
    return send(res, 405, { error: 'GET, POST, PATCH or DELETE' })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
