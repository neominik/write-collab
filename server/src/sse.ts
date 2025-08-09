import type { Response } from 'express'

type Client = { res: Response }

const channels: Map<string, Set<Client>> = new Map()

export function subscribe(docId: string, res: Response) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const client: Client = { res }
  let set = channels.get(docId)
  if (!set) {
    set = new Set()
    channels.set(docId, set)
  }
  set.add(client)

  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\n\n`) } catch {}
  }, 15000)

  res.on('close', () => {
    clearInterval(heartbeat)
    set?.delete(client)
    if (set && set.size === 0) {
      channels.delete(docId)
    }
  })
}

export function publish(docId: string, event: string, data: any) {
  const set = channels.get(docId)
  if (!set) return
  const payload = `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n`
  for (const client of set) {
    try { client.res.write(payload) } catch {}
  }
}

