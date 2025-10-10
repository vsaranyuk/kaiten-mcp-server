import { LRUCache } from 'lru-cache';
import { config, safeLog } from './config.js';
import type { KaitenSpace, KaitenBoard, KaitenUser } from './kaiten-client.js';

// ============================================
// LRU CACHE WITH TTL
// ============================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class KaitenCache {
  private spaces: LRUCache<string, CacheEntry<KaitenSpace[]>>;
  private boards: LRUCache<string, CacheEntry<KaitenBoard[]>>;
  private users: LRUCache<string, CacheEntry<KaitenUser[]>>;
  private ttlMs: number;
  private enabled: boolean;

  constructor() {
    this.ttlMs = config.KAITEN_CACHE_TTL_SECONDS * 1000;
    this.enabled = config.KAITEN_CACHE_TTL_SECONDS > 0;

    // Initialize LRU caches
    const cacheOptions = {
      max: 100, // Maximum number of items in cache
      ttl: this.ttlMs, // Time to live in milliseconds
      updateAgeOnGet: false, // Don't reset TTL on get
      updateAgeOnHas: false,
    };

    this.spaces = new LRUCache<string, CacheEntry<KaitenSpace[]>>(cacheOptions);
    this.boards = new LRUCache<string, CacheEntry<KaitenBoard[]>>(cacheOptions);
    this.users = new LRUCache<string, CacheEntry<KaitenUser[]>>(cacheOptions);

    if (this.enabled) {
      safeLog.info(
        `✅ Cache enabled with TTL ${config.KAITEN_CACHE_TTL_SECONDS}s (max 100 items per type)`
      );
    } else {
      safeLog.info('⚠️  Cache disabled (TTL = 0)');
    }
  }

  // ============================================
  // SPACES CACHE
  // ============================================

  getSpaces(): KaitenSpace[] | null {
    if (!this.enabled) return null;

    const entry = this.spaces.get('all');
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.spaces.delete('all');
      return null;
    }

    safeLog.debug('✅ Cache hit: spaces');
    return entry.data;
  }

  setSpaces(data: KaitenSpace[]): void {
    if (!this.enabled) return;

    this.spaces.set('all', {
      data,
      timestamp: Date.now(),
    });
    safeLog.debug(`📦 Cached spaces: ${data.length} items`);
  }

  getSpace(spaceId: number): KaitenSpace | null {
    if (!this.enabled) return null;

    const key = `space:${spaceId}`;
    const entry = this.spaces.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.spaces.delete(key);
      return null;
    }

    safeLog.debug(`✅ Cache hit: space ${spaceId}`);
    return entry.data[0]; // Single space stored as array
  }

  setSpace(spaceId: number, data: KaitenSpace): void {
    if (!this.enabled) return;

    const key = `space:${spaceId}`;
    this.spaces.set(key, {
      data: [data],
      timestamp: Date.now(),
    });
    safeLog.debug(`📦 Cached space: ${spaceId}`);
  }

  // ============================================
  // BOARDS CACHE
  // ============================================

  getBoards(spaceId?: number): KaitenBoard[] | null {
    if (!this.enabled) return null;

    const key = spaceId ? `space:${spaceId}` : 'all';
    const entry = this.boards.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.boards.delete(key);
      return null;
    }

    safeLog.debug(`✅ Cache hit: boards (${key})`);
    return entry.data;
  }

  setBoards(data: KaitenBoard[], spaceId?: number): void {
    if (!this.enabled) return;

    const key = spaceId ? `space:${spaceId}` : 'all';
    this.boards.set(key, {
      data,
      timestamp: Date.now(),
    });
    safeLog.debug(`📦 Cached boards: ${data.length} items (${key})`);
  }

  getBoard(boardId: number): KaitenBoard | null {
    if (!this.enabled) return null;

    const key = `board:${boardId}`;
    const entry = this.boards.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.boards.delete(key);
      return null;
    }

    safeLog.debug(`✅ Cache hit: board ${boardId}`);
    return entry.data[0]; // Single board stored as array
  }

  setBoard(boardId: number, data: KaitenBoard): void {
    if (!this.enabled) return;

    const key = `board:${boardId}`;
    this.boards.set(key, {
      data: [data],
      timestamp: Date.now(),
    });
    safeLog.debug(`📦 Cached board: ${boardId}`);
  }

  // ============================================
  // USERS CACHE
  // ============================================

  getUsers(): KaitenUser[] | null {
    if (!this.enabled) return null;

    const entry = this.users.get('all');
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.users.delete('all');
      return null;
    }

    safeLog.debug('✅ Cache hit: users');
    return entry.data;
  }

  setUsers(data: KaitenUser[]): void {
    if (!this.enabled) return;

    this.users.set('all', {
      data,
      timestamp: Date.now(),
    });
    safeLog.debug(`📦 Cached users: ${data.length} items`);
  }

  // ============================================
  // INVALIDATION
  // ============================================

  invalidateSpaces(): void {
    this.spaces.clear();
    safeLog.info('🗑️  Invalidated spaces cache');
  }

  invalidateBoards(): void {
    this.boards.clear();
    safeLog.info('🗑️  Invalidated boards cache');
  }

  invalidateUsers(): void {
    this.users.clear();
    safeLog.info('🗑️  Invalidated users cache');
  }

  invalidateAll(): void {
    this.spaces.clear();
    this.boards.clear();
    this.users.clear();
    safeLog.info('🗑️  Invalidated all caches');
  }

  // ============================================
  // HELPERS
  // ============================================

  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() - entry.timestamp > this.ttlMs;
  }

  getStats() {
    return {
      enabled: this.enabled,
      ttl_seconds: config.KAITEN_CACHE_TTL_SECONDS,
      spaces: {
        size: this.spaces.size,
        max: this.spaces.max,
      },
      boards: {
        size: this.boards.size,
        max: this.boards.max,
      },
      users: {
        size: this.users.size,
        max: this.users.max,
      },
    };
  }
}

// Export singleton instance
export const cache = new KaitenCache();
