import { getTargets, setTargets } from '../src/store.js'
import { send, requireUser, readBody } from '../src/http.js'

export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  try {
    if (req.method === 'GET') return send(res, 200, { targets: await getTargets(who.userId) })
    if (req.method === 'POST') {
      await setTargets(who.userId, await readBody(req))
      return send(res, 200, { ok: true, targets: await getTargets(who.userId) })
    }
    return send(res, 405, { error: 'GET or POST' })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
