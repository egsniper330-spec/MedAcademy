/**
 * searchProvider.ts
 * Search Provider Interface
 * Current: PostgreSQL full-text search
 * Future: Meilisearch, Typesense, Elasticsearch, Algolia
 */

export interface SearchResult<T = Record<string, unknown>> {
  id: string;
  score?: number;
  item: T;
  highlights?: Record<string, string[]>;
}

export interface SearchQuery {
  q: string;
  index: string;
  filters?: Record<string, unknown>;
  facets?: string[];
  sort?: Array<{ field: string; order: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

export interface SearchResponse<T = Record<string, unknown>> {
  hits: SearchResult<T>[];
  total: number;
  processingTimeMs?: number;
  facets?: Record<string, Record<string, number>>;
}

export interface SearchProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Perform a search query */
  search<T>(query: SearchQuery): Promise<SearchResponse<T>>;

  /** Get autocomplete suggestions */
  suggest(index: string, prefix: string, limit?: number): Promise<string[]>;

  /** Index a document */
  indexDocument(index: string, id: string, document: Record<string, unknown>): Promise<void>;

  /** Index multiple documents */
  indexDocuments(index: string, documents: Array<{ id: string } & Record<string, unknown>>): Promise<void>;

  /** Delete a document from the index */
  deleteDocument(index: string, id: string): Promise<void>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
