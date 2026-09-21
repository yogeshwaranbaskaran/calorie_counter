// Google sign-in, sessions and per-user key storage - all on node:crypto, no
// dependencies. The OAuth code flow is short enough to write out plainly, and
// a library here would be more moving parts than the flow itself.
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { sql, usingPostgres } from './store.js'

const SECRET = process.env.SESSION_SECRET || ''
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const OWNER = (process.env.OWNER_EMAIL || '').toLowerCase()
// A personal access token for the owner's own scripts (the local Suno agent).
// Sent as `Authorization: Bearer <token>`; resolves to the OWNER_EMAIL user.
const API_TOKEN = process.env.API_TOKEN || ''
const SESSION_DAYS = 30

export const authConfigured = () => Boolean(SECRET && CLIENT_ID && CLIENT_SECRET && usingPostgres())

/* --------------------------------------------------------------- redirect */

// Derived from the request so localhost and production both work without a
// second env var to keep in sync.
export function originOf(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  const proto = req.headers['x-forwarded-proto'] ?? 'http'
  return `${proto}://${req.headers.host}`
}
const redirectUri = (req) => `${originOf(req)}/api/auth/callback`

export function authUrl(req, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
}

// The id_token comes straight from Google's token endpoint over TLS, so its
// signature does not need re-verifying - Google's own guidance. Decoding the
// payload is enough.
export async function exchangeCode(req, code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req), grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`google token ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const { id_token } = await res.json()
  const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString('utf8'))
  if (!payload.email_verified) throw new Error('google account has no verified email')
  return { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture }
}

/* --------------------------------------------------------------- sessions */

const sign = (v) => createHmac('sha256', SECRET).update(v).digest('base64url')

export function makeSession(userId) {
  const body = `${userId}.${Date.now() + SESSION_DAYS * 864e5}`
  return `${body}.${sign(body)}`
}

export function readSession(cookieHeader) {
  const raw = (cookieHeader ?? '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith('sid='))?.slice(4)
  if (!raw) return null
  const i = raw.lastIndexOf('.')
  if (i < 0) return null
  const body = raw.slice(0, i), mac = raw.slice(i + 1)
  const expected = sign(body)
  // Constant-time compare so a forged cookie cannot be tuned byte by byte.
  if (mac.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  const [id, exp] = body.split('.')
  if (Number(exp) < Date.now()) return null
  return Number(id)
}

export const cookieFor = (value, req, maxAge = SESSION_DAYS * 86400) => {
  const secure = originOf(req).startsWith('https') ? '; Secure' : ''
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}
export const clearCookie = (req) => cookieFor('', req, 0)

export const newState = () => randomBytes(16).toString('base64url')

/* ------------------------------------------------------ per-user API keys */

// Users' Gemini keys are credentials, so they are encrypted at rest rather
// than sat in a column in the clear, and never sent back to the browser.
const keyMaterial = () => scryptSync(SECRET, 'gemini-key-v1', 32)

export function encryptKey(plain) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyMaterial(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.')
}

export function decryptKey(stored) {
  if (!stored) return null
  try {
    const [iv, tag, data] = stored.split('.')
    const d = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
  } catch {
    return null // wrong SESSION_SECRET, or tampered
  }
}

/* ------------------------------------------------------------------ users */

export async function upsertUser({ sub, email, name, picture }) {
  const rows = await sql(
    `insert into users (google_sub, email, name, picture, last_seen_at)
     values ($1,$2,$3,$4, now())
     on conflict (google_sub) do update set
       email = excluded.email, name = excluded.name,
       picture = excluded.picture, last_seen_at = now()
     returning *`,
    [sub, email, name ?? null, picture ?? null]
  )
  const user = rows[0]
  forgetUser(user.id)
  if (OWNER && email.toLowerCase() === OWNER) await adoptOrphans(user.id)
  return user
}

// The data logged before accounts existed has user_id NULL. The owner claims
// it on first sign-in, so the original 158 entries are not stranded.
async function adoptOrphans(userId) {
  // Single-user mode could leave the same food name twice (see putFood). The
  // unique index on (user_id, name) would refuse to adopt both, so keep the
  // most recently confirmed copy of each and drop the rest first.
  await sql(`delete from foods f using foods g
             where f.user_id is null and g.user_id is null and f.name = g.name
               and (f.confirmed_at < g.confirmed_at or (f.confirmed_at = g.confirmed_at and f.id < g.id))`)
  await sql('update foods set user_id = $1 where user_id is null', [userId])
  await sql('update log_entries set user_id = $1 where user_id is null', [userId])
}

// Every request resolved the user with a database round trip - to a server
// on another continent, that alone was ~200ms. A one-minute cache removes it
// from the hot path; anything that changes the row invalidates it.
const userCache = new Map()
const USER_TTL = 60_000

export async function getUser(id) {
  const hit = userCache.get(id)
  if (hit && hit.at > Date.now() - USER_TTL) return hit.user
  const rows = await sql('select * from users where id = $1', [id])
  const user = rows[0] ?? null
  if (user) userCache.set(id, { user, at: Date.now() })
  return user
}
export const forgetUser = (id) => userCache.delete(id)

export async function setPlan(id, plan, geminiKey) {
  await sql('update users set plan = $1, gemini_key = $2 where id = $3',
    [plan, geminiKey ? encryptKey(geminiKey) : null, id])
  forgetUser(id)
}

// Which Gemini key a user's requests should use.
//   byok   - their own key, free. No key stored => they cannot log yet.
//   hosted - the owner's key, which is what a subscription pays for. Soft for
//            now: it works and tells them payment is coming, rather than
//            blocking someone mid-meal over a feature that does not exist yet.
export function keyForUser(user) {
  if (!user) return { key: process.env.GEMINI_API_KEY, plan: 'single' }
  if (user.plan === 'byok') {
    const key = decryptKey(user.gemini_key)
    return { key, plan: 'byok', missingKey: !key }
  }
  return { key: process.env.GEMINI_API_KEY, plan: 'hosted', unpaid: true }
}

// Resolves the signed-in user for a request, or null.
export async function currentUser(req) {
  if (!authConfigured()) return null
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (bearer && API_TOKEN && OWNER && safeEqual(bearer, API_TOKEN)) {
    const rows = await sql('select * from users where lower(email) = $1', [OWNER])
    return rows[0] ?? null
  }
  const id = readSession(req.headers.cookie)
  return id ? getUser(id) : null
}

const safeEqual = (a, b) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
