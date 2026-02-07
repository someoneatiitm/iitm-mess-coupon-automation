import { getDatabase } from '../connection.js';
import { DailyState } from '../../conversation/types.js';

interface DailyStateRow {
  id: number;
  account_id: string;
  date: string;
  lunch_bought: number;
  dinner_bought: number;
  lunch_conversation_id: string | null;
  dinner_conversation_id: string | null;
  lunch_mess_preference: string | null;
  dinner_mess_preference: string | null;
  lunch_preference_asked: number;
  dinner_preference_asked: number;
  lunch_paused: number;
  dinner_paused: number;
  created_at: string;
  updated_at: string;
}

function rowToState(row: DailyStateRow): DailyState {
  return {
    date: row.date,
    lunchBought: row.lunch_bought === 1,
    dinnerBought: row.dinner_bought === 1,
    lunchConversationId: row.lunch_conversation_id || undefined,
    dinnerConversationId: row.dinner_conversation_id || undefined,
    lunchMessPreference: row.lunch_mess_preference ? JSON.parse(row.lunch_mess_preference) : undefined,
    dinnerMessPreference: row.dinner_mess_preference ? JSON.parse(row.dinner_mess_preference) : undefined,
    lunchPreferenceAsked: row.lunch_preference_asked === 1,
    dinnerPreferenceAsked: row.dinner_preference_asked === 1,
    lunchPaused: row.lunch_paused === 1,
    dinnerPaused: row.dinner_paused === 1
  };
}

/**
 * Get daily state for an account and date
 */
export function getDailyState(accountId: string, date: string): DailyState | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM daily_state
    WHERE account_id = ? AND date = ?
  `);

  const row = stmt.get(accountId, date) as DailyStateRow | undefined;

  if (!row) return null;

  return rowToState(row);
}

/**
 * Get the most recent daily state for an account (for loading on startup)
 */
export function getLatestDailyState(accountId: string): DailyState | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM daily_state
    WHERE account_id = ?
    ORDER BY date DESC
    LIMIT 1
  `);

  const row = stmt.get(accountId) as DailyStateRow | undefined;

  if (!row) return null;

  return rowToState(row);
}

/**
 * Save or update daily state
 */
export function saveDailyState(accountId: string, state: DailyState): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO daily_state (
      account_id, date,
      lunch_bought, dinner_bought,
      lunch_conversation_id, dinner_conversation_id,
      lunch_mess_preference, dinner_mess_preference,
      lunch_preference_asked, dinner_preference_asked,
      lunch_paused, dinner_paused,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, date) DO UPDATE SET
      lunch_bought = excluded.lunch_bought,
      dinner_bought = excluded.dinner_bought,
      lunch_conversation_id = excluded.lunch_conversation_id,
      dinner_conversation_id = excluded.dinner_conversation_id,
      lunch_mess_preference = excluded.lunch_mess_preference,
      dinner_mess_preference = excluded.dinner_mess_preference,
      lunch_preference_asked = excluded.lunch_preference_asked,
      dinner_preference_asked = excluded.dinner_preference_asked,
      lunch_paused = excluded.lunch_paused,
      dinner_paused = excluded.dinner_paused,
      updated_at = datetime('now')
  `);

  stmt.run(
    accountId,
    state.date,
    state.lunchBought ? 1 : 0,
    state.dinnerBought ? 1 : 0,
    state.lunchConversationId || null,
    state.dinnerConversationId || null,
    state.lunchMessPreference !== undefined ? JSON.stringify(state.lunchMessPreference) : null,
    state.dinnerMessPreference !== undefined ? JSON.stringify(state.dinnerMessPreference) : null,
    state.lunchPreferenceAsked ? 1 : 0,
    state.dinnerPreferenceAsked ? 1 : 0,
    state.lunchPaused ? 1 : 0,
    state.dinnerPaused ? 1 : 0
  );
}

/**
 * Delete daily state records older than a given number of days
 */
export function cleanupOldDailyStates(accountId: string, daysToKeep: number = 30): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM daily_state
    WHERE account_id = ? AND date < date('now', '-' || ? || ' days')
  `);

  const result = stmt.run(accountId, daysToKeep);
  return result.changes;
}
