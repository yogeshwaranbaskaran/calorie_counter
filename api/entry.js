import { deleteEntry, updateEntry } from '../src/store.js'
import { send, requireUser, readBody } from '../src/http.js'

// Deleting a mis-logged meal. A tracker you cannot correct is one you stop
// trusting, and then stop opening.
export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  if (req.method === 'PATCH') {
    const { id, qty, kcal } = await readBody(req)
    if (!id) return send(res, 400, { error: 'no id' })
    const row = await updateEntry(who.userId, id, { qty: Number(qty), kcal: Number(kcal) })
    return row ? send(res, 200, { updated: true, row }) : send(res, 404, { error: 'no such entry' })
  }
  if (req.method !== 'DELETE') return send(res, 405, { error: 'DELETE or PATCH' })

  const id = new URL(req.url, 'http://x').searchParams.get('id')
  if (!id) return send(res, 400, { error: 'no id' })

  try {
    return send(res, 200, { deleted: await deleteEntry(who.userId, id) })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
