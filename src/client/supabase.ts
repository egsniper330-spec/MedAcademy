// ─────────────────────────────────────────────────────────────────────────────
// MedAcademy Backend Client
//
// This file exports `supabase` — the same name used by 62+ files across the
// frontend. The API surface is identical to @supabase/supabase-js:
//
//   supabase.from('table').select('*')       → PHP REST API
//   supabase.rpc('function_name', params)     → PHP /rpc/* routes
//   supabase.functions.invoke('name', body)   → PHP equivalent routes
//   supabase.auth.signInWithPassword({...})   → PHP /auth/* routes
//   supabase.storage.from('bucket').upload()  → PHP /storage/* routes
//   supabase.channel('name').on(...)          → Polling-based realtime
//
// MIGRATION: All calls now route to the PHP backend instead of Supabase.
// The EXPO_PUBLIC_PHP_API_URL env var must point to the PHP API base URL.
// If not set, falls back to EXPO_PUBLIC_SUPABASE_URL with /backend/public/index.php appended.
// ─────────────────────────────────────────────────────────────────────────────

export { supabase } from './php';
