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
// The user's calendar day, not the server's. A phone in Japan is a day ahead
// of a UTC server for nine hours every morning, which is exactly when someone
// weighs themselves - and a window bounded by the server's date threw that
// reading away, along with the day's food. No timezone is more than one day
// off UTC, so anything further than that is a wrong clock and gets ignored.
function userToday(req) {
  const asked = new URL(req.url, 'http://x').searchParams.get('today')
  const server = localDate()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked ?? '')) return server
  return asked > shiftDate(server, 1) || asked < shiftDate(server, -1) ? server : asked
}

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  try {
    const today = userToday(req)
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

    // Maintenance from the data: average logged intake minus the energy the
    // weight trend implies.
    //
    // The trend is a LEAST-SQUARES slope over every reading, not a comparison
    // of a first and last window. Those windows overlapped whenever there were
    // fewer than 14 readings, and the span was measured between their median
    // dates - so a 0.74 kg loss over 17 days was divided by 3 and reported as
    // a 1900 kcal/day deficit. Regression uses every point, cannot overlap
    // itself, and degrades gracefully as readings arrive.
    let maintenance = null
    if (series.length >= 7) {
      const t0 = new Date(series[0].date)
      const xs = series.map((s) => (new Date(s.date) - t0) / 864e5)
      const ys = series.map((s) => s.kg)
      const spanDays = xs.at(-1)
      const mx = xs.reduce((t, x) => t + x, 0) / xs.length
      const my = ys.reduce((t, y) => t + y, 0) / ys.length
      const sxx = xs.reduce((t, x) => t + (x - mx) ** 2, 0)
      const sxy = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0)

      const inWindow = intakeDays.filter((d) => d >= series[0].date && d <= series.at(-1).date)
      if (sxx > 0 && spanDays >= 10 && inWindow.length >= 7) {
        const slope = sxy / sxx // kg per day, negative = losing
        const avgIntake = inWindow.reduce((t, d) => t + byDay[d], 0) / inWindow.length

        // How much of the scatter the trend actually explains. A low value
        // means the readings are noise around a flat line and the number below
        // should not be taken seriously yet.
        const ssTot = ys.reduce((t, y) => t + (y - my) ** 2, 0)
        const ssRes = ys.reduce((t, y, i) => t + (y - (my + slope * (xs[i] - mx))) ** 2, 0)
        const fit = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

        maintenance = {
          kcal: Math.round(avgIntake - slope * KCAL_PER_KG),
          avg_intake: Math.round(avgIntake),
          kg_per_week: round1(slope * 7),
          over_days: Math.round(spanDays),
          readings: series.length,
          intake_days: inWindow.length,
          fit: Math.round(fit * 100) / 100,
          // Under three weeks, water movement still dominates the trend; a
          // poor fit means the line is guesswork whatever the span.
          confidence: spanDays >= 28 && fit >= 0.5 ? 'good'
            : spanDays >= 14 && fit >= 0.3 ? 'fair' : 'low',
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
