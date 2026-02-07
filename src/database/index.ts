/**
 * Database module - SQLite storage for IITM Mess Coupon Automation
 *
 * This module provides persistent storage using SQLite with better-sqlite3.
 * All data is stored in data/mess_coupon.db
 */

import { getDatabase, initializeSchema, databaseExists, closeDatabase, getDatabasePath, getDataDir } from './connection.js';
import { logger } from '../utils/logger.js';

// Re-export repositories
export * from './repositories/userRepository.js';
export * from './repositories/dailyStateRepository.js';
export * from './repositories/conversationRepository.js';
export * from './repositories/dealRepository.js';
export * from './repositories/couponImageRepository.js';
export * from './repositories/processedMessageRepository.js';

// Re-export connection utilities
export { getDatabase, closeDatabase, databaseExists, getDatabasePath, getDataDir };

/**
 * Initialize the database
 * Should be called once at application startup
 */
export function initDatabase(): void {
  const dbPath = getDatabasePath();
  const isNew = !databaseExists();

  logger.info(isNew ? 'Creating new database...' : 'Connecting to existing database...', { path: dbPath });

  // Initialize schema (creates tables if they don't exist)
  initializeSchema();

  logger.info('Database initialized successfully');
}

/**
 * Shutdown the database gracefully
 */
export function shutdownDatabase(): void {
  logger.info('Closing database connection...');
  closeDatabase();
  logger.info('Database connection closed');
}

// Handle process exit
process.on('exit', () => {
  closeDatabase();
});

process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});
