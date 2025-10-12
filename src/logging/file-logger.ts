import pino from 'pino';
import { LogEntry } from './types.js';
import { redactSecrets } from '../config.js';

export class FileLogger {
  private pino: pino.Logger;

  constructor() {
    const logPath = process.env.KAITEN_LOG_FILE_PATH || './logs/kaiten-mcp.log';

    this.pino = pino({
      level: 'debug', // Pino level (we filter in logger.ts)

      // Structured JSON output
      formatters: {
        level: (label) => ({ level: label }),
      },

      // Timestamp
      timestamp: pino.stdTimeFunctions.isoTime,

      // Redact sensitive data
      redact: {
        paths: ['*.token', '*.password', '*.api_key', 'Authorization'],
        censor: '***REDACTED***',
      },
    },

    // Rotating file transport
    pino.destination({
      dest: logPath,
      sync: false, // Async for performance
      mkdir: true, // Auto-create logs/ directory
    }));
  }

  log(entry: LogEntry): void {
    try {
      // Redact secrets from message and data
      const safeMessage = redactSecrets(entry.message);
      const safeData = entry.data
        ? JSON.parse(redactSecrets(JSON.stringify(entry.data)))
        : undefined;

      // Map RFC 5424 levels to pino levels
      const pinoLevel = this.mapToPinoLevel(entry.level);

      // Log to pino
      this.pino[pinoLevel]({
        level: entry.level, // Keep original level in log entry
        logger: entry.logger,
        timestamp: entry.timestamp || new Date().toISOString(),
        ...safeData,
      }, safeMessage);
    } catch (error) {
      // Fail silently
      console.error('[FileLogger] Failed to write log:', error);
    }
  }

  // Map RFC 5424 levels to pino's standard levels
  private mapToPinoLevel(level: string): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
    switch (level) {
      case 'debug': return 'debug';
      case 'info': return 'info';
      case 'notice': return 'info';
      case 'warning': return 'warn';
      case 'error': return 'error';
      case 'critical': return 'error';
      case 'alert': return 'fatal';
      case 'emergency': return 'fatal';
      default: return 'info';
    }
  }

  close(): void {
    // Pino doesn't need explicit close, but good to have for cleanup
  }
}
