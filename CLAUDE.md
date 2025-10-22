# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server for Kaiten API integration. It provides 26 tools for managing Kaiten cards, comments, spaces, and boards directly from Claude Desktop. The server is production-ready with comprehensive logging, caching, retry logic, and concurrency control.

**Current Version:** 2.3.0

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Run in development mode with tsx
npm run dev

# Watch mode (rebuild on changes)
npm run watch

# Start compiled server
npm start

# Test with MCP Inspector
npm run inspector
```

## MCP I/O Protocol Requirements

**CRITICAL:** MCP uses stdio-transport for client-server communication:
- **stdout** - ONLY JSON-RPC protocol messages (must stay clean)
- **stderr** - All logs, debug info, errors

**Never use `console.log()` in this codebase** - it breaks the protocol. Always use:
- `safeLog.info()`, `safeLog.error()`, `safeLog.warn()`, `safeLog.debug()` from `src/config.ts`
- These wrappers redirect to stderr and include automatic token redaction

Reference: src/config.ts:126-152 implements the `safeLog` wrapper.

## Architecture Overview

### Core Components

1. **src/index.ts** (main MCP server)
   - Implements MCP Server with stdio transport
   - Defines 26 tool handlers (cards, comments, spaces, boards, cache, logging)
   - Implements MCP Resources (kaiten-card:///, kaiten-space:///, etc.)
   - Implements Server Prompts with usage instructions
   - Uses Zod schemas for all tool parameter validation

2. **src/kaiten-client.ts** (API client)
   - Axios-based HTTP client with retry logic (3 retries with exponential backoff)
   - p-queue for concurrency control (default: 5 concurrent requests)
   - Enhanced error handling with KaitenError class (categorized error types)
   - Idempotency key support for safe retries on mutations
   - Logging middleware integration for request/response tracking

3. **src/config.ts** (configuration & validation)
   - Zod-based runtime validation for all ENV variables
   - Validates API_URL format (must end with `/api/latest`)
   - Validates API_TOKEN length (min 20 chars)
   - `redactSecrets()` function - masks tokens in logs/errors
   - `safeLog` wrapper - stderr-safe logging that never touches stdout

4. **src/cache.ts** (LRU cache)
   - LRU cache with TTL for spaces, boards, users
   - Default: 100 items per cache type, 300s TTL
   - Automatic expiration checks
   - Cache statistics via `getStats()`

5. **src/schemas.ts** (Zod validation schemas)
   - 15+ Zod schemas for all tool parameters
   - VerbosityEnum: minimal | normal | debug
   - Idempotency key validation
   - Structured error responses

6. **src/logging/** (v2.3.0 logging system)
   - **logger.ts** - Unified singleton logger
   - **file-logger.ts** - Pino JSON file logging with secret redaction
   - **mcp-logger.ts** - MCP notifications/message logger
   - **metrics.ts** - Performance metrics collector (latency, success rate, cache hits)
   - **types.ts** - RFC 5424 log levels + TypeScript types

7. **src/middleware/logging-middleware.ts**
   - Axios interceptor for HTTP request/response logging
   - Automatic metrics recording for all API calls

### Key Design Patterns

**Default Space ID Pattern:**
- All card operations default to `KAITEN_DEFAULT_SPACE_ID` if set
- User must explicitly ask to search "in all spaces" to override
- See DEFAULT_SPACE_GUIDE.md for details

**Verbosity Control Pattern:**
- All read tools support `verbosity` parameter:
  - `minimal` - Only id + name/title (for lists)
  - `normal` - Simplified/essential fields (default)
  - `debug` - Full API response with all metadata
- Applied via `applyVerbosity()` helper in src/index.ts

**Idempotency Pattern:**
- Mutations (create_card, update_card, create_comment, update_comment) support `idempotency_key` parameter
- Client sends `Idempotency-Key` header to Kaiten API
- Prevents duplicate operations on retry

**Error Handling Pattern:**
- `KaitenError` class with categorized types: AUTH_ERROR, RATE_LIMITED, NOT_FOUND, TIMEOUT, VALIDATION_ERROR, API_ERROR, NETWORK_ERROR
- Each error includes `hint` field with actionable guidance
- All errors are JSON-serializable via `toJSON()`

**Helper Functions Pattern:**
- `simplifyUser()`, `simplifySpace()`, `simplifyCard()`, `simplifyComment()` in src/index.ts
- Reduce response sizes by 92-96% (removes base64 avatars, permissions, UI metadata)
- Enhanced `simplifyCard()` adds human-readable fields: board_title, column_title, owner_name, members

## Configuration

Required ENV variables (see .env.example):
```env
KAITEN_API_URL=https://your-domain.kaiten.ru/api/latest  # Must end with /api/latest
KAITEN_API_TOKEN=your_token_here                         # Min 20 chars
KAITEN_DEFAULT_SPACE_ID=12345                            # Optional, recommended
```

Optional performance tuning:
```env
KAITEN_MAX_CONCURRENT_REQUESTS=5    # 1-20, default: 5
KAITEN_CACHE_TTL_SECONDS=300        # 0 to disable, default: 300
KAITEN_REQUEST_TIMEOUT_MS=10000     # 1-60000, default: 10000
```

Logging configuration (v2.3.0):
```env
KAITEN_LOG_ENABLED=true                          # Master switch
KAITEN_LOG_LEVEL=error                           # debug|info|notice|warning|error|critical|alert|emergency
KAITEN_LOG_MCP_ENABLED=false                     # Send logs to MCP client
KAITEN_LOG_FILE_ENABLED=false                    # Write to logs/kaiten-mcp.log
KAITEN_LOG_FILE_PATH=./logs/kaiten-mcp.log       # Log file location
KAITEN_LOG_REQUESTS=false                        # Log all HTTP requests
KAITEN_LOG_METRICS=false                         # Collect performance metrics
```

**Ready-made profiles** (see README.md line 362-386):
- Production: errors only, no files
- Development: info level, files + metrics
- Debug: full logging (debug + MCP + files + requests + metrics)

## Adding New Tools

When adding a new MCP tool:

1. **Define Zod schema** in src/schemas.ts
   ```typescript
   export const MyToolSchema = z.object({
     param: z.number().describe("Parameter description")
   });
   ```

2. **Add to KaitenClient** (if new API call needed) in src/kaiten-client.ts
   ```typescript
   async myMethod(param: number): Promise<Result> {
     return this.queuedRequest<Result>('/endpoint', {
       method: 'POST',
       data: { param }
     });
   }
   ```

3. **Register tool** in src/index.ts
   - Add to `tools` array in ListToolsRequest handler
   - Add case to CallToolRequest handler with Zod validation
   - Use `simplify*()` helpers to reduce response size
   - Apply verbosity if it's a read operation

4. **Update documentation**
   - Increment tool count in package.json, README.md, CHANGELOG.md
   - Add to TOOLS.md if it exists

## Testing with MCP Inspector

```bash
npm run build
npm run inspector
```

MCP Inspector provides:
- Tool testing UI
- Request/response inspection
- Resource browser
- Prompt testing

## Common Pitfalls

1. **Never write to stdout directly** - Use safeLog.* functions
2. **Always simplify responses** - Use helper functions to avoid "Tool result is too large"
3. **Default space ID** - Remember all operations default to KAITEN_DEFAULT_SPACE_ID
4. **Condition parameter** - Cards default to condition=1 (active), user must explicitly request condition=2 (archived)
5. **Board справочники** - Use kaiten_list_columns/lanes/types to get valid IDs before creating/updating cards
6. **Secrets in logs** - All token redaction is automatic via `redactSecrets()` in config.ts

## Deployment to Claude Desktop

1. Build: `npm run build`
2. Configure Claude Desktop's `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "kaiten": {
         "command": "node",
         "args": ["/full/path/to/MCP Kaiten/dist/index.js"],
         "cwd": "/full/path/to/MCP Kaiten"
       }
     }
   }
   ```
3. Restart Claude Desktop completely (⌘+Q / Alt+F4)

## Key Files Reference

- **CHANGELOG.md** - Complete version history with detailed changes
- **TOOLS.md** - Full reference for all 26 tools
- **DEFAULT_SPACE_GUIDE.md** - Default space behavior documentation
- **LOGGING_IMPLEMENTATION_PLAN.md** - v2.3.0 logging architecture
- **.env.example** - All ENV variables with profiles
