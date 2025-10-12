import { LogEntry } from './types.js';

export class MCPLogger {
  private server: any = null; // Will be set from index.ts

  setServer(server: any): void {
    this.server = server;
  }

  log(entry: LogEntry): void {
    if (!this.server) {
      // Server not initialized yet, skip
      return;
    }

    try {
      // Send MCP notification
      this.server.notification({
        method: 'notifications/message',
        params: {
          level: this.mapLevel(entry.level),
          logger: entry.logger || 'kaiten-mcp',
          data: {
            message: entry.message,
            timestamp: entry.timestamp || new Date().toISOString(),
            ...entry.data,
          },
        },
      });
    } catch (error) {
      // Fail silently - logging should never crash the app
      console.error('[MCPLogger] Failed to send log:', error);
    }
  }

  // Map our levels to MCP levels (they're the same, but for clarity)
  private mapLevel(level: string): string {
    const mapping: Record<string, string> = {
      debug: 'debug',
      info: 'info',
      notice: 'notice',
      warning: 'warning',
      error: 'error',
      critical: 'critical',
      alert: 'alert',
      emergency: 'emergency',
    };
    return mapping[level] || 'info';
  }
}
