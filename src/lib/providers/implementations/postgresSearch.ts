/**
 * implementations/postgresSearch.ts
 * PostgreSQL full-text search implementation of SearchProvider.
 */
import { supabase } from '@/client/supabase';
import type { SearchProvider, SearchQuery, SearchResponse, SearchResult } from '../searchProvider';

// Map index names to Supabase table + searchable columns
const INDEX_MAP: Record<string, { table: string; columns: string[] }> = {
  courses:  { table: 'courses',  columns: ['title', 'description'] },
  lessons:  { table: 'lessons',  columns: ['title', 'description'] },
  users:    { table: 'profiles', columns: ['full_name', 'email'] },
  doctors:  { table: 'profiles', columns: ['full_name', 'email', 'specialty'] },
};

class PostgresSearchProvider implements SearchProvider {
  readonly providerKey = 'postgres_search';
  readonly displayName = 'PostgreSQL Search';

  async search<T>(query: SearchQuery): Promise<SearchResponse<T>> {
    const mapping = INDEX_MAP[query.index];
    if (!mapping) return { hits: [], total: 0 };

    const tsQuery = query.q.trim().split(/\s+/).join(' & ');
    let builder = supabase
      .from(mapping.table)
      .select('*', { count: 'exact' })
      .textSearch(mapping.columns[0], tsQuery, { type: 'websearch', config: 'english' })
      .range(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 20) - 1);

    if (query.filters) {
      for (const [k, v] of Object.entries(query.filters)) {
        builder = builder.eq(k, v as any);
      }
    }

    const { data, count, error } = await builder;
    if (error) throw new Error(`Search failed: ${error.message}`);

    const hits: SearchResult<T>[] = (data ?? []).map((item: any) => ({
      id: item.id,
      item: item as T,
    }));

    return { hits, total: count ?? hits.length };
  }

  async suggest(index: string, prefix: string, limit = 5): Promise<string[]> {
    const mapping = INDEX_MAP[index];
    if (!mapping) return [];
    const { data } = await supabase
      .from(mapping.table)
      .select(mapping.columns[0])
      .ilike(mapping.columns[0], `${prefix}%`)
      .limit(limit);
    return (data ?? []).map((r: any) => r[mapping.columns[0]]).filter(Boolean);
  }

  async indexDocument(_index: string, _id: string, _document: Record<string, unknown>): Promise<void> {
    // PostgreSQL auto-indexes — no explicit indexing needed
  }

  async indexDocuments(_index: string, _documents: any[]): Promise<void> {
    // PostgreSQL auto-indexes — no explicit indexing needed
  }

  async deleteDocument(_index: string, _id: string): Promise<void> {
    // Deletion is handled via normal DB operations — no separate index management
  }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    try {
      await supabase.from('courses').select('id').limit(1);
      return 'healthy';
    } catch {
      return 'offline';
    }
  }
}

export const postgresSearchProvider = new PostgresSearchProvider();
