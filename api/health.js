import { backend, getLog } from '../src/store.js'
import { send } from '../src/http.js'

// Deliberately NOT behind the passcode: Render's health check cannot send a
// header, and a check that always 401s would restart the service forever.
// It exposes nothing an attacker gains from - no food, no totals.
export default async function handler(req, res) {
  const store = backend()
  try {
    // Touch the database so a broken DATABASE_URL fails the check rather than
    // quietly serving an app that cannot read anything.
    if (store === 'postgres') await getLog(null, '1970-01-01', '1970-01-01')
    return send(res, 200, { ok: true, store })
  } catch (err) {
    // A socket error often carries an empty message and all the meaning in
    // .code - reporting "" tells nobody anything.
    const why = [err.code, err.message].filter(Boolean).join(': ') || String(err)
    return send(res, 503, { ok: false, store, error: why.slice(0, 160) })
  }
}
