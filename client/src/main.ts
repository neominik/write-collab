import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as monaco from 'monaco-editor'

function getDocumentId(): string {
  const m = location.pathname.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (!m) {
    document.body.innerHTML = '<p style="padding:2rem">Invalid document URL</p>'
    throw new Error('Invalid URL')
  }
  return m[1]
}

const docId = getDocumentId()
const ydoc = new Y.Doc()
const ytext = ydoc.getText('content')

const editorElement = document.getElementById('editor') as HTMLDivElement
const titleInput = document.getElementById('title') as HTMLInputElement | null

const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
const initialMonacoTheme = prefersDark ? 'vs-dark' : 'vs'

const editor = monaco.editor.create(editorElement, {
  value: '',
  language: 'markdown',
  theme: initialMonacoTheme,
  wordWrap: 'on',
  automaticLayout: true,
  minimap: { enabled: false },
  lineNumbers: 'off',
  renderLineHighlight: 'none',
  padding: { top: 16, bottom: 24 },
  fontSize: 16,
  scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0 },
})

// React to system theme changes
try {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = (isDark: boolean) => monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', (ev) => applyTheme(ev.matches))
  } else if (typeof media.addListener === 'function') {
    // Safari < 14
    media.addListener((ev) => applyTheme(ev.matches))
  }
} catch {}

function setBrowserTitle(title: string) { document.title = (title || 'Untitled') + ' – Write Collab' }

const metaWs = (document.querySelector('meta[name="ws-url"]') as HTMLMetaElement | null)?.content || ''
const wsUrl = metaWs || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}${location.port ? ':' + (Number(import.meta.env.VITE_WS_PORT) || Number(location.port) + 1) : ''}`
const provider = new HocuspocusProvider({
  url: wsUrl,
  name: docId,
  document: ydoc,
})

new MonacoBinding(ytext, editor.getModel()!, new Set([editor]), provider.awareness)

setBrowserTitle('')

const eventsUrl = `/api/documents/${encodeURIComponent(docId)}/events`
try {
  const es = new EventSource(eventsUrl)
  es.addEventListener('restore', (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data)
      const incoming = (payload?.text ?? '').toString()
      const current = ytext.toString()
      if (current !== incoming) {
        ydoc.transact(() => {
          ytext.delete(0, ytext.length)
          ytext.insert(0, incoming)
        })
      }
    } catch {}
  })
  es.addEventListener('title', (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data)
      if (typeof payload.title === 'string') {
        if (titleInput) titleInput.value = payload.title
        setBrowserTitle(payload.title)
      }
    } catch {}
  })
} catch {}

fetch(`/api/documents/${encodeURIComponent(docId)}`).then(async r => {
  if (!r.ok) return
  const data = await r.json()
  if (typeof data.title === 'string') {
    if (titleInput) titleInput.value = data.title
    setBrowserTitle(data.title)
  }
}).catch(() => {})

let titleDebounce: number | undefined
titleInput?.addEventListener('input', () => {
  const value = titleInput.value
  setBrowserTitle(value)
  if (titleDebounce) window.clearTimeout(titleDebounce)
  titleDebounce = window.setTimeout(() => {
    fetch(`/api/documents/${encodeURIComponent(docId)}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: value }),
    }).catch(() => {})
  }, 300)
})

window.addEventListener('resize', () => editor.layout())


