# Write Collab

Minimal, beautiful, and fast collaborative markdown writing with Yjs + Hocuspocus, Monaco editor, Express, and Postgres. Single admin with secret-protected index & version restore. No chrome besides text and a small connection dot.

## Features
- Realtime collaboration via Yjs/Hocuspocus
- Unique, unguessable document IDs
- Admin index protected by `ADMIN_SECRET`
- Version history and restore
- Mobile-friendly UI, minimal chrome, markdown highlighting
- Docker Compose with Traefik and Postgres

## Quick start (local)
1. Copy `.env.example` to `.env` and set `ADMIN_SECRET`.
2. Install deps: `pnpm i && (cd client && pnpm i) && (cd server && pnpm i)`
3. Run server: `pnpm dev`
   - HTTP: http://localhost:3000
   - WS: ws://localhost:3001

## Docker Compose
Set environment variables (at least `ADMIN_SECRET`, optionally `DOMAIN`, `WS_DOMAIN`). Then:

```bash
docker compose up -d --build
```

Visit:
- App: http://$DOMAIN
- WS: ws://$WS_DOMAIN

## Admin
- Open `/admin` and enter your `ADMIN_SECRET`.
- Create new doc → redirects to `/d/:id`.
- View versions and restore any snapshot.


