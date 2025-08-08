import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { Server as HocuspocusServer } from '@hocuspocus/server'
import { Logger } from '@hocuspocus/extension-logger'
import * as Y from 'yjs'
import { migrate, query } from './db.js'
import { publish, subscribe } from './sse.js'

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000)
const WS_PORT = Number(process.env.WS_PORT || 3001)
const HOST = process.env.HOST || '0.0.0.0'
const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

if (!ADMIN_SECRET) {
  console.error('Missing ADMIN_SECRET in environment')
  process.exit(1)
}

await migrate()

// Hocuspocus realtime server
const hocuspocus = new HocuspocusServer({
  address: HOST,
  port: WS_PORT,
  extensions: [new Logger()],
  async onLoadDocument(data) {
    const { documentName } = data
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    const { rows } = await query<{ current_text: string }>(
      'SELECT current_text FROM documents WHERE id = $1',
      [documentName],
    )
    const initial = rows[0]?.current_text || ''
    if (!rows[0]) {
      await query('INSERT INTO documents(id, current_text) VALUES($1, $2) ON CONFLICT (id) DO NOTHING', [documentName, ''])
    }
    if (initial) ytext.insert(0, initial)
    return ydoc
  },
  async onChange(data) {
    const { document, documentName } = data
    const ytext = (document as Y.Doc).getText('content')
    const text = ytext.toString()
    await query('UPDATE documents SET current_text = $2, updated_at = NOW() WHERE id = $1', [documentName, text])
    // Snapshot at most once every 30s
    await query(`
      INSERT INTO versions(document_id, text)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM versions WHERE document_id = $1 AND created_at > NOW() - INTERVAL '30 seconds'
      )
    `, [documentName, text])
  },
})

hocuspocus.listen()

// HTTP server
const app = express()
app.set('trust proxy', true)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(morgan('tiny'))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

function adminGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = req.cookies['admin'] || req.header('x-admin-secret') || req.query.secret
  if (secret === ADMIN_SECRET) return next()
  res.status(401).send(renderLogin())
}

// Admin pages
app.get('/admin', adminGuard, async (req, res) => {
  const { rows } = await query<{ id: string; updated_at: string }>('SELECT id, updated_at FROM documents ORDER BY updated_at DESC LIMIT 200')
  res.type('html').send(renderAdmin(rows))
})

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const secret = req.body.secret as string
  if (secret === ADMIN_SECRET) {
    res.cookie('admin', secret, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' })
    res.redirect('/admin')
  } else {
    res.status(401).send(renderLogin('Invalid secret'))
  }
})

app.post('/admin/logout', (req, res) => {
  res.clearCookie('admin')
  res.redirect('/admin')
})

app.post('/admin/docs', adminGuard, async (req, res) => {
  const { customAlphabet } = await import('nanoid')
  const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 20)
  const id = nanoid()
  await query('INSERT INTO documents(id, current_text) VALUES($1, $2)', [id, ''])
  res.redirect(`/d/${id}`)
})

app.get('/admin/docs/:id/versions', adminGuard, async (req, res) => {
  const docId = req.params.id
  const { rows } = await query<{ id: string; created_at: string }>('SELECT id, created_at FROM versions WHERE document_id = $1 ORDER BY created_at DESC', [docId])
  res.type('html').send(renderVersions(docId, rows))
})

app.post('/admin/docs/:id/restore/:versionId', adminGuard, async (req, res) => {
  const { id, versionId } = req.params
  const { rows } = await query<{ text: string }>('SELECT text FROM versions WHERE id = $1 AND document_id = $2', [versionId, id])
  if (!rows[0]) return res.status(404).send('Not found')
  const text = rows[0].text
  await query('UPDATE documents SET current_text = $2, updated_at = NOW() WHERE id = $1', [id, text])
  await query('INSERT INTO versions(document_id, text) VALUES ($1, $2)', [id, text])
  publish(id, 'restore', { text })
  res.redirect(`/d/${id}`)
})

// API
app.get('/api/documents/:id', async (req, res) => {
  const { rows } = await query<{ id: string; current_text: string; updated_at: string }>('SELECT id, current_text, updated_at FROM documents WHERE id = $1', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json({ id: rows[0].id, text: rows[0].current_text, updatedAt: rows[0].updated_at })
})

app.get('/api/documents/:id/events', (req, res) => {
  subscribe(req.params.id, res)
})

app.get('/api/config', (req, res) => {
  const wsDomain = process.env.WS_DOMAIN
  const wsPort = process.env.WS_PORT || '3001'
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol
  const wsProto = proto === 'https' ? 'wss' : 'ws'
  const wsUrl = wsDomain ? `${wsProto}://${wsDomain}` : `${wsProto}://${req.hostname}:${wsPort}`
  res.json({ wsUrl })
})

// Static client
const clientDist = path.resolve(process.cwd(), 'client', 'dist')
app.use(express.static(clientDist, { index: false }))

app.get('/d/:id', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

app.get('/', (req, res) => res.redirect('/admin'))

app.listen(HTTP_PORT, HOST, () => {
  console.log(`HTTP listening on http://${HOST}:${HTTP_PORT}`)
  console.log(`WS listening on ws://${HOST}:${WS_PORT}`)
})

function renderLogin(error?: string) {
  return `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Admin Login</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;display:grid;place-items:center;height:100dvh;background:#0f172a;color:#e2e8f0}
    form{display:flex;gap:.5rem}
    input{padding:.6rem .8rem;border-radius:.5rem;border:1px solid #334155;background:#0b1222;color:#e2e8f0}
    button{padding:.6rem .9rem;border-radius:.5rem;border:1px solid #334155;background:#1e293b;color:#e2e8f0;cursor:pointer}
    .card{background:#0b1222;border:1px solid #1f2a44;padding:2rem;border-radius:1rem;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .err{color:#fca5a5;margin-bottom:.5rem}
  </style></head>
  <body><div class="card">
  ${error ? `<div class="err">${error}</div>` : ''}
  <form method="post" action="/admin/login"><input type="password" name="secret" placeholder="Admin secret" autofocus><button type="submit">Enter</button></form>
  </div></body></html>`
}

function renderAdmin(docs: { id: string; updated_at: string }[]) {
  const rows = docs.map(d => `<tr><td><a href="/d/${d.id}">${d.id}</a></td><td>${new Date(d.updated_at).toLocaleString()}</td><td><a href="/admin/docs/${d.id}/versions">versions</a></td></tr>`).join('')
  return `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Documents</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
    .bar{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid #1f2a44;background:#0b1222;position:sticky;top:0}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:.75rem;border-bottom:1px solid #1f2a44}
    a{color:#93c5fd;text-decoration:none}
    .wrap{max-width:960px;margin:0 auto}
    .btn{padding:.5rem .8rem;border:1px solid #334155;border-radius:.5rem;background:#1e293b;color:#e2e8f0;cursor:pointer}
  </style></head>
  <body>
    <div class="bar"><div class="wrap"><strong>Documents</strong></div><div class="wrap" style="text-align:right">
      <form method="post" action="/admin/docs" style="display:inline"><button class="btn" type="submit">New document</button></form>
      <form method="post" action="/admin/logout" style="display:inline;margin-left:.5rem"><button class="btn" type="submit">Logout</button></form>
    </div></div>
    <div class="wrap">
      <table><thead><tr><th>ID</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
  </body></html>`
}

function renderVersions(docId: string, versions: { id: string; created_at: string }[]) {
  const rows = versions.map(v => `<tr><td>${new Date(v.created_at).toLocaleString()}</td><td><form method="post" action="/admin/docs/${docId}/restore/${v.id}"><button type="submit">Restore</button></form></td></tr>`).join('')
  return `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Versions</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
    a{color:#93c5fd;text-decoration:none}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:.75rem;border-bottom:1px solid #1f2a44}
    .wrap{max-width:720px;margin:2rem auto}
    button{padding:.4rem .7rem;border:1px solid #334155;border-radius:.5rem;background:#1e293b;color:#e2e8f0;cursor:pointer}
  </style></head>
  <body>
    <div class="wrap"><p><a href="/admin">← Back</a> · Document <a href="/d/${docId}">${docId}</a></p>
    <table><thead><tr><th>Created</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>
  </body></html>`
}


