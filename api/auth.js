// /api/auth/* - sign in with Google, session, plan and key management.
import {
  authConfigured, authUrl, exchangeCode, upsertUser, makeSession, cookieFor,
  clearCookie, newState, currentUser, setPlan, decryptKey, getUser,
} from '../src/auth.js'
import { send, readBody } from '../src/http.js'
import { verifyKey } from '../src/llm.js'

const redirect = (res, to, cookie) => {
  res.statusCode = 302
  res.setHeader('location', to)
  if (cookie) res.setHeader('set-cookie', cookie)
  res.end()
}

// The one failure that sends a user back to a page they just completed: a
// key is in the row, and this says there is none. If that ever happens it
// must be in the log, with the id, rather than inferred from the symptom.
function meHasKey(user) {
  const has = Boolean(decryptKey(user.gemini_key))
  // Temporary, while a fresh account keeps being sent back to the key page it
  // just completed. Three fixes have been wrong because they were reasoned
  // about rather than observed; this prints the sequence instead.
  console.log('me', { id: user.id, plan: user.plan, stored: Boolean(user.gemini_key), hasKey: has })
  return has
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x')
  const action = url.pathname.replace('/api/auth', '').replace(/^\//, '') || 'me'

  if (!authConfigured() && action !== 'me') {
    return send(res, 501, { error: 'Google sign-in is not configured on this server' })
  }

  /* who am I - the page calls this on load to decide what to render */
  if (action === 'me') {
    if (!authConfigured()) return send(res, 200, { auth: false, single_user: true })
    // Always from the database. The cache exists to keep a round trip off the
    // hot path of every logged meal; this runs once per page load, and it is
    // the one answer that must never be a moment out of date. A cached copy
    // here says "no key" to someone who has just saved one, and sends them
    // back to the page they finished - which is exactly what was happening,
    // whether the stale copy came from this process or from the outgoing one
    // during a deploy.
    const user = await currentUser(req, true)
    if (!user) return send(res, 200, { auth: true, signedIn: false })
    return send(res, 200, {
      auth: true, signedIn: true,
      user: {
        email: user.email, name: user.name, picture: user.picture,
        plan: user.plan,
        // Never return the key itself, only whether one is set.
        hasKey: meHasKey(user),
      },
    })
  }

  /* start - bounce to Google, with a state cookie to tie the callback back */
  if (action === 'start') {
    const state = newState()
    res.setHeader('set-cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`)
    return redirect(res, authUrl(req, state))
  }

  /* callback - Google sends the user back here with a code */
  if (action === 'callback') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const expected = (req.headers.cookie ?? '').split(';').map((c) => c.trim())
      .find((c) => c.startsWith('oauth_state='))?.slice(12)
    // Without this check another site could complete a sign-in on your behalf.
    if (!code || !state || state !== expected) return redirect(res, '/?error=auth_state')

    try {
      const profile = await exchangeCode(req, code)
      const user = await upsertUser(profile)
      return redirect(res, '/', cookieFor(makeSession(user.id), req))
    } catch (err) {
      console.error('auth callback', err)
      return redirect(res, '/?error=auth_failed')
    }
  }

  if (action === 'logout') return redirect(res, '/', clearCookie(req))

  /* plan - choose BYOK (free) or hosted (owner's key), and store the key */
  if (action === 'plan') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
    const user = await currentUser(req)
    if (!user) return send(res, 401, { error: 'not signed in' })

    const { plan, gemini_key, skip_check } = await readBody(req)
    if (!['byok', 'hosted'].includes(plan)) return send(res, 400, { error: 'unknown plan' })

    if (plan === 'byok') {
      const key = String(gemini_key ?? '').trim()
      // Keep an existing key when the field is left blank on a re-save.
      if (!key && !decryptKey(user.gemini_key)) {
        return send(res, 400, { error: 'Paste your Gemini API key to use the free plan.' })
      }
      // Only a newly pasted key is checked. A blank field means "keep the one
      // you already have", which was verified when it was first saved.
      // skip_check is the user's own decision, offered only after the check
      // failed to reach a verdict. Google being unreachable must not be able
      // to lock somebody out of their own app.
      if (key && !skip_check) {
        const check = await verifyKey(key)
        if (!check.ok) return send(res, 400, { error: check.reason, retry: Boolean(check.retry) })
      }
      await setPlan(user.id, 'byok', key || decryptKey(user.gemini_key))
    } else {
      await setPlan(user.id, 'hosted', null)
    }

    // Read the user back the way /api/auth/me will, and say so in the reply.
    // A save that reports ok while the very next request says "no key" is the
    // one failure this flow cannot explain to anybody, so it is now visible
    // in both the response and the log.
    const after = await getUser(user.id)
    const hasKey = Boolean(decryptKey(after?.gemini_key))
    console.log('plan saved', { id: user.id, plan, stored: Boolean(after?.gemini_key), hasKey })
    return send(res, 200, { ok: true, plan, hasKey })
  }

  return send(res, 404, { error: 'unknown auth action' })
}
