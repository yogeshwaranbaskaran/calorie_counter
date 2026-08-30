import { deleteEntry } from '../src/store.js'
import { send, authed } from '../src/http.js'

// Deleting a mis-logged meal. A tracker you cannot correct is one you stop
// trusting, and then stop opening.
export default async function handler(req, res) {
  if (!authed(req)) return send(res, 401, { error: 'bad passcode' })
  if (req.method !== 'DELETE') return send(res, 405, { error: 'DELETE only' })

  const id = new URL(req.url, 'http://x').searchParams.get('id')
  if (!id) return send(res, 400, { error: 'no id' })

  try {
    return send(res, 200, { deleted: await deleteEntry(id) })
  } catch (err) {
    return send(res, 500, { error: String(err.message ?? err) })
  }
}
