import { getLog, localDate } from '../src/store.js'
import { send, authed } from '../src/http.js'

const round = (n) => Math.round(n * 10) / 10
const KEYS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g']

export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days) // local, not UTC
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

// Everything the week and stats views need, computed once on the server so the
// client stays a renderer rather than a second source of truth for the numbers.
export default async function handler(req, res) {
  if (!authed(req)) return send(res, 401, { error: 'bad passcode' })
  const q = new URL(req.url, 'http://x').searchParams
  const to = q.get('to') || localDate()
  const span = Math.min(Number(q.get('days') || 7), 90)
  const from = q.get('from') || shiftDate(to, -(span - 1))

  try {
    const rows = await getLog(from, to)

    // Every day in the window, including the empty ones - a week chart with
    // missing bars reads as "no data" rather than "you ate nothing".
    const days = {}
    for (let d = from; d <= to; d = shiftDate(d, 1)) {
      days[d] = { date: d, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugar_g: 0, items: [] }
    }

    const foods = {}
    for (const r of rows) {
      const day = days[r.date]
      if (!day) continue
      for (const k of KEYS) day[k] = round(day[k] + (r[k] ?? 0))
      day.items.push({ id: r.id, name: r.name, qty: r.qty, unit: r.unit, kcal: r.kcal })

      const f = (foods[r.name] ??= { name: r.name, times: 0, kcal: 0 })
      f.times += 1
      f.kcal += r.kcal ?? 0
    }

    const list = Object.values(days)
    const logged = list.filter((d) => d.items.length)
    const avg = {}
    for (const k of KEYS) {
      // Averaged over days you actually logged. Dividing by 7 when you logged
      // three days would quietly report a diet you are not eating.
      avg[k] = logged.length ? round(logged.reduce((t, d) => t + d[k], 0) / logged.length) : 0
    }

    return send(res, 200, {
      from, to,
      days: list,
      daysLogged: logged.length,
      averages: avg,
      topFoods: Object.values(foods).sort((a, b) => b.times - a.times).slice(0, 8),
    })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
