// Shared bits for the serverless handlers.
export const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

// Two modes. With Google sign-in configured, every request must carry a valid
// session and each user sees only their own rows. Without it the app is
// single-user: the shared passcode guards it and rows have user_id NULL.
import { authConfigured, currentUser } from './auth.js'

// Either the passcode the page sends, or the owner's API_TOKEN as a bearer -
// the same token that identifies the owner in multi-user mode, so a script
// like the Suno worker works against both modes with one header.
export function authed(req) {
  const expected = process.env.APP_PASSCODE
  if (!expected) return true // not configured => local dev
  if (req.headers['x-passcode'] === expected) return true
  const token = process.env.API_TOKEN
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  return Boolean(token && bearer === token)
}

// Returns { ok, userId, user } - userId is null in single-user mode, which is
// exactly what the store's `is not distinct from` comparison expects.
export async function requireUser(req, res) {
  if (!authConfigured()) {
    if (!authed(req)) { send(res, 401, { error: 'bad passcode' }); return null }
    return { userId: null, user: null }
  }
  const user = await currentUser(req)
  if (!user) { send(res, 401, { error: 'not signed in', signin: '/api/auth/start' }); return null }
  return { userId: user.id, user }
}

export async function readBody(req) {
  if (req.body) return req.body // already parsed by a framework, if any
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}
