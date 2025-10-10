import { z } from 'zod';
import dotenv from 'dotenv';

// Disable dotenv promotional messages for MCP compatibility (stdout must be clean JSON-RPC only)
process.env.DOTENV_CONFIG_QUIET = '1';
dotenv.config();

// Zod schema for environment variables
const EnvSchema = z.object({
  KAITEN_API_URL: z
    .string()
    .url('KAITEN_API_URL must be a valid URL')
    .refine(
      (url) => url.endsWith('/api/latest'),
      'KAITEN_API_URL must end with /api/latest'
    )
    .describe('Kaiten API base URL'),

  KAITEN_API_TOKEN: z
    .string()
    .min(20, 'KAITEN_API_TOKEN appears to be too short (minimum 20 characters)')
    .describe('Kaiten API authentication token'),

  KAITEN_DEFAULT_SPACE_ID: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .refine(
      (val) => val === undefined || (!isNaN(val) && val > 0),
      'KAITEN_DEFAULT_SPACE_ID must be a positive integer'
    )
    .describe('Default space ID for operations'),

  KAITEN_MAX_CONCURRENT_REQUESTS: z
    .string()
    .optional()
    .default('5')
    .transform((val) => parseInt(val, 10))
    .refine(
      (val) => !isNaN(val) && val > 0 && val <= 20,
      'KAITEN_MAX_CONCURRENT_REQUESTS must be between 1 and 20'
    )
    .describe('Maximum concurrent API requests'),

  KAITEN_CACHE_TTL_SECONDS: z
    .string()
    .optional()
    .default('300')
    .transform((val) => parseInt(val, 10))
    .refine(
      (val) => !isNaN(val) && val >= 0,
      'KAITEN_CACHE_TTL_SECONDS must be a non-negative integer'
    )
    .describe('Cache TTL in seconds (0 to disable)'),

  KAITEN_REQUEST_TIMEOUT_MS: z
    .string()
    .optional()
    .default('10000')
    .transform((val) => parseInt(val, 10))
    .refine(
      (val) => !isNaN(val) && val > 0 && val <= 60000,
      'KAITEN_REQUEST_TIMEOUT_MS must be between 1 and 60000'
    )
    .describe('Request timeout in milliseconds'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

// Validate and parse environment variables
function loadConfig(): EnvConfig {
  const result = EnvSchema.safeParse({
    KAITEN_API_URL: process.env.KAITEN_API_URL,
    KAITEN_API_TOKEN: process.env.KAITEN_API_TOKEN,
    KAITEN_DEFAULT_SPACE_ID: process.env.KAITEN_DEFAULT_SPACE_ID,
    KAITEN_MAX_CONCURRENT_REQUESTS: process.env.KAITEN_MAX_CONCURRENT_REQUESTS,
    KAITEN_CACHE_TTL_SECONDS: process.env.KAITEN_CACHE_TTL_SECONDS,
    KAITEN_REQUEST_TIMEOUT_MS: process.env.KAITEN_REQUEST_TIMEOUT_MS,
  });

  if (!result.success) {
    const errors = result.error.errors.map(
      (err) => `  - ${err.path.join('.')}: ${err.message}`
    );

    console.error('❌ Invalid environment configuration:');
    console.error(errors.join('\n'));
    console.error('\n💡 Please check your .env file and ensure all required variables are set correctly.');
    console.error('   Required: KAITEN_API_URL, KAITEN_API_TOKEN');
    console.error('   Optional: KAITEN_DEFAULT_SPACE_ID, KAITEN_MAX_CONCURRENT_REQUESTS, KAITEN_CACHE_TTL_SECONDS, KAITEN_REQUEST_TIMEOUT_MS');

    process.exit(1);
  }

  return result.data;
}

// Export validated config
export const config = loadConfig();

// Helper function to redact sensitive data in logs
export function redactSecrets(text: string): string {
  if (!text) return text;

  const token = config.KAITEN_API_TOKEN;
  if (!token) return text;

  // Redact full token
  let redacted = text.replace(new RegExp(token, 'g'), '***REDACTED_TOKEN***');

  // Redact partial token in Authorization headers
  const tokenPrefix = token.substring(0, 8);
  const tokenSuffix = token.substring(token.length - 4);
  redacted = redacted.replace(
    new RegExp(`${tokenPrefix}[\\w\\-]+${tokenSuffix}`, 'g'),
    '***REDACTED_TOKEN***'
  );

  // Redact any Bearer tokens in general
  redacted = redacted.replace(/Bearer\s+[\w\-\.]+/gi, 'Bearer ***REDACTED_TOKEN***');

  return redacted;
}

// Safe logging functions - ALL LOGS GO TO STDERR for MCP compatibility
export const safeLog = {
  info: (message: string, ...args: any[]) => {
    console.error(redactSecrets(message), ...args.map(arg =>
      typeof arg === 'string' ? redactSecrets(arg) : arg
    ));
  },

  error: (message: string, ...args: any[]) => {
    console.error(redactSecrets(message), ...args.map(arg =>
      typeof arg === 'string' ? redactSecrets(arg) : arg
    ));
  },

  warn: (message: string, ...args: any[]) => {
    console.error(redactSecrets(message), ...args.map(arg =>
      typeof arg === 'string' ? redactSecrets(arg) : arg
    ));
  },

  debug: (message: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.error(redactSecrets(message), ...args.map(arg =>
        typeof arg === 'string' ? redactSecrets(arg) : arg
      ));
    }
  },
};

// Log config on startup (with secrets redacted)
safeLog.info('✅ Configuration loaded successfully');
safeLog.info(`   API URL: ${config.KAITEN_API_URL}`);
safeLog.info(`   Default Space ID: ${config.KAITEN_DEFAULT_SPACE_ID || 'not set'}`);
safeLog.info(`   Max Concurrent Requests: ${config.KAITEN_MAX_CONCURRENT_REQUESTS}`);
safeLog.info(`   Cache TTL: ${config.KAITEN_CACHE_TTL_SECONDS}s`);
safeLog.info(`   Request Timeout: ${config.KAITEN_REQUEST_TIMEOUT_MS}ms`);
