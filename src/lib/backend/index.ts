// ─────────────────────────────────────────────────────────────────────────────
// Backend Configuration Layer
//
// USAGE — import the backend adapter, never import the provider SDK directly:
//
//   import { backend } from '@/lib/backend';
//   const session = await backend.auth.getSession();
//   const url = backend.storage.getPublicUrl('avatars', 'user/avatar.png');
//
// TO SWAP PROVIDERS:
//   1. Implement a new adapter in backend/adapters/<provider>-adapter.ts
//      following the BackendAdapter interface from backend/types.ts
//   2. Replace `supabaseAdapter` with your new adapter below
//   3. No application or domain code needs to change
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdapter } from './supabase-adapter';
import type { BackendAdapter } from './types';

// Active backend adapter — uses PHP backend via src/client/php.ts
// The supabaseAdapter wraps the PHP client (exported as `supabase` from src/client/supabase.ts)
// All calls route to the PHP REST API instead of Supabase.
export const backend: BackendAdapter = supabaseAdapter;

// Re-export types so consumers don't need to import from the types file
export type {
  AuthAdapter,
  AuthSession,
  AuthUser,
  BackendAdapter,
  DataAdapter,
  FunctionAdapter,
  StorageAdapter,
} from './types';
