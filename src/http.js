// Shared bits for the serverless handlers.
export const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

// Single-user app on a public URL: without this, anyone who finds the URL can
// spend your Gemini quota and read your food log. A passcode is proportionate.
export function authed(req) {
  const expected = process.env.APP_PASSCODE
  if (!expected) return true // not configured => local dev
  return req.headers['x-passcode'] === expected
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
