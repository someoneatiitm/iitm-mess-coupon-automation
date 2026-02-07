import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const DB_PATH = join(DATA_DIR, 'mess_coupon.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let db: Database.Database | null = null;

/**
 * Get or create the database connection singleton
 */
export function getDatabase(): Database.Database {
  if (db) {
    return db;
  }

  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Create database connection
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * Initialize the database schema
 */
export function initializeSchema(): void {
  const database = getDatabase();

  // Read and execute schema SQL
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  database.exec(schema);
}

/**
 * Check if the database file exists
 */
export function databaseExists(): boolean {
  return existsSync(DB_PATH);
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get the database file path
 */
export function getDatabasePath(): string {
  return DB_PATH;
}

/**
 * Get the data directory path
 */
export function getDataDir(): string {
  return DATA_DIR;
}

export { DB_PATH, DATA_DIR };
