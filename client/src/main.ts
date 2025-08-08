import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as monaco from 'monaco-editor'

function getDocumentId(): string {
  const m = location.pathname.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (!m) {
    document.body.innerHTML = '<p style="color:#e2e8f0;padding:2rem">Invalid document URL</p>'
    throw new Error('Invalid URL')
  }
  return m[1]
}

const docId = getDocumentId()
const ydoc = new Y.Doc()
const ytext = ydoc.getText('content')

const editorElement = document.getElementById('editor') as HTMLDivElement

// Monaco Editor setup - minimal markdown highlighting
const editor = monaco.editor.create(editorElement, {
  value: '',
  language: 'markdown',
  theme: 'vs-dark',
  wordWrap: 'on',
  automaticLayout: true,
  minimap: { enabled: false },
  lineNumbers: 'off',
  renderLineHighlight: 'none',
  padding: { top: 16, bottom: 24 },
  fontSize: 16,
  scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0 },
})

// Hocuspocus Provider for Yjs
const metaWs = (document.querySelector('meta[name="ws-url"]') as HTMLMetaElement | null)?.content || ''
const wsUrl = metaWs || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}${location.port ? ':' + (Number(import.meta.env.VITE_WS_PORT) || Number(location.port) + 1) : ''}`
const provider = new HocuspocusProvider({
  url: wsUrl,
  name: docId,
  document: ydoc,
})

new MonacoBinding(ytext, editor.getModel()!, new Set([editor]), provider.awareness)

// Connection status dot
const status = document.getElementById('status')!
function setStatus(cls: string, title: string) {
  status.className = `status-dot ${cls}`
  status.setAttribute('title', title)
}

setStatus('status-connecting', 'connecting')

provider.on('status', ({ status: s }) => {
  if (s === 'connected') setStatus('status-connected', 'connected')
  else if (s === 'connecting') setStatus('status-connecting', 'connecting')
  else setStatus('status-disconnected', 'disconnected')
})

// Listen to restore events via SSE to hard-reset editor content
const eventsUrl = `/api/documents/${encodeURIComponent(docId)}/events`
try {
  const es = new EventSource(eventsUrl)
  es.addEventListener('restore', (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data)
      const current = editor.getValue()
      if (current !== payload.text) {
        editor.setValue(payload.text)
      }
    } catch {}
  })
} catch {}

// Ensure initial content loads (in case of empty provider initial)
fetch(`/api/documents/${encodeURIComponent(docId)}`).then(async r => {
  if (!r.ok) return
  const data = await r.json()
  if (typeof data.text === 'string' && editor.getValue() === '') {
    editor.setValue(data.text)
  }
}).catch(() => {})

// Mobile-friendly: ensure viewport fits
window.addEventListener('resize', () => editor.layout())


