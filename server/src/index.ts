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
    const { rows } = await query<{ current_text: string; ystate: Buffer | null }>(
      'SELECT current_text, ystate FROM documents WHERE id = $1',
      [documentName],
    )
    const row = rows[0]
    if (!row) {
      await query('INSERT INTO documents(id, current_text, ystate) VALUES($1, $2, $3) ON CONFLICT (id) DO NOTHING', [documentName, '', null])
    } else if (row.ystate && row.ystate.length > 0) {
      Y.applyUpdate(ydoc, new Uint8Array(row.ystate))
    } else if (row.current_text) {
      // Backfill from current_text if no ystate yet
      ydoc.getText('content').insert(0, row.current_text)
    }
    return ydoc
  },
  async onChange(data) {
    const { document, documentName } = data
    const doc = document as Y.Doc
    const ytext = doc.getText('content')
    const text = ytext.toString()
    const update = Y.encodeStateAsUpdate(doc)
    await query('UPDATE documents SET current_text = $2, ystate = $3, updated_at = NOW() WHERE id = $1', [documentName, text, Buffer.from(update)])
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
  const { rows } = await query<{ id: string; updated_at: string; title: string }>('SELECT id, updated_at, title FROM documents ORDER BY updated_at DESC LIMIT 200')
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
  await query('INSERT INTO documents(id, current_text, title) VALUES($1, $2, $3)', [id, '', 'Untitled'])
  res.redirect(`/d/${id}`)
})

app.get('/admin/docs/:id/versions', adminGuard, async (req, res) => {
  const docId = req.params.id
  const { rows } = await query<{ id: string; created_at: string }>('SELECT id, created_at FROM versions WHERE document_id = $1 ORDER BY created_at DESC', [docId])
  const titleRow = await query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [docId])
  res.type('html').send(renderVersions(docId, titleRow.rows[0]?.title || '', rows))
})
app.get('/admin/docs/:id/versions/:versionId', adminGuard, async (req, res) => {
  const { id, versionId } = req.params
  const vr = await query<{ id: string; text: string; created_at: string }>(
    'SELECT id, text, created_at FROM versions WHERE id = $1 AND document_id = $2',
    [versionId, id],
  )
  if (!vr.rows[0]) return res.status(404).send('Not found')
  const tr = await query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [id])
  const title = tr.rows[0]?.title || ''
  res.type('html').send(
    renderVersionPreview(
      id,
      title,
      vr.rows[0].id,
      vr.rows[0].created_at,
      vr.rows[0].text || '',
    ),
  )
})
app.post('/admin/docs/:id/title', adminGuard, express.urlencoded({ extended: false }), async (req, res) => {
  const id = req.params.id
  const title = (req.body.title ?? '').toString().trim()
  await query('UPDATE documents SET title = $2, updated_at = NOW() WHERE id = $1', [id, title])
  publish(id, 'title', { title })
  res.redirect('/admin')
})

app.post('/admin/docs/:id/restore/:versionId', adminGuard, async (req, res) => {
  const { id, versionId } = req.params
  const { rows } = await query<{ text: string }>('SELECT text FROM versions WHERE id = $1 AND document_id = $2', [versionId, id])
  if (!rows[0]) return res.status(404).send('Not found')
  const text = rows[0].text
  await query('UPDATE documents SET current_text = $2, ystate = NULL, updated_at = NOW() WHERE id = $1', [id, text])
  await query('INSERT INTO versions(document_id, text) VALUES ($1, $2)', [id, text])
  publish(id, 'restore', { text })
  res.redirect(`/d/${id}`)
})

// API
app.get('/api/documents/:id', async (req, res) => {
  const { rows } = await query<{ id: string; current_text: string; updated_at: string; title: string }>('SELECT id, current_text, updated_at, title FROM documents WHERE id = $1', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const text = rows[0].current_text || ''
  const title = rows[0].title || ''
  res.json({ id: rows[0].id, text, updatedAt: rows[0].updated_at, title })
})

app.patch('/api/documents/:id/title', async (req, res) => {
  const title = (req.body?.title ?? '').toString().trim()
  if (title.length > 512) return res.status(400).json({ error: 'Title too long' })
  const { rows } = await query<{ id: string }>('SELECT id FROM documents WHERE id = $1', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  await query('UPDATE documents SET title = $2, updated_at = NOW() WHERE id = $1', [req.params.id, title])
  publish(req.params.id, 'title', { title })
  res.json({ ok: true })
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
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)" />
  <style>
    :root{color-scheme: light dark}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;display:grid;place-items:center;height:100dvh;background:#ffffff;color:#0f172a}
    form{display:flex;gap:.5rem}
    input{padding:.6rem .8rem;border-radius:.5rem;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a}
    button{padding:.6rem .9rem;border-radius:.5rem;border:1px solid #0f172a;background:#0f172a;color:#ffffff;cursor:pointer}
    .card{background:#ffffff;border:1px solid #e5e7eb;padding:2rem;border-radius:1rem;box-shadow:0 10px 30px rgba(0,0,0,.08)}
    .err{color:#dc2626;margin-bottom:.5rem}
    @media (prefers-color-scheme: dark){
      body{background:#0f172a;color:#e2e8f0}
      input{border-color:#334155;background:#0b1222;color:#e2e8f0}
      button{border-color:#334155;background:#1e293b;color:#e2e8f0}
      .card{background:#0b1222;border-color:#1f2a44;box-shadow:0 20px 60px rgba(0,0,0,.5)}
      .err{color:#fca5a5}
    }
  </style></head>
  <body><div class="card">
  ${error ? `<div class="err">${error}</div>` : ''}
  <form method="post" action="/admin/login"><input type="password" name="secret" placeholder="Admin secret" autofocus><button type="submit">Enter</button></form>
  </div></body></html>`
}

function renderAdmin(docs: { id: string; updated_at: string; title: string }[]) {
  const rows = docs.map(d => {
    const safeTitle = (d.title || 'Untitled')
    const rowId = `t_${d.id}`
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          <span id="disp_${rowId}" style="font-weight:600">${escapeHtmlAttr(safeTitle)}</span>
          <button class="btn" type="button" onclick="toggleTitleEdit('${rowId}', true)">Edit</button>
          <form id="form_${rowId}" method="post" action="/admin/docs/${d.id}/title" style="display:none;gap:.25rem;align-items:center">
            <input id="input_${rowId}" class="text-input" type="text" name="title" value="${escapeHtmlAttr(d.title)}" placeholder="Untitled" />
            <button class="btn" type="submit">Save</button>
            <button class="btn" type="button" onclick="toggleTitleEdit('${rowId}', false)">Cancel</button>
          </form>
        </div>
        <div style="opacity:.7;font-size:.8rem">${d.id}</div>
      </td>
      <td>${new Date(d.updated_at).toLocaleString()}</td>
      <td>
        <a href="/d/${d.id}" class="btn" style="text-decoration:none">Open</a>
        <a href="/admin/docs/${d.id}/versions" class="btn" style="margin-left:.5rem;text-decoration:none">Versions</a>
      </td>
    </tr>`
  }).join('')
  return `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Documents</title>
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)" />
  <style>
    :root{color-scheme: light dark}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;background:#ffffff;color:#0f172a}
    .bar{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid #e5e7eb;background:#f8fafc;position:sticky;top:0}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:.75rem;border-bottom:1px solid #e5e7eb}
    a{color:#2563eb;text-decoration:none}
    .wrap{max-width:960px;margin:0 auto}
    .btn{padding:.5rem .8rem;border:1px solid #0f172a;border-radius:.5rem;background:#0f172a;color:#ffffff;cursor:pointer}
    .text-input{padding:.25rem .5rem;border-radius:.375rem;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a}
    @media (prefers-color-scheme: dark){
      body{background:#0f172a;color:#e2e8f0}
      .bar{border-bottom-color:#1f2a44;background:#0b1222}
      th,td{border-bottom-color:#1f2a44}
      a{color:#93c5fd}
      .btn{border-color:#334155;background:#1e293b;color:#e2e8f0}
      .text-input{border-color:#334155;background:#0b1222;color:#e2e8f0}
    }
  </style></head>
  <body>
    <div class="bar"><div class="wrap"><strong>Documents</strong></div><div class="wrap" style="text-align:right">
      <form method="post" action="/admin/docs" style="display:inline"><button class="btn" type="submit">New document</button></form>
      <form method="post" action="/admin/logout" style="display:inline;margin-left:.5rem"><button class="btn" type="submit">Logout</button></form>
    </div></div>
    <div class="wrap">
      <table><thead><tr><th>Title</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <script>
      function toggleTitleEdit(id, show){
        var disp = document.getElementById('disp_'+id);
        var form = document.getElementById('form_'+id);
        var input = document.getElementById('input_'+id);
        if(!disp || !form) return;
        var shouldShow = !!show;
        form.style.display = shouldShow ? 'inline-flex' : 'none';
        disp.style.display = shouldShow ? 'none' : 'inline';
        if(shouldShow && input) setTimeout(function(){ input.focus(); input.select && input.select(); }, 0);
      }
    </script>
  </body></html>`
}

function renderVersions(docId: string, docTitle: string, versions: { id: string; created_at: string }[]) {
  const rows = versions.map(v => `
    <tr>
      <td>${new Date(v.created_at).toLocaleString()}</td>
      <td>
        <a href="/admin/docs/${docId}/versions/${v.id}" class="btn" style="text-decoration:none">Preview</a>
        <form method="post" action="/admin/docs/${docId}/restore/${v.id}" style="display:inline;margin-left:.5rem">
          <button class="btn" type="submit">Restore</button>
        </form>
      </td>
    </tr>
  `).join('')
  return `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Versions</title>
  <style>
    :root{color-scheme: light dark}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;background:#ffffff;color:#0f172a}
    a{color:#2563eb;text-decoration:none}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:.75rem;border-bottom:1px solid #e5e7eb}
    .wrap{max-width:720px;margin:2rem auto}
    .btn{padding:.4rem .7rem;border:1px solid #0f172a;border-radius:.5rem;background:#0f172a;color:#ffffff;cursor:pointer}
    @media (prefers-color-scheme: dark){
      body{background:#0f172a;color:#e2e8f0}
      a{color:#93c5fd}
      th,td{border-bottom-color:#1f2a44}
      .btn{border-color:#334155;background:#1e293b;color:#e2e8f0}
    }
  </style></head>
  <body>
    <div class="wrap"><p><a href="/admin">← Back</a> · Document <a href="/d/${docId}">${docTitle || 'Untitled'}</a> <span style="opacity:.7">(${docId})</span></p>
    <table><thead><tr><th>Created</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>
  </body></html>`
}

function renderVersionPreview(
  docId: string,
  docTitle: string,
  versionId: string,
  createdAt: string,
  text: string,
) {
  const escaped = escapeHtmlAttr(text)
  return `<!DOCTYPE html>
  <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Preview Version</title>
  <style>
    :root{color-scheme: light dark}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;background:#ffffff;color:#0f172a}
    .wrap{max-width:960px;margin:1.5rem auto;padding:0 1rem}
    .bar{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid #e5e7eb;background:#f8fafc;position:sticky;top:0}
    .btn{padding:.45rem .75rem;border:1px solid #0f172a;border-radius:.5rem;background:#0f172a;color:#ffffff;cursor:pointer}
    pre{white-space:pre-wrap;word-wrap:break-word;border:1px solid #e5e7eb;background:#f8fafc;border-radius:.5rem;padding:1rem;overflow:auto}
    .meta{opacity:.7}
    @media (prefers-color-scheme: dark){
      body{background:#0f172a;color:#e2e8f0}
      .bar{border-bottom-color:#1f2a44;background:#0b1222}
      pre{border-color:#1f2a44;background:#0b1222}
      .btn{border-color:#334155;background:#1e293b;color:#e2e8f0}
    }
  </style></head>
  <body>
    <div class="bar">
      <div class="wrap">
        <a href="/admin" style="text-decoration:none">← Back</a>
      </div>
      <div class="wrap" style="text-align:right">
        <a href="/admin/docs/${docId}/versions" class="btn" style="text-decoration:none">All versions</a>
        <a href="/d/${docId}" class="btn" style="text-decoration:none;margin-left:.5rem">Open document</a>
      </div>
    </div>
    <div class="wrap">
      <h2 style="margin:.5rem 0 0">${escapeHtmlAttr(docTitle || 'Untitled')}</h2>
      <div class="meta">Document ID: ${docId} · Version: ${versionId} · Created: ${new Date(createdAt).toLocaleString()}</div>
      <div style="margin:1rem 0">
        <form method="post" action="/admin/docs/${docId}/restore/${versionId}" style="display:inline">
          <button class="btn" type="submit">Restore this version</button>
        </form>
      </div>
      <pre>${escaped}</pre>
    </div>
  </body></html>`
}

// Title is now stored in DB; no derivation required

function escapeHtmlAttr(value: string): string {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}


