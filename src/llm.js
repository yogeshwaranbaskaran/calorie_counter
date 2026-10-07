// The provider seam. This is the ONLY file that knows we use Gemini.
// Swap this out for Groq/OpenRouter/Qwen later and nothing else changes.
//
// Neutral message shapes used everywhere else in the app:
//   { role: 'user',  text }
//   { role: 'model', text?, calls?: [{ name, args }] }
//   { role: 'tool',  name, result }

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

// Confirmed against Google's docs: v1beta accepts ONLY "user" and "model" as
// roles, and a functionResponse rides inside a "user" turn. There is no
// "function" role here, unlike OpenAI-shaped APIs.
const TOOL_ROLE = 'user'

function toGemini(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] }

    if (m.role === 'model') {
      // Gemini 3 signs its reasoning and REQUIRES those signatures back on the
      // next request, or tool calling 400s. Replaying the parts verbatim is the
      // only way to keep them intact, so we kept them on the turn as _raw.
      if (m._raw) return { role: 'model', parts: m._raw }

      const parts = []
      if (m.text) parts.push({ text: m.text })
      for (const c of m.calls ?? []) {
        parts.push({ functionCall: { name: c.name, args: c.args } })
      }
      return { role: 'model', parts }
    }

    // Tool results must be an object, so bare values get wrapped.
    const response =
      m.result !== null && typeof m.result === 'object' && !Array.isArray(m.result)
        ? m.result
        : { value: m.result }
    return { role: TOOL_ROLE, parts: [{ functionResponse: { name: m.name, response } }] }
  })
}

// A model having a bad day must not hang the app. Each attempt is capped, and
// a timeout or a 5xx falls through to the next model in the list.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 45_000)
const FALLBACKS = (process.env.GEMINI_FALLBACKS || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite')
  .split(',').map((m) => m.trim()).filter(Boolean)

export async function llm(opts) {
  const chain = [undefined, ...FALLBACKS] // undefined = the configured model
  let last
  for (let i = 0; i < chain.length; i++) {
    try {
      return await llmOnce({ ...opts, attemptModel: chain[i] })
    } catch (err) {
      last = err
      // Only a timeout or an upstream fault is worth trying elsewhere; a bad
      // key or a bad request will fail identically on every model.
      const retryable = err.code === 'timeout' || err.code === 'upstream' || err.code === 'rate_limit'
      if (!retryable || i === chain.length - 1) throw err
      console.warn(`llm: ${err.code} on ${chain[i] ?? 'primary'}, trying ${chain[i + 1]}`)
    }
  }
  throw last
}

async function llmOnce({ system, messages, tools, thinking, apiKey, attemptModel }) {
  // Measured 2026-09-23: flash-lite went erratic (14s, 47s, 62s for the same
  // call) while plain flash was a steady 6.4s. gemini-3.6-flash is out - it is
  // capped at twenty requests a DAY on the free tier.
  const model = attemptModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash'
  // A user on the free plan supplies their own key; the hosted plan falls back
  // to the owner's.
  const key = apiKey || process.env.GEMINI_API_KEY
  if (!key) {
    const e = new Error('no Gemini API key available')
    e.code = 'no_key'
    throw e
  }

  const body = {
    contents: toGemini(messages),
    systemInstruction: { parts: [{ text: system }] },
  }
  if (tools?.length) body.tools = [{ functionDeclarations: tools }]
  // thinkingLevel is OFF by default. It halved latency when it was added in
  // September; measured again 2026-09-23 it MULTIPLIED it - the same call took
  // 6.4s without and 37.8s with. Set GEMINI_THINKING=low to put it back, and
  // measure before trusting it.
  if (thinking && process.env.GEMINI_THINKING) {
    body.generationConfig = { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING } }
  }

  let res
  try {
    res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    const e = new Error(`${model} did not answer within ${TIMEOUT_MS / 1000}s`)
    e.code = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'upstream'
    throw e
  }

  if (!res.ok) {
    const detail = await res.text()
    // Typed so the UI can say something useful instead of dumping Google's
    // JSON at you. The free tier is only a few requests per minute, so 429 is
    // an everyday event, not an exception.
    const err = new Error(`LLM ${res.status} (${model}): ${detail.slice(0, 300)}`)
    err.code =
      res.status === 429 ? 'rate_limit'
      : res.status === 400 && /API key/i.test(detail) ? 'bad_key'
      : res.status === 400 ? 'bad_request'
      : 'upstream'
    throw err
  }

  const data = await res.json()
  const parts = data.candidates?.[0]?.content?.parts ?? []

  // One model turn can hold several tool calls at once - it might look up
  // three foods in parallel rather than one at a time.
  // _raw is provider-opaque: only this file reads it, so the seam holds.
  return {
    text: parts.filter((p) => p.text).map((p) => p.text).join('').trim(),
    calls: parts
      .filter((p) => p.functionCall)
      .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} })),
    _raw: parts,
  }
}

// Does this key actually work? Asked before a key is saved, so nobody gets
// through onboarding with a typo and discovers it at their first meal.
//
// Deliberately its own small request rather than llm(): no fallback chain, no
// retries, and a short timeout, because a person is watching a button spin.
export async function verifyKey(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (!key) return { ok: false, reason: 'Paste a key first.' }
  // Google answers 503 often enough that one blip would otherwise tell someone
  // their perfectly good key is broken. A verdict ABOUT the key is final; a
  // failure to reach an opinion is worth one more go.
  const first = await probeKey(key)
  if (!first.retry) return first
  return probeKey(key)
}

async function probeKey(key) {

  const model = (process.env.GEMINI_FALLBACKS || 'gemini-3.1-flash-lite').split(',')[0].trim()
  let res
  try {
    res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // One token. We only need Google to answer 200, and letting the model
      // write a real sentence turned this check into a five second wait.
      // thinkingLevel has no 'off' value - passing one 400s, which read as a
      // bad key and locked a perfectly good one out.
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(Number(process.env.VERIFY_TIMEOUT_MS || 12_000)),
    })
  } catch {
    return { ok: false, retry: true, reason: 'Could not reach Google just now. Try again.' }
  }

  // A throttled key is a working key. Google only rate limits once it has
  // accepted who you are, so this must not read as "invalid".
  if (res.status === 429) return { ok: true, throttled: true }
  if (res.ok) return { ok: true }

  const detail = (await res.text()).slice(0, 400)
  if (res.status === 400 && /API.?key.?not.?valid|API_KEY_INVALID/i.test(detail)) {
    return { ok: false, reason: 'Google does not recognise that key. Check you copied all of it.' }
  }
  if (res.status === 403 || /SERVICE_DISABLED|PERMISSION_DENIED/i.test(detail)) {
    return { ok: false, reason: 'That key exists but is not allowed to use Gemini. Create a new one in AI Studio.' }
  }
  if (res.status >= 500) return { ok: false, retry: true, reason: 'Google is having trouble. Try again in a moment.' }
  // Anything else is more likely our request than their key, so do not accuse
  // the user of mistyping something they may have pasted correctly.
  console.error('verifyKey unexpected', res.status, detail)
  return { ok: false, retry: true, reason: 'Could not check the key just now. Try again.' }
}
