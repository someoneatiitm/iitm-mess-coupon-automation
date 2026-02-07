type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function getTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string, data?: unknown): string {
  const timestamp = getTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (data) {
    return `${prefix} ${message} ${JSON.stringify(data)}`;
  }
  return `${prefix} ${message}`;
}

export const logger = {
  info(message: string, data?: unknown): void {
    console.log(formatMessage('info', message, data));
  },

  warn(message: string, data?: unknown): void {
    console.warn(formatMessage('warn', message, data));
  },

  error(message: string, data?: unknown): void {
    console.error(formatMessage('error', message, data));
  },

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      console.log(formatMessage('debug', message, data));
    }
  }
};
