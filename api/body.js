import { getWeights, getLog, getTargets, localDate } from '../src/store.js'
import { send, requireUser } from '../src/http.js'
import { shiftDate } from './range.js'

const round1 = (n) => Math.round(n * 100) / 100

// Energy in a kilo of bodyweight change, fat and lean mixed. The standard
// working figure; the true number varies by person, which is why the estimate
// is labelled with how much data it rests on.
const KCAL_PER_KG = 7700

// Everything the Body tab needs, and the one number the whole app has been
// guessing at: maintenance calories, measured from intake against the weight
// trend instead of a formula. Because the intake side is LOGGED intake, the
// result is maintenance in the app's own units - which is exactly what a
// target set in the app should be compared against.
export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  try {
    const today = localDate()
    const from = shiftDate(today, -89)
    const [weights, log, targets] = await Promise.all([
      getWeights(who.userId, from, today),
      getLog(who.userId, from, today),
      getTargets(who.userId),
    ])

    // 7-day rolling average, the number to watch instead of the daily reading
    const series = weights.map((w, i) => {
      const win = weights.slice(Math.max(0, i - 6), i + 1)
      return { date: w.date, kg: w.kg, avg: round1(win.reduce((t, x) => t + x.kg, 0) / win.length) }
    })

    const latest = series.at(-1) ?? null
    const ago = (days) => {
      const cutoff = shiftDate(today, -days)
      return [...series].reverse().find((s) => s.date <= cutoff) ?? null
    }
    const wk = ago(7)
    // Until there is a reading 30 days back, the earliest one stands in - as
    // long as it is at least two weeks old, or the "trend" is just noise.
    const mo = ago(30) ?? (series.length && series[0].date <= shiftDate(today, -14) ? series[0] : null)

    // daily intake on logged days
    const byDay = {}
    for (const r of log) byDay[r.date] = (byDay[r.date] ?? 0) + (r.kcal ?? 0)
    const intakeDays = Object.keys(byDay).sort()

    // Maintenance estimate: needs weight at both ends and intake in between.
    let maintenance = null
    if (series.length >= 8) {
      const first = series.slice(0, 7), last = series.slice(-7)
      const a0 = first.reduce((t, s) => t + s.kg, 0) / first.length
      const a1 = last.reduce((t, s) => t + s.kg, 0) / last.length
      const d0 = first[Math.floor(first.length / 2)].date
      const d1 = last[Math.floor(last.length / 2)].date
      const span = Math.max(1, (new Date(d1) - new Date(d0)) / 864e5)
      const inWindow = intakeDays.filter((d) => d >= series[0].date && d <= series.at(-1).date)
      if (inWindow.length >= 7) {
        const avgIntake = inWindow.reduce((t, d) => t + byDay[d], 0) / inWindow.length
        const dailyBalance = ((a1 - a0) * KCAL_PER_KG) / span
        maintenance = {
          kcal: Math.round(avgIntake - dailyBalance),
          avg_intake: Math.round(avgIntake),
          kg_change: round1(a1 - a0),
          over_days: Math.round(span),
          intake_days: inWindow.length,
          // Under ~3 weeks the water swings dominate the trend.
          confidence: span >= 28 ? 'good' : span >= 14 ? 'fair' : 'low',
        }
      }
    }

    // Projection to goal at the current 30-day rate
    let projection = null
    if (targets.goal_kg && latest && mo && mo.date !== latest.date) {
      const days = (new Date(latest.date) - new Date(mo.date)) / 864e5
      const rate = (latest.avg - mo.avg) / days // kg per day, negative = losing
      const remaining = latest.avg - targets.goal_kg
      if (remaining > 0 && rate < -0.005) {
        projection = { rate_per_week: round1(rate * 7), days: Math.round(remaining / -rate),
                       date: shiftDate(today, Math.round(remaining / -rate)) }
      } else if (remaining > 0) {
        projection = { rate_per_week: round1(rate * 7), stalled: true }
      }
    }

    return send(res, 200, {
      series,
      latest,
      change_7d: wk && latest ? round1(latest.avg - wk.avg) : null,
      change_30d: mo && latest ? round1(latest.avg - mo.avg) : null,
      goal_kg: targets.goal_kg ?? null,
      projection,
      maintenance,
    })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
