import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { default as PQueue } from 'p-queue';
import { randomBytes } from 'crypto';
import { config, safeLog } from './config.js';
import { logger } from './logging/index.js';
import { setupLoggingMiddleware } from './middleware/logging-middleware.js';

// ============================================
// ENHANCED ERROR TYPES
// ============================================

export enum KaitenErrorType {
  AUTH_ERROR = 'AUTH_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_FOUND = 'NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  API_ERROR = 'API_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export class KaitenError extends Error {
  constructor(
    public type: KaitenErrorType,
    message: string,
    public status?: number,
    public details?: any,
    public hint?: string
  ) {
    super(message);
    this.name = 'KaitenError';
  }

  toJSON() {
    return {
      type: this.type,
      message: this.message,
      status: this.status,
      details: this.details,
      hint: this.hint,
    };
  }
}

// ============================================
// ENHANCED TYPES
// ============================================

export interface KaitenUser {
  id: number;
  full_name: string;
  email?: string;
  username?: string;
  activated?: boolean;
}

export interface KaitenBoard {
  id: number;
  title: string;
  space_id?: number;
  archived?: boolean;
}

export interface KaitenColumn {
  id: number;
  title: string;
}

export interface KaitenLane {
  id: number;
  title: string;
}

export interface KaitenType {
  id: number;
  name: string;
}

export interface KaitenTag {
  name: string;
}

export interface KaitenBlocker {
  reason?: string;
  created?: string;
  blocker?: {
    full_name: string;
  };
}

export interface KaitenCard {
  id: number;
  title: string;
  description?: string;
  state?: number;
  board_id?: number;
  column_id?: number;
  lane_id?: number;
  position?: number;
  type_id?: number;
  size?: number;
  asap?: boolean;
  blocked?: boolean;
  blocked_by_id?: number;
  due_date?: string;
  owner_id?: number;
  created?: string;
  updated?: string;
  archived?: string | null;
  space_id?: number;
  board?: KaitenBoard;
  owner?: KaitenUser;
  column?: KaitenColumn;
  lane?: KaitenLane;
  type?: KaitenType;
  tags?: KaitenTag[];
  members?: KaitenUser[];
  blockers?: KaitenBlocker[];
  comments_total?: number;
  comment_last_added_at?: string;
  properties?: Record<string, any>;
  custom_fields?: Record<string, any>;
  // Card relationships (counts from API)
  parents_count?: number;
  children_count?: number;
  children_done?: number;
  // Populated by additional requests
  parent_cards?: KaitenCard[];
  children_cards?: KaitenCard[];
}

export interface KaitenComment {
  id: number;
  card_id: number;
  author_id?: number;
  author?: KaitenUser;
  text: string;
  created: string;
  updated?: string;
}

export interface KaitenSpace {
  id: number;
  title: string;
  description?: string;
  archived?: boolean;
  boards?: KaitenBoard[];
}

export interface CreateCardParams {
  title: string;
  board_id: number;
  column_id?: number;
  lane_id?: number;
  description?: string;
  type_id?: number;
  size?: number;
  asap?: boolean;
  owner_id?: number;
  due_date?: string;
  custom_fields?: Record<string, any>;
  idempotency_key?: string;
}

export interface UpdateCardParams {
  title?: string;
  description?: string;
  state?: number;
  column_id?: number;
  lane_id?: number;
  type_id?: number;
  size?: number;
  asap?: boolean;
  owner_id?: number;
  due_date?: string;
  custom_fields?: Record<string, any>;
  idempotency_key?: string;
}

// ============================================
// KAITEN CLIENT WITH RETRY/BACKOFF/CONCURRENCY
// ============================================

export class KaitenClient {
  private client: AxiosInstance;
  private queue: PQueue;

  // Helper to generate idempotency key
  private generateIdempotencyKey(): string {
    return `mcp-${Date.now()}-${randomBytes(8).toString('hex')}`;
  }

  constructor(apiUrl: string, apiToken: string) {
    // Create axios instance with timeout
    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mcp-kaiten/2.2.0 (+https://github.com/yourusername/mcp-kaiten)',
      },
      timeout: config.KAITEN_REQUEST_TIMEOUT_MS,
    });

    // Configure axios-retry with exponential backoff
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: (retryCount, error) => {
        // Check for Retry-After header
        const retryAfter = error.response?.headers['retry-after'];
        if (retryAfter) {
          const seconds = parseInt(retryAfter, 10);
          if (!isNaN(seconds)) {
            safeLog.warn(`Rate limited. Waiting ${seconds}s as per Retry-After header.`);
            return seconds * 1000;
          }
        }

        // Exponential backoff with jitter: base_delay * (2^retryCount) + jitter
        const baseDelay = 1000; // 1 second
        const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);
        const jitter = Math.random() * 500; // 0-500ms jitter
        return exponentialDelay + jitter;
      },
      retryCondition: (error: AxiosError) => {
        // Retry on network errors or specific HTTP status codes
        if (!error.response) {
          return true; // Network error
        }

        const status = error.response.status;

        // Retry on 429 (rate limit), 5xx (server errors), 408 (timeout)
        if (status === 429 || status === 408 || (status >= 500 && status < 600)) {
          safeLog.warn(`Retrying request due to status ${status}`);
          return true;
        }

        return false;
      },
      onRetry: (retryCount, error, requestConfig) => {
        safeLog.warn(
          `Retry attempt ${retryCount} for ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`
        );
      },
    });

    // Add response interceptor for enhanced error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        throw this.handleAxiosError(error);
      }
    );

    // Setup logging middleware
    setupLoggingMiddleware(this.client);

    // Initialize concurrency queue
    this.queue = new PQueue({
      concurrency: config.KAITEN_MAX_CONCURRENT_REQUESTS,
      interval: 1000, // 1 second interval
      intervalCap: config.KAITEN_MAX_CONCURRENT_REQUESTS, // Max requests per interval
    });

    safeLog.info(
      `KaitenClient initialized with ${config.KAITEN_MAX_CONCURRENT_REQUESTS} max concurrent requests`
    );

    logger.info('KaitenClient initialized', {
      max_concurrent: config.KAITEN_MAX_CONCURRENT_REQUESTS,
      cache_ttl: config.KAITEN_CACHE_TTL_SECONDS,
      timeout: config.KAITEN_REQUEST_TIMEOUT_MS,
    }, 'kaiten-client');
  }

  // Enhanced error handler
  private handleAxiosError(error: AxiosError): KaitenError {
    // Timeout error
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new KaitenError(
        KaitenErrorType.TIMEOUT,
        `Request timeout after ${config.KAITEN_REQUEST_TIMEOUT_MS}ms`,
        undefined,
        { code: error.code },
        'Try reducing the limit parameter or specifying a more specific board_id/space_id'
      );
    }

    // Network error (no response from server)
    if (!error.response) {
      return new KaitenError(
        KaitenErrorType.NETWORK_ERROR,
        error.message || 'Network error occurred',
        undefined,
        { code: error.code },
        'Check your internet connection and API URL configuration'
      );
    }

    const status = error.response.status;
    const data = error.response.data;

    // Map status codes to error types
    const errorMap: Record<number, [KaitenErrorType, string, string]> = {
      401: [KaitenErrorType.AUTH_ERROR, 'Authentication failed', 'Check your KAITEN_API_TOKEN in .env file'],
      403: [KaitenErrorType.AUTH_ERROR, 'Insufficient permissions', 'Your API token does not have permission to perform this action'],
      404: [KaitenErrorType.NOT_FOUND, 'Resource not found', 'Check that the card_id, board_id, space_id, or other resource ID is correct'],
      422: [KaitenErrorType.VALIDATION_ERROR, 'Validation error', 'Check the request parameters for correctness'],
    };

    if (errorMap[status]) {
      const [type, message, hint] = errorMap[status];
      return new KaitenError(type, message, status, data, hint);
    }

    // 429 Rate limit (special handling for retry-after)
    if (status === 429) {
      const retryAfter = error.response.headers['retry-after'] || 'unknown';
      return new KaitenError(
        KaitenErrorType.RATE_LIMITED,
        'Rate limit exceeded',
        status,
        { ...(typeof data === 'object' && data !== null ? data : {}), retry_after: retryAfter },
        'Reduce the frequency of requests or decrease the limit parameter'
      );
    }

    // 5xx Server errors
    if (status >= 500 && status < 600) {
      return new KaitenError(
        KaitenErrorType.API_ERROR,
        'Kaiten server error',
        status,
        data,
        'The Kaiten API is experiencing issues. Try again later.'
      );
    }

    // Generic API error
    return new KaitenError(
      KaitenErrorType.API_ERROR,
      error.message || 'API request failed',
      status,
      data,
      undefined
    );
  }

  // Wrap all requests with queue for concurrency control
  private async queuedRequest<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // If signal is already aborted, throw immediately
    if (signal?.aborted) {
      throw new KaitenError(
        KaitenErrorType.UNKNOWN_ERROR,
        'Request aborted before execution',
        undefined,
        { code: 'ABORTED' },
        'The operation was cancelled by the client'
      );
    }

    // Add task to queue with signal support
    return this.queue.add(
      async ({ signal: queueSignal }: { signal?: AbortSignal } = {}) => {
        // Use external signal if provided, otherwise use queue's signal
        const effectiveSignal = signal || queueSignal;

        // Check again before executing
        if (effectiveSignal?.aborted) {
          throw new KaitenError(
            KaitenErrorType.UNKNOWN_ERROR,
            'Request aborted',
            undefined,
            { code: 'ABORTED' },
            'The operation was cancelled'
          );
        }

        return fn();
      },
      { signal } // Pass signal to p-queue for cancellation support
    ) as Promise<T>;
  }

  // Card operations
  async getCard(cardId: number, signal?: AbortSignal): Promise<KaitenCard> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/cards/${cardId}`, { signal });
      return response.data;
    }, signal);
  }

  async createCard(params: CreateCardParams, signal?: AbortSignal): Promise<KaitenCard> {
    return this.queuedRequest(async () => {
      const { idempotency_key, ...cardData } = params;
      // Auto-generate idempotency key if not provided
      const key = idempotency_key || this.generateIdempotencyKey();
      const headers = { 'Idempotency-Key': key };
      const response = await this.client.post('/cards', cardData, { headers, signal });
      return response.data;
    }, signal);
  }

  async updateCard(cardId: number, params: UpdateCardParams, signal?: AbortSignal): Promise<KaitenCard> {
    return this.queuedRequest(async () => {
      const { idempotency_key, ...cardData } = params;
      // Auto-generate idempotency key if not provided
      const key = idempotency_key || this.generateIdempotencyKey();
      const headers = { 'Idempotency-Key': key };
      const response = await this.client.patch(`/cards/${cardId}`, cardData, { headers, signal });
      return response.data;
    }, signal);
  }

  async deleteCard(cardId: number, signal?: AbortSignal): Promise<void> {
    return this.queuedRequest(async () => {
      await this.client.delete(`/cards/${cardId}`, { signal });
    }, signal);
  }

  // Get cards from a board
  async getCardsFromBoard(
    boardId: number,
    limit: number = 10,
    skip: number = 0,
    condition: number = 1,
    signal?: AbortSignal
  ): Promise<KaitenCard[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(
        `/boards/${boardId}/cards?limit=${limit}&skip=${skip}&sort_by=created&sort_direction=desc&condition=${condition}`,
        { signal }
      );
      return response.data;
    }, signal);
  }

  // Get cards from a space
  async getCardsFromSpace(
    spaceId: number,
    limit: number = 10,
    skip: number = 0,
    condition: number = 1,
    signal?: AbortSignal
  ): Promise<KaitenCard[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(
        `/spaces/${spaceId}/cards?limit=${limit}&skip=${skip}&sort_by=created&sort_direction=desc&condition=${condition}`,
        { signal }
      );
      return response.data;
    }, signal);
  }

  // Search cards (using filters)
  async searchCards(params: {
    // Text search
    query?: string;
    title?: string;

    // Basic filters
    space_id?: number;
    board_id?: number;
    column_id?: number;
    lane_id?: number;
    state?: number;
    owner_id?: number;
    type_id?: number;
    condition?: number;

    // Date filters
    created_before?: string;
    created_after?: string;
    updated_before?: string;
    updated_after?: string;
    due_date_before?: string;
    due_date_after?: string;
    last_moved_to_done_at_before?: string;
    last_moved_to_done_at_after?: string;

    // Boolean flags
    asap?: boolean;
    archived?: boolean;
    overdue?: boolean;
    done_on_time?: boolean;
    with_due_date?: boolean;

    // Multiple IDs (comma-separated)
    owner_ids?: string;
    member_ids?: string;
    column_ids?: string;
    type_ids?: string;
    tag_ids?: string;

    // Exclude filters
    exclude_board_ids?: string;
    exclude_owner_ids?: string;
    exclude_card_ids?: string;

    // Sorting and pagination
    sort_by?: string;
    sort_direction?: string;
    limit?: number;
    skip?: number;
  }, signal?: AbortSignal): Promise<KaitenCard[]> {
    return this.queuedRequest(async () => {
      const queryParams = new URLSearchParams();

      // Set default limit if not provided
      const limit = params.limit || 10;
      const skip = params.skip || 0;

      queryParams.append('limit', limit.toString());
      queryParams.append('skip', skip.toString());

      // Sort by created date, newest first (default)
      const sortBy = params.sort_by || 'created';
      const sortDirection = params.sort_direction || 'desc';
      queryParams.append('sort_by', sortBy);
      queryParams.append('sort_direction', sortDirection);

      // Add all other parameters (exclude already processed ones)
      Object.entries(params).forEach(([key, value]) => {
        if (
          value !== undefined &&
          key !== 'limit' &&
          key !== 'skip' &&
          key !== 'sort_by' &&
          key !== 'sort_direction'
        ) {
          queryParams.append(key, value.toString());
        }
      });

      const response = await this.client.get(`/cards?${queryParams.toString()}`, { signal });
      return response.data;
    }, signal);
  }

  // Comment operations
  async getCardComments(cardId: number, signal?: AbortSignal): Promise<KaitenComment[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/cards/${cardId}/comments`, { signal });
      return response.data;
    }, signal);
  }

  async createComment(cardId: number, text: string, idempotencyKey?: string, signal?: AbortSignal): Promise<KaitenComment> {
    return this.queuedRequest(async () => {
      // Auto-generate idempotency key if not provided
      const key = idempotencyKey || this.generateIdempotencyKey();
      const headers = { 'Idempotency-Key': key };
      const response = await this.client.post(`/cards/${cardId}/comments`, { text }, { headers, signal });
      return response.data;
    }, signal);
  }

  async updateComment(cardId: number, commentId: number, text: string, idempotencyKey?: string, signal?: AbortSignal): Promise<KaitenComment> {
    return this.queuedRequest(async () => {
      // Auto-generate idempotency key if not provided
      const key = idempotencyKey || this.generateIdempotencyKey();
      const headers = { 'Idempotency-Key': key };
      const response = await this.client.patch(`/cards/${cardId}/comments/${commentId}`, { text }, { headers, signal });
      return response.data;
    }, signal);
  }

  async deleteComment(cardId: number, commentId: number, signal?: AbortSignal): Promise<void> {
    return this.queuedRequest(async () => {
      await this.client.delete(`/cards/${cardId}/comments/${commentId}`, { signal });
    }, signal);
  }

  // Card relationships
  async getCardChildren(cardId: number, signal?: AbortSignal): Promise<KaitenCard[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/cards/${cardId}/children`, { signal });
      return response.data;
    }, signal);
  }

  // Space operations
  async getSpaces(signal?: AbortSignal): Promise<KaitenSpace[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get('/spaces', { signal });
      return response.data;
    }, signal);
  }

  async getSpace(spaceId: number, signal?: AbortSignal): Promise<KaitenSpace> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/spaces/${spaceId}`, { signal });
      return response.data;
    }, signal);
  }

  // Board operations
  async getBoards(spaceId: number, signal?: AbortSignal): Promise<KaitenBoard[]> {
    return this.queuedRequest(async () => {
      // spaceId is now required - Kaiten API doesn't support /boards without space_id
      const response = await this.client.get(`/spaces/${spaceId}/boards`, { signal });
      return response.data;
    }, signal);
  }

  async getBoard(boardId: number, signal?: AbortSignal): Promise<KaitenBoard> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/boards/${boardId}`, { signal });
      return response.data;
    }, signal);
  }

  // Board справочники (columns, lanes, types)
  async getColumns(boardId: number, signal?: AbortSignal): Promise<KaitenColumn[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/boards/${boardId}/columns`, { signal });
      return response.data;
    }, signal);
  }

  async getLanes(boardId: number, signal?: AbortSignal): Promise<KaitenLane[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/boards/${boardId}/lanes`, { signal });
      return response.data;
    }, signal);
  }

  async getTypes(boardId: number, signal?: AbortSignal): Promise<KaitenType[]> {
    return this.queuedRequest(async () => {
      const response = await this.client.get(`/boards/${boardId}/card_types`, { signal });
      return response.data;
    }, signal);
  }

  // User operations
  async getCurrentUser(signal?: AbortSignal): Promise<KaitenUser> {
    return this.queuedRequest(async () => {
      const response = await this.client.get('/users/current', { signal });
      return response.data;
    }, signal);
  }

  async getUsers(params?: {
    query?: string;
    limit?: number;
    offset?: number;
  }, signal?: AbortSignal): Promise<KaitenUser[]> {
    return this.queuedRequest(async () => {
      // Use /users endpoint with server-side filtering support
      // According to Kaiten API docs, /users supports query, limit, and offset parameters
      const queryParams: any = {};

      if (params?.query) {
        queryParams.query = params.query;
      }

      if (params?.limit !== undefined) {
        queryParams.limit = params.limit;
      }

      if (params?.offset !== undefined) {
        queryParams.offset = params.offset;
      }

      const response = await this.client.get('/users', {
        params: queryParams,
        signal
      });
      return response.data;
    }, signal);
  }

  // Queue status (for debugging)
  getQueueStatus() {
    return {
      pending: this.queue.pending,
      size: this.queue.size,
      concurrency: this.queue.concurrency,
    };
  }
}
