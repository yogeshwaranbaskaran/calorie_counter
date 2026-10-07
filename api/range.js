import { getLog, localDate } from '../src/store.js'
import { send, requireUser } from '../src/http.js'

const round = (n) => Math.round(n * 10) / 10
const KEYS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g', 'fiber_g']

export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days) // local, not UTC
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

// Everything the week, stats and insights views need. A plain function, not a
// handler: insights used to call the handler with a spread copy of the request,
// which silently dropped `headers` - a prototype getter on a real
// IncomingMessage - and threw before any try block could report it. Share the
// computation, never a faked request.
export async function computeRange(userId, { to, days, from } = {}) {
  const end = to || localDate()
  const span = Math.min(Number(days || 7), 90)
  const start = from || shiftDate(end, -(span - 1))

  const rows = await getLog(userId, start, end)

  // Every day in the window, including the empty ones - a chart with missing
  // bars reads as "no data" rather than "you ate nothing".
  const byDate = {}
  for (let d = start; d <= end; d = shiftDate(d, 1)) {
    byDate[d] = { date: d, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugar_g: 0, fiber_g: 0, items: [] }
  }

  const foods = {}
  for (const r of rows) {
    const day = byDate[r.date]
    if (!day) continue
    for (const k of KEYS) day[k] = round(day[k] + (r[k] ?? 0))
    day.items.push({ id: r.id, name: r.name, qty: r.qty, unit: r.unit, meal: r.meal, kcal: r.kcal })

    const f = (foods[r.name] ??= { name: r.name, times: 0, kcal: 0 })
    f.times += 1
    f.kcal += r.kcal ?? 0
  }

  const list = Object.values(byDate)
  const logged = list.filter((d) => d.items.length)
  const averages = {}
  for (const k of KEYS) {
    // Averaged over days you actually logged. Dividing by 7 when you logged
    // three would quietly report a diet you are not eating.
    averages[k] = logged.length ? round(logged.reduce((t, d) => t + d[k], 0) / logged.length) : 0
  }

  return {
    from: start,
    to: end,
    days: list,
    daysLogged: logged.length,
    averages,
    topFoods: Object.values(foods).sort((a, b) => b.times - a.times).slice(0, 8),
  }
}

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  const q = new URL(req.url, 'http://x').searchParams
  try {
    return send(res, 200, await computeRange(who.userId, {
      to: q.get('to'), from: q.get('from'), days: q.get('days'),
    }))
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
