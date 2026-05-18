/**
 * @gaby/sdk — Memory adapter interface.
 * Allows custom memory backends (e.g. Redis, PostgreSQL, Pinecone).
 */

export interface MemoryEntry {
  id: string;
  userId: number;
  projectId?: number;
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryAdapter {
  /** Store a memory entry */
  store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>;

  /** Retrieve a memory entry by key */
  get(userId: number, key: string): Promise<MemoryEntry | null>;

  /** Search memories by semantic similarity */
  search(userId: number, query: string, limit?: number): Promise<MemorySearchResult[]>;

  /** List recent memories for a user/project */
  list(userId: number, projectId?: number, limit?: number): Promise<MemoryEntry[]>;

  /** Delete a memory entry */
  delete(id: string): Promise<boolean>;

  /** Delete all memories for a user */
  clear(userId: number): Promise<void>;
}

/**
 * Create a memory adapter implementation.
 * Useful for swapping the default SQLite backend with a custom one.
 */
export function createMemoryAdapter(adapter: MemoryAdapter): MemoryAdapter {
  return adapter;
}
