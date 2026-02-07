import { DailyState, CouponType, IITM_MESSES } from '../conversation/types.js';
import { logger } from '../utils/logger.js';
import { fuzzyMatchMessName } from '../utils/fuzzyMatch.js';

// Lunch cutoff time: 2:10 PM (14:10) - only for real mode
const LUNCH_CUTOFF_HOUR = 14;
const LUNCH_CUTOFF_MINUTE = 10;

// Dinner cutoff time: 9:10 PM (21:10) - only for real mode
const DINNER_CUTOFF_HOUR = 21;
const DINNER_CUTOFF_MINUTE = 10;

export class DailyTracker {
  private state: DailyState;
  private onStateChange: () => void;
  private testMode: boolean;

  constructor(initialState: DailyState, onStateChange: () => void, testMode: boolean = false) {
    this.state = initialState;
    this.onStateChange = onStateChange;
    this.testMode = testMode;
    this.checkAndResetIfNewDay();

    if (testMode) {
      logger.info('DailyTracker running in TEST MODE - no purchase limits or time restrictions');
    } else {
      logger.info('DailyTracker running in REAL MODE', {
        lunchCutoff: `${LUNCH_CUTOFF_HOUR}:${LUNCH_CUTOFF_MINUTE.toString().padStart(2, '0')}`,
        dinnerCutoff: `${DINNER_CUTOFF_HOUR}:${DINNER_CUTOFF_MINUTE.toString().padStart(2, '0')}`
      });
    }
  }

  private checkAndResetIfNewDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.state.date !== today) {
      logger.info('New day detected, resetting tracker');
      this.state = {
        date: today,
        lunchBought: false,
        dinnerBought: false
      };
      this.onStateChange();
    }
  }

  private isLunchTimeOver(): boolean {
    // No time restrictions in test mode
    if (this.testMode) return false;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    if (currentHour > LUNCH_CUTOFF_HOUR) {
      return true;
    }
    if (currentHour === LUNCH_CUTOFF_HOUR && currentMinute >= LUNCH_CUTOFF_MINUTE) {
      return true;
    }
    return false;
  }

  private isDinnerTimeOver(): boolean {
    // No time restrictions in test mode
    if (this.testMode) return false;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    if (currentHour > DINNER_CUTOFF_HOUR) {
      return true;
    }
    if (currentHour === DINNER_CUTOFF_HOUR && currentMinute >= DINNER_CUTOFF_MINUTE) {
      return true;
    }
    return false;
  }

  canBuyCoupon(type: CouponType): boolean {
    // In test mode, always allow buying (no limits)
    if (this.testMode) {
      return true;
    }

    this.checkAndResetIfNewDay();

    if (type === 'lunch') {
      // Can't buy lunch if already bought, paused, or past time
      if (this.state.lunchPaused) {
        logger.debug('Lunch session is PAUSED');
        return false;
      }
      if (this.isLunchTimeOver()) {
        logger.debug('Lunch time is over (past 2:10 PM)');
        return false;
      }
      return !this.state.lunchBought;
    } else {
      // Can't buy dinner if already bought, paused, or past time
      if (this.state.dinnerPaused) {
        logger.debug('Dinner session is PAUSED');
        return false;
      }
      if (this.isDinnerTimeOver()) {
        logger.debug('Dinner time is over (past 9:10 PM)');
        return false;
      }
      return !this.state.dinnerBought;
    }
  }

  markCouponBought(type: CouponType, conversationId: string): void {
    this.checkAndResetIfNewDay();

    if (type === 'lunch') {
      this.state.lunchBought = true;
      this.state.lunchConversationId = conversationId;
      logger.info('Lunch coupon marked as bought', { conversationId });
    } else {
      this.state.dinnerBought = true;
      this.state.dinnerConversationId = conversationId;
      logger.info('Dinner coupon marked as bought', { conversationId });
    }

    this.onStateChange();
  }

  getNeededCouponType(): CouponType | null {
    // In test mode, return based on what's not bought (no time check)
    if (this.testMode) {
      if (!this.state.lunchBought) return 'lunch';
      if (!this.state.dinnerBought) return 'dinner';
      return null;
    }

    this.checkAndResetIfNewDay();

    // Only look for lunch if not bought AND before 2:10 PM
    if (!this.state.lunchBought && !this.isLunchTimeOver()) {
      return 'lunch';
    }
    // Only look for dinner if not bought AND before 9:10 PM
    if (!this.state.dinnerBought && !this.isDinnerTimeOver()) {
      return 'dinner';
    }
    return null;
  }

  getState(): DailyState {
    this.checkAndResetIfNewDay();
    return { ...this.state };
  }

  getStatus(): string {
    this.checkAndResetIfNewDay();

    let lunch: string;
    if (this.state.lunchBought) {
      lunch = 'BOUGHT';
    } else if (this.state.lunchPaused) {
      lunch = 'PAUSED';
    } else if (!this.testMode && this.isLunchTimeOver()) {
      lunch = 'SKIPPED (past 2:10 PM)';
    } else {
      lunch = 'NEEDED';
    }

    let dinner: string;
    if (this.state.dinnerBought) {
      dinner = 'BOUGHT';
    } else if (this.state.dinnerPaused) {
      dinner = 'PAUSED';
    } else if (!this.testMode && this.isDinnerTimeOver()) {
      dinner = 'SKIPPED (past 9:10 PM)';
    } else {
      dinner = 'NEEDED';
    }

    const modeLabel = this.testMode ? ' [TEST]' : '';
    return `[${this.state.date}]${modeLabel} Lunch: ${lunch} | Dinner: ${dinner}`;
  }

  // Check if it's morning (12am - 12pm)
  isMorning(): boolean {
    const now = new Date();
    return now.getHours() < 12;
  }

  // Check if lunch preference has been asked today
  needsLunchPreference(): boolean {
    this.checkAndResetIfNewDay();
    return !this.state.lunchPreferenceAsked && !this.state.lunchBought;
  }

  // Check if dinner preference has been asked today
  needsDinnerPreference(): boolean {
    this.checkAndResetIfNewDay();
    return !this.state.dinnerPreferenceAsked && !this.state.dinnerBought;
  }

  // Set lunch preference (array of mess names, null = any)
  setLunchPreference(messNames: string[] | null): void {
    this.checkAndResetIfNewDay();
    this.state.lunchMessPreference = messNames;
    this.state.lunchPreferenceAsked = true;
    logger.info('Lunch preference set', { preference: messNames || 'any' });
    this.onStateChange();
  }

  // Set dinner preference (array of mess names, null = any)
  setDinnerPreference(messNames: string[] | null): void {
    this.checkAndResetIfNewDay();
    this.state.dinnerMessPreference = messNames;
    this.state.dinnerPreferenceAsked = true;
    logger.info('Dinner preference set', { preference: messNames || 'any' });
    this.onStateChange();
  }

  // Get lunch preference (null = any)
  getLunchPreference(): string[] | null {
    this.checkAndResetIfNewDay();
    return this.state.lunchMessPreference ?? null;
  }

  // Get dinner preference (null = any)
  getDinnerPreference(): string[] | null {
    this.checkAndResetIfNewDay();
    return this.state.dinnerMessPreference ?? null;
  }

  // Get preference for a coupon type
  getPreference(type: CouponType): string[] | null {
    return type === 'lunch' ? this.getLunchPreference() : this.getDinnerPreference();
  }

  // Generate the preference message
  static generatePreferenceMessage(type: CouponType): string {
    const mealType = type === 'lunch' ? 'LUNCH' : 'DINNER';
    let message = `🍽️ ${mealType} MESS PREFERENCE\n\n`;
    message += `Which mess do you prefer for ${type} today?\n\n`;
    message += `0. Any (no preference)\n`;

    IITM_MESSES.forEach((mess, index) => {
      message += `${index + 1}. ${mess}\n`;
    });

    message += `\nReply with the number only.`;
    return message;
  }

  // Parse preference response (index number)
  static parsePreferenceResponse(response: string): string | null {
    const trimmed = response.trim();
    const index = parseInt(trimmed, 10);

    if (isNaN(index)) {
      return undefined as any; // Invalid response
    }

    if (index === 0) {
      return null; // "Any" preference
    }

    if (index >= 1 && index <= IITM_MESSES.length) {
      return IITM_MESSES[index - 1];
    }

    return undefined as any; // Invalid index
  }

  /**
   * Check if a sell message matches any of the preferences
   * Uses fuzzy matching to handle spelling mistakes in the message
   */
  matchesPreference(type: CouponType, sellMessage: string): boolean {
    const preferences = this.getPreference(type);

    // If preference is "any" (null or empty), match everything
    if (preferences === null || preferences.length === 0) {
      return true;
    }

    // Use fuzzy matching to detect mess name in the message
    const matchResult = fuzzyMatchMessName(sellMessage);

    if (!matchResult.matched || !matchResult.correctedName) {
      // No mess name detected in message - can't determine match
      // Return false to skip, state machine will ask seller for mess name
      return false;
    }

    // Log if auto-correction happened
    if (matchResult.distance > 0) {
      logger.info('Mess name auto-corrected for preference check', {
        original: matchResult.originalWord,
        corrected: matchResult.correctedName,
        distance: matchResult.distance
      });
    }

    // Check if the corrected mess name matches any preference
    return preferences.some(
      pref => pref.toLowerCase() === matchResult.correctedName!.toLowerCase()
    );
  }

  /**
   * Detect mess name in a message with auto-correction
   * Returns the corrected/canonical mess name
   */
  detectMessName(message: string): string | null {
    const result = fuzzyMatchMessName(message);
    return result.matched ? result.correctedName : null;
  }

  // Pause a session (stop finding coupons for this type)
  pauseSession(type: CouponType): void {
    this.checkAndResetIfNewDay();
    if (type === 'lunch') {
      this.state.lunchPaused = true;
      logger.info('Lunch session PAUSED');
    } else {
      this.state.dinnerPaused = true;
      logger.info('Dinner session PAUSED');
    }
    this.onStateChange();
  }

  // Resume a session (start finding coupons for this type again)
  resumeSession(type: CouponType): void {
    this.checkAndResetIfNewDay();
    if (type === 'lunch') {
      this.state.lunchPaused = false;
      logger.info('Lunch session RESUMED');
    } else {
      this.state.dinnerPaused = false;
      logger.info('Dinner session RESUMED');
    }
    this.onStateChange();
  }

  // Check if a session is paused
  isSessionPaused(type: CouponType): boolean {
    this.checkAndResetIfNewDay();
    if (type === 'lunch') {
      return this.state.lunchPaused === true;
    } else {
      return this.state.dinnerPaused === true;
    }
  }

  // Force reset a session (clears bought status and resumes searching)
  forceResetSession(type: CouponType): void {
    this.checkAndResetIfNewDay();
    if (type === 'lunch') {
      this.state.lunchBought = false;
      this.state.lunchPaused = false;
      this.state.lunchConversationId = undefined;
      logger.info('Lunch session FORCE RESET - now searching for lunch coupon');
    } else {
      this.state.dinnerBought = false;
      this.state.dinnerPaused = false;
      this.state.dinnerConversationId = undefined;
      logger.info('Dinner session FORCE RESET - now searching for dinner coupon');
    }
    this.onStateChange();
  }

  // Manually mark a session as bought (without a conversation)
  markSessionBought(type: CouponType): void {
    this.checkAndResetIfNewDay();
    if (type === 'lunch') {
      this.state.lunchBought = true;
      this.state.lunchPaused = false;
      logger.info('Lunch session manually marked as BOUGHT');
    } else {
      this.state.dinnerBought = true;
      this.state.dinnerPaused = false;
      logger.info('Dinner session manually marked as BOUGHT');
    }
    this.onStateChange();
  }

  // Check if a session is bought
  isSessionBought(type: CouponType): boolean {
    this.checkAndResetIfNewDay();
    return type === 'lunch' ? this.state.lunchBought : this.state.dinnerBought;
  }

  // Toggle session status (bought <-> needed)
  toggleSessionStatus(type: CouponType): { newStatus: 'bought' | 'needed' } {
    this.checkAndResetIfNewDay();
    const isBought = this.isSessionBought(type);
    if (isBought) {
      this.forceResetSession(type);
      return { newStatus: 'needed' };
    } else {
      this.markSessionBought(type);
      return { newStatus: 'bought' };
    }
  }

  // Get the current active session (which coupon type we should be looking for)
  getCurrentSession(): CouponType | null {
    this.checkAndResetIfNewDay();

    // In test mode, return based on what's not bought
    if (this.testMode) {
      if (!this.state.lunchBought) return 'lunch';
      if (!this.state.dinnerBought) return 'dinner';
      return null;
    }

    // Check lunch session
    if (!this.state.lunchBought && !this.state.lunchPaused && !this.isLunchTimeOver()) {
      return 'lunch';
    }

    // Check dinner session
    if (!this.state.dinnerBought && !this.state.dinnerPaused && !this.isDinnerTimeOver()) {
      return 'dinner';
    }

    return null;
  }

  // Stop current session and move to next
  stopCurrentSession(): { stoppedSession: CouponType | null; nextSession: CouponType | null } {
    const currentSession = this.getCurrentSession();

    if (!currentSession) {
      return { stoppedSession: null, nextSession: null };
    }

    this.pauseSession(currentSession);

    // Determine next session
    let nextSession: CouponType | null = null;
    if (currentSession === 'lunch') {
      // Check if dinner is available
      if (!this.state.dinnerBought && !this.state.dinnerPaused && !this.isDinnerTimeOver()) {
        nextSession = 'dinner';
      }
    }
    // If dinner was stopped, no next session today

    return { stoppedSession: currentSession, nextSession };
  }

  // Start/resume current or next available session
  startSession(): { startedSession: CouponType | null } {
    this.checkAndResetIfNewDay();

    // Try to resume lunch first if it was paused and still valid
    if (this.state.lunchPaused && !this.state.lunchBought && !this.isLunchTimeOver()) {
      this.resumeSession('lunch');
      return { startedSession: 'lunch' };
    }

    // Try to resume dinner if it was paused and still valid
    if (this.state.dinnerPaused && !this.state.dinnerBought && !this.isDinnerTimeOver()) {
      this.resumeSession('dinner');
      return { startedSession: 'dinner' };
    }

    // Check if there's an active session already
    const current = this.getCurrentSession();
    return { startedSession: current };
  }

  // Reset all state (for new user login)
  reset(): void {
    const today = new Date().toISOString().split('T')[0];
    this.state = {
      date: today,
      lunchBought: false,
      dinnerBought: false
    };
    logger.info('DailyTracker state reset for new user');
    this.onStateChange();
  }
}
