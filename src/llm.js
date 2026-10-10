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
  // A turn that would carry no parts at all is not a turn Gemini will accept.
  return messages.filter((m) => m.role !== 'model' || m._raw?.length || m.text || m.calls?.length).map((m) => {
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
// 45s per attempt, three attempts, was 135s of patience for a sentence that
// normally answers in under seven. One meal took 108s on a day when Gemini
// was answering 503 "high demand": the primary burned its full timeout, then
// the first fallback did too. A cap per attempt is not enough on its own,
// because the caps add up, so the whole chain gets one budget to spend.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20_000)
const BUDGET_MS = Number(process.env.LLM_BUDGET_MS || 45_000)
const FALLBACKS = (process.env.GEMINI_FALLBACKS || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite')
  .split(',').map((m) => m.trim()).filter(Boolean)

export async function llm(opts) {
  const chain = [undefined, ...FALLBACKS] // undefined = the configured model
  const deadline = Date.now() + BUDGET_MS
  let last
  for (let i = 0; i < chain.length; i++) {
    // Never start an attempt there is no time left to finish. Three seconds
    // is the least that could plausibly succeed.
    const left = deadline - Date.now()
    if (left < 3000 && last) throw last
    try {
      return await llmOnce({ ...opts, attemptModel: chain[i], timeoutMs: Math.min(TIMEOUT_MS, left) })
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

async function llmOnce({ system, messages, tools, thinking, apiKey, attemptModel, timeoutMs = TIMEOUT_MS }) {
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
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const e = new Error(`${model} did not answer within ${Math.round(timeoutMs / 1000)}s`)
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

  // Ask Google to LIST models rather than run one. Listing authenticates the
  // key and proves the API is enabled, which is the whole question, and it
  // cannot fail for reasons that have nothing to do with the key.
  //
  // Generating was tried first and was the wrong call: gemini-3.5-flash
  // answered 503 "this model is currently experiencing high demand" over and
  // over, so a perfectly good key was reported as broken because Google was
  // busy. Probing the model the app uses sounds more thorough and is in fact
  // less reliable, because that model is the most loaded one.
  let res
  try {
    res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}&pageSize=1`, {
      signal: AbortSignal.timeout(Number(process.env.VERIFY_TIMEOUT_MS || 12_000)),
    })
  } catch (err) {
    console.error('verifyKey unreachable', err?.name ?? err)
    return { ok: false, retry: true, reason: 'Could not reach Google just now.' }
  }

  if (res.ok) return { ok: true }
  if (res.status === 429) return { ok: true, throttled: true } // throttled means authenticated

  const detail = (await res.text()).slice(0, 400)
  console.error('verifyKey', res.status, detail.replace(/\s+/g, ' ').slice(0, 220))

  if (/API.?key.?not.?valid|API_KEY_INVALID/i.test(detail)) {
    return { ok: false, reason: 'Google does not recognise that key. Check you copied all of it.' }
  }
  if (res.status === 403 || /SERVICE_DISABLED|PERMISSION_DENIED/i.test(detail)) {
    return { ok: false, reason: 'That key exists but is not allowed to use Gemini. Create a new one in AI Studio.' }
  }
  // Anything else is Google, not the key, so never say the key is wrong.
  return { ok: false, retry: true, reason: `Google could not answer just now (${res.status}).` }
}
