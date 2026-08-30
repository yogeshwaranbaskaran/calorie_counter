// Local stand-in for Vercel: serves public/ and routes /api/* to the same
// handler files that run in production. No dependencies.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import chat from './api/chat.js'
import commit from './api/commit.js'
import day from './api/day.js'
import entry from './api/entry.js'
import { backend } from './src/store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public')
const routes = { '/api/chat': chat, '/api/commit': commit, '/api/day': day, '/api/entry': entry }
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const route = routes[path]
  if (route) return route(req, res)

  try {
    const file = path === '/' ? 'index.html' : path.slice(1)
    const body = await readFile(join(ROOT, file))
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(3000, () => console.log(`http://localhost:3000  (store: ${backend()})`))
