import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Config {
  groups: string[];
  testPhoneNumbers: string[];
  myPhoneNumber: string;
  maxPrice: number;
  messageDelayMs: number;
  notificationSound: boolean;
}

let config: Config | null = null;

export function loadConfig(): Config {
  if (config) return config;

  const configPath = join(__dirname, '../../config/config.json');
  const data = readFileSync(configPath, 'utf-8');
  config = JSON.parse(data) as Config;
  return config;
}

export function getConfig(): Config {
  if (!config) {
    return loadConfig();
  }
  return config;
}

// Convert phone number to WhatsApp ID format
export function phoneToWhatsAppId(phone: string): string {
  // Remove any non-digits
  const cleaned = phone.replace(/\D/g, '');
  // Add India country code if not present
  if (cleaned.length === 10) {
    return `91${cleaned}@c.us`;
  }
  return `${cleaned}@c.us`;
}
