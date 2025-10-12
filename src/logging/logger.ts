import { LogLevel, LogEntry, LoggerConfig, PerformanceMetrics } from './types.js';
import { MCPLogger } from './mcp-logger.js';
import { FileLogger } from './file-logger.js';
import { MetricsCollector } from './metrics.js';

class Logger {
  private config: LoggerConfig;
  private mcpLogger: MCPLogger;
  private fileLogger: FileLogger | null;
  private metricsCollector: MetricsCollector;

  constructor() {
    this.config = this.loadConfig();
    this.mcpLogger = new MCPLogger();
    this.fileLogger = this.config.fileEnabled ? new FileLogger() : null;
    this.metricsCollector = new MetricsCollector(this.config.metricsEnabled);
  }

  // Load config from environment
  private loadConfig(): LoggerConfig {
    return {
      enabled: process.env.KAITEN_LOG_ENABLED !== 'false',
      level: (process.env.KAITEN_LOG_LEVEL as LogLevel) || LogLevel.ERROR,
      mcpEnabled: process.env.KAITEN_LOG_MCP_ENABLED === 'true',
      fileEnabled: process.env.KAITEN_LOG_FILE_ENABLED === 'true',
      requestsEnabled: process.env.KAITEN_LOG_REQUESTS === 'true',
      metricsEnabled: process.env.KAITEN_LOG_METRICS === 'true',
    };
  }

  // Check if level should be logged
  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false;
    const levels = Object.values(LogLevel);
    const configLevel = levels.indexOf(this.config.level);
    const messageLevel = levels.indexOf(level);
    return messageLevel >= configLevel;
  }

  // Generic log method
  private log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    // Add timestamp if not present
    if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }

    // Log to MCP client
    if (this.config.mcpEnabled) {
      this.mcpLogger.log(entry);
    }

    // Log to file
    if (this.config.fileEnabled && this.fileLogger) {
      this.fileLogger.log(entry);
    }
  }

  // Public API (convenience methods)
  debug(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.DEBUG, message, data, logger });
  }

  info(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.INFO, message, data, logger });
  }

  notice(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.NOTICE, message, data, logger });
  }

  warning(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.WARNING, message, data, logger });
  }

  error(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.ERROR, message, data, logger });
  }

  critical(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.CRITICAL, message, data, logger });
  }

  alert(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.ALERT, message, data, logger });
  }

  emergency(message: string, data?: Record<string, any>, logger?: string): void {
    this.log({ level: LogLevel.EMERGENCY, message, data, logger });
  }

  // Metrics API
  recordMetric(metric: PerformanceMetrics): void {
    if (this.config.metricsEnabled) {
      this.metricsCollector.record(metric);
    }
  }

  getMetrics() {
    return this.metricsCollector.getMetrics();
  }

  clearMetrics(): void {
    this.metricsCollector.clear();
  }

  exportMetricsCSV(): string {
    return this.metricsCollector.exportCSV();
  }

  // Expose MCP logger for server initialization
  getMCPLogger(): MCPLogger {
    return this.mcpLogger;
  }

  // Runtime config update (without restart)
  updateConfig(newConfig: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Reinitialize file logger if needed
    if (newConfig.fileEnabled !== undefined) {
      if (newConfig.fileEnabled && !this.fileLogger) {
        this.fileLogger = new FileLogger();
      } else if (!newConfig.fileEnabled && this.fileLogger) {
        this.fileLogger.close();
        this.fileLogger = null;
      }
    }

    // Update metrics collector if needed
    if (newConfig.metricsEnabled !== undefined) {
      this.metricsCollector = new MetricsCollector(newConfig.metricsEnabled);
    }

    this.info('Logging configuration updated', { config: this.config }, 'logger');
  }

  getConfig(): LoggerConfig {
    return { ...this.config };
  }
}

// Singleton instance
export const logger = new Logger();
