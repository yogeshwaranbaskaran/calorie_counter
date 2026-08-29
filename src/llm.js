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

export async function llm({ system, messages, tools }) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash'
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set - copy .env.example to .env')

  const body = {
    contents: toGemini(messages),
    systemInstruction: { parts: [{ text: system }] },
  }
  if (tools?.length) body.tools = [{ functionDeclarations: tools }]

  const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`)
  }

  const data = await res.json()
  const parts = data.candidates?.[0]?.content?.parts ?? []

  // One model turn can hold several tool calls at once - it might look up
  // three foods in parallel rather than one at a time.
  return {
    text: parts.filter((p) => p.text).map((p) => p.text).join('').trim(),
    calls: parts
      .filter((p) => p.functionCall)
      .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} })),
  }
}
