import { getDatabase } from '../connection.js';

export interface User {
  id: number;
  accountId: string;
  createdAt: string;
  lastLoginAt: string;
}

/**
 * Create or update a user record
 */
export function upsertUser(accountId: string): User {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO users (account_id, last_login_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET last_login_at = datetime('now')
    RETURNING *
  `);

  return stmt.get(accountId) as User;
}

/**
 * Get a user by account ID
 */
export function getUser(accountId: string): User | undefined {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM users WHERE account_id = ?');
  const row = stmt.get(accountId) as any;

  if (!row) return undefined;

  return {
    id: row.id,
    accountId: row.account_id,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
}

/**
 * Check if a user exists
 */
export function userExists(accountId: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare('SELECT 1 FROM users WHERE account_id = ?');
  return stmt.get(accountId) !== undefined;
}

/**
 * Get all users
 */
export function getAllUsers(): User[] {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM users');
  const rows = stmt.all() as any[];

  return rows.map(row => ({
    id: row.id,
    accountId: row.account_id,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  }));
}
