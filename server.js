// Production server (Render). Serves public/ and the same API handlers the
// local dev server uses - there is no second implementation to drift.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, dirname, normalize as npath } from 'node:path'
import { fileURLToPath } from 'node:url'
import chat from './api/chat.js'
import commit from './api/commit.js'
import day from './api/day.js'
import entry from './api/entry.js'
import range from './api/range.js'
import insights from './api/insights.js'
import health from './api/health.js'
import auth from './api/auth.js'
import weight from './api/weight.js'
import targets from './api/targets.js'
import body from './api/body.js'
import foods from './api/foods.js'
import { backend } from './src/store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public')
const PORT = process.env.PORT || 3000
const routes = {
  '/api/chat': chat, '/api/commit': commit, '/api/day': day,
  '/api/entry': entry, '/api/range': range, '/api/insights': insights,
  '/api/health': health, '/api/weight': weight, '/api/targets': targets, '/api/body': body,
  '/api/foods': foods,
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  // /api/auth/* is one handler with sub-actions in the path.
  const route = path.startsWith('/api/auth') ? auth : routes[path]
  if (route) {
    try {
      return await route(req, res)
    } catch (err) {
      console.error(path, err)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: 'server error' }))
    }
  }

  try {
    const rel = path === '/' ? 'index.html' : path.slice(1)
    // Keep the resolved path inside public/ - never serve .env or source.
    const file = join(ROOT, npath(rel))
    if (!file.startsWith(ROOT)) throw new Error('outside root')
    const body = await readFile(file)
    const type = MIME[extname(file)] ?? 'application/octet-stream'
    res.setHeader('content-type', type)
    // The whole app is one HTML file, so a cached copy is a cached BUILD. The
    // service worker already refuses to cache it; the browser needs telling
    // too. Icons and the manifest may be cached, they never change meaningfully.
    res.setHeader('cache-control', type.startsWith('text/html') ? 'no-store' : 'public, max-age=86400')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(PORT, () => console.log(`listening on ${PORT} (store: ${backend()})`))
