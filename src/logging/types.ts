// RFC 5424 log levels
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  NOTICE = 'notice',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
  ALERT = 'alert',
  EMERGENCY = 'emergency'
}

// Log entry structure
export interface LogEntry {
  level: LogLevel;
  message: string;
  logger?: string;
  timestamp?: string;
  data?: Record<string, any>;
}

// Metrics structure
export interface PerformanceMetrics {
  tool: string;
  latency_ms: number;
  success: boolean;
  timestamp: string;
  cache_hit?: boolean;
  queue_wait_ms?: number;
  error?: string;
}

// Logger configuration
export interface LoggerConfig {
  enabled: boolean;
  level: LogLevel;
  mcpEnabled: boolean;
  fileEnabled: boolean;
  requestsEnabled: boolean;
  metricsEnabled: boolean;
}
