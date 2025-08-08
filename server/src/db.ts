import { Pool } from 'pg'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
})

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>{
  const client = await pool.connect()
  try {
    const res = await client.query(text, params)
    return { rows: res.rows as T[] }
  } finally {
    client.release()
  }
}

export async function migrate() {
  await query(`
  -- helper extension for uuid
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_text TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    text TEXT NOT NULL
  );
  `)

  // Ensure columns exist on already-created tables
  await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`)
}

