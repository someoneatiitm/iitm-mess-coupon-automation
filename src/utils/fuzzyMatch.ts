/**
 * Fuzzy matching utilities for mess name detection
 * Handles common spelling mistakes in WhatsApp messages
 */

import { IITM_MESSES } from '../conversation/types.js';

/**
 * Calculate Levenshtein distance between two strings
 * (minimum number of single-character edits to change one string into another)
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create distance matrix
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize first column and row
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate similarity ratio between two strings (0 to 1)
 * 1 = identical, 0 = completely different
 */
export function similarityRatio(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1; // Both empty strings
  const distance = levenshteinDistance(str1, str2);
  return 1 - (distance / maxLen);
}

/**
 * Common misspellings and variations for each mess
 * Maps misspelling -> correct name
 *
 * NOTE: SGR and SRR are very similar (1 char difference), so we use distinct
 * aliases for each to avoid confusion. Fuzzy matching is disabled for these two.
 */
const MESS_ALIASES: Record<string, string> = {
  // SGR variations (distinct aliases only - no fuzzy matching)
  'sgr': 'SGR',
  'sagar': 'SGR',     // Common way people say SGR
  'sagr': 'SGR',      // Typo for sagar

  // SRR variations (distinct aliases only - no fuzzy matching)
  'srr': 'SRR',
  'south': 'SRR',     // South mess = SRR
  'south mess': 'SRR',
  'southmess': 'SRR',

  // Firstman variations
  'firstman': 'Firstman',
  'first man': 'Firstman',
  '1st man': 'Firstman',
  '1stman': 'Firstman',
  'firstmen': 'Firstman',
  'fristman': 'Firstman',
  'firstmam': 'Firstman',
  'fisrtman': 'Firstman',
  'firsrman': 'Firstman',
  'firstmsn': 'Firstman',

  // Prism variations
  'prism': 'Prism',
  'prizm': 'Prism',
  'prismm': 'Prism',
  'prisim': 'Prism',

  // Neelkesh variations
  'neelkesh': 'Neelkesh',
  'nilkesh': 'Neelkesh',
  'neelksh': 'Neelkesh',
  'neelkes': 'Neelkesh',
  'neelkash': 'Neelkesh',
  'neelkessh': 'Neelkesh',
  'neelkech': 'Neelkesh',
  'neel': 'Neelkesh',
  'nilesh': 'Neelkesh',

  // Food Sutra variations
  'food sutra': 'Food Sutra',
  'foodsutra': 'Food Sutra',
  'food sutr': 'Food Sutra',
  'food suthra': 'Food Sutra',
  'fs': 'Food Sutra',
  'foodsuthra': 'Food Sutra',
  'food stura': 'Food Sutra',
  'foodstura': 'Food Sutra',
  'foof sutra': 'Food Sutra',
  'food suutra': 'Food Sutra',

  // Vindhya variations
  'vindhya': 'Vindhya',
  'vindya': 'Vindhya',
  'vindhaya': 'Vindhya',
  'vindhiya': 'Vindhya',
  'vindh': 'Vindhya',
  'vindhyaa': 'Vindhya',
  'vindhay': 'Vindhya',
  'vindhys': 'Vindhya',
  'vundhya': 'Vindhya',
};

/**
 * Default threshold for fuzzy matching
 * Lower = stricter matching, Higher = more lenient
 *
 * Threshold of 2 means:
 * - For short words (3-5 chars): allows 1-2 character errors
 * - For longer words (6+ chars): allows 2 character errors
 */
const DEFAULT_MAX_DISTANCE = 2;

/**
 * Mess names that are too similar to each other and require EXACT matching
 * SGR and SRR are only 1 character apart - fuzzy matching would confuse them
 */
const EXACT_MATCH_ONLY = new Set(['sgr', 'srr']);

/**
 * Dynamic threshold based on word length
 * Shorter words get stricter threshold to avoid false positives
 */
function getMaxDistance(wordLength: number, targetWord?: string): number {
  // SGR and SRR require exact match (distance 0) to avoid confusion
  if (targetWord && EXACT_MATCH_ONLY.has(targetWord.toLowerCase())) {
    return 0;
  }

  if (wordLength <= 3) return 1;      // Short words: only 1 error allowed
  if (wordLength <= 5) return 2;      // Medium words: 2 errors
  return Math.min(3, Math.floor(wordLength * 0.3)); // Longer words: up to 30% errors, max 3
}

export interface FuzzyMatchResult {
  matched: boolean;
  correctedName: string | null;
  originalWord: string | null;
  distance: number;
  confidence: number; // 0 to 1
}

/**
 * Find the best matching mess name in a message using fuzzy matching
 * Returns the corrected mess name if found
 */
export function fuzzyMatchMessName(message: string): FuzzyMatchResult {
  const lowerMessage = message.toLowerCase();
  const words = lowerMessage.split(/\s+/);

  // First, check exact matches and known aliases
  for (const [alias, messName] of Object.entries(MESS_ALIASES)) {
    if (lowerMessage.includes(alias)) {
      return {
        matched: true,
        correctedName: messName,
        originalWord: alias,
        distance: 0,
        confidence: 1
      };
    }
  }

  // Check exact matches with IITM_MESSES
  for (const mess of IITM_MESSES) {
    if (lowerMessage.includes(mess.toLowerCase())) {
      return {
        matched: true,
        correctedName: mess,
        originalWord: mess.toLowerCase(),
        distance: 0,
        confidence: 1
      };
    }
  }

  // Fuzzy match each word against mess names
  let bestMatch: FuzzyMatchResult = {
    matched: false,
    correctedName: null,
    originalWord: null,
    distance: Infinity,
    confidence: 0
  };

  // Also try 2-word combinations (for "Food Sutra", "First Man" etc)
  const wordPairs: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    wordPairs.push(`${words[i]} ${words[i + 1]}`);
    wordPairs.push(`${words[i]}${words[i + 1]}`); // Without space
  }

  const allCandidates = [...words, ...wordPairs];

  for (const word of allCandidates) {
    if (word.length < 2) continue; // Skip very short words

    // Check against each mess name
    for (const mess of IITM_MESSES) {
      const messLower = mess.toLowerCase();
      const distance = levenshteinDistance(word, messLower);
      // Pass messLower to check if it's SGR/SRR (require exact match)
      const maxDist = getMaxDistance(messLower.length, messLower);

      if (distance <= maxDist && distance < bestMatch.distance) {
        const confidence = 1 - (distance / Math.max(word.length, messLower.length));
        bestMatch = {
          matched: true,
          correctedName: mess,
          originalWord: word,
          distance,
          confidence
        };
      }
    }

    // Also check against aliases
    for (const [alias, messName] of Object.entries(MESS_ALIASES)) {
      const distance = levenshteinDistance(word, alias);
      // Pass alias to check if it's SGR/SRR (require exact match)
      const maxDist = getMaxDistance(alias.length, alias);

      if (distance <= maxDist && distance < bestMatch.distance) {
        const confidence = 1 - (distance / Math.max(word.length, alias.length));
        bestMatch = {
          matched: true,
          correctedName: messName,
          originalWord: word,
          distance,
          confidence
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Check if a message contains a mess name that matches any of the preferences
 * Uses fuzzy matching to handle spelling mistakes
 */
export function fuzzyMatchesPreference(message: string, preferences: string[]): {
  matches: boolean;
  detectedMess: string | null;
  correctedMess: string | null;
} {
  const matchResult = fuzzyMatchMessName(message);

  if (!matchResult.matched || !matchResult.correctedName) {
    return {
      matches: false,
      detectedMess: null,
      correctedMess: null
    };
  }

  // Check if the corrected mess name matches any preference
  const matches = preferences.some(
    pref => pref.toLowerCase() === matchResult.correctedName!.toLowerCase()
  );

  return {
    matches,
    detectedMess: matchResult.originalWord,
    correctedMess: matchResult.correctedName
  };
}

/**
 * Get all registered mess aliases (for documentation/debugging)
 */
export function getMessAliases(): Record<string, string> {
  return { ...MESS_ALIASES };
}

/**
 * Add a new alias for a mess (can be used to learn from user corrections)
 */
export function addMessAlias(alias: string, messName: string): void {
  if (IITM_MESSES.includes(messName as any)) {
    MESS_ALIASES[alias.toLowerCase()] = messName;
  }
}
