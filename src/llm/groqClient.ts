import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';

let groqClient: Groq | null = null;

export function initGroqClient(): Groq {
  if (groqClient) return groqClient;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY environment variable is required');
  }

  groqClient = new Groq({ apiKey });
  logger.info('Groq client initialized');
  return groqClient;
}

export async function chat(systemPrompt: string, userMessage: string): Promise<string> {
  const client = initGroqClient();

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    const response = completion.choices[0]?.message?.content || '';
    return response.trim();
  } catch (error) {
    logger.error('Groq API error', error);
    throw error;
  }
}

export async function chatWithRetry(
  systemPrompt: string,
  userMessage: string,
  maxRetries = 3
): Promise<string> {
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chat(systemPrompt, userMessage);
    } catch (error) {
      lastError = error;
      logger.warn(`Groq API retry ${i + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }

  throw lastError;
}
