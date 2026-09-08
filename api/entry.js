import { deleteEntry } from '../src/store.js'
import { send, requireUser } from '../src/http.js'

// Deleting a mis-logged meal. A tracker you cannot correct is one you stop
// trusting, and then stop opening.
export default async function handler(req, res) {
  const who = await requireUser(req, res)
  if (!who) return
  if (req.method !== 'DELETE') return send(res, 405, { error: 'DELETE only' })

  const id = new URL(req.url, 'http://x').searchParams.get('id')
  if (!id) return send(res, 400, { error: 'no id' })

  try {
    return send(res, 200, { deleted: await deleteEntry(who.userId, id) })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
