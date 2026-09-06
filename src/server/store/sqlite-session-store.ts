/* SQLite SessionStore adapter. Operator sessions live in the console's
 * existing state.db, opened as a second connection (WAL allows concurrent
 * connections; every statement here is short and the better-sqlite3 calls
 * are synchronous, so our own statements can never race each other within
 * one process). Only sha256 token hashes cross this boundary — never raw
 * tokens or passcodes. Methods are async per the seam, like the RunStore. */
import path from 'node:path'
import Database from 'better-sqlite3'
import type { SessionStore, OperatorSessionRow } from './store'

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database
  private readonly ready: Promise<void>

  constructor(dir: string, dbFilename = 'state.db') {
    this.db = new Database(path.join(dir, dbFilename))
    this.db.pragma('journal_mode = WAL')
    // Bridge the async seam the same way the engine does: each method awaits
    // this promise, so callers never see a table that is not there yet.
    this.ready = this.initialize()
  }

  async initialize(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `)
  }

  async createSession(tokenHash: string, createdAt: string, expiresAt: string): Promise<void> {
    await this.ready
    this.db
      .prepare('INSERT INTO operator_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, createdAt, expiresAt)
  }

  async getSession(tokenHash: string): Promise<OperatorSessionRow | undefined> {
    await this.ready
    return this.db
      .prepare('SELECT token_hash, created_at, expires_at FROM operator_sessions WHERE token_hash = ?')
      .get(tokenHash) as OperatorSessionRow | undefined
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.ready
    this.db.prepare('DELETE FROM operator_sessions WHERE token_hash = ?').run(tokenHash)
  }

  async purgeExpiredSessions(nowIso: string): Promise<void> {
    await this.ready
    this.db.prepare('DELETE FROM operator_sessions WHERE expires_at <= ?').run(nowIso)
  }

  async close(): Promise<void> {
    await this.ready
    this.db.close()
  }
}
