# Provider Abstraction Layer — Developer Guide

> MedAcademy Platform · Last updated: 2026-07

---

## Overview

The Provider Abstraction Layer (PAL) decouples every external service dependency from business logic, UI, and routes. Every module communicates **only** with internal provider interfaces. Third-party SDKs are isolated inside provider implementations.

**Key principle:** changing from Supabase Storage to AWS S3 requires editing exactly **one line** — the registration call — with zero changes to the database, UI, or business logic.

---

## Architecture

```
app code  →  providers.<category>()  →  Provider Interface  →  Implementation  →  External SDK
```

```
src/lib/providers/
├── registry.ts                      # Master provider registry (single source of truth)
├── index.ts                         # Registration — import once at app startup
│
├── videoProvider.ts                 # Video interface
├── storageProvider.ts               # Storage interface
├── notificationProvider.ts          # Notification interface
├── emailProvider.ts                 # Email interface
├── smsProvider.ts                   # SMS interface
├── paymentProvider.ts               # Payment interface
├── authProvider.ts                  # Auth interface
├── analyticsProvider.ts             # Analytics interface
├── crashProvider.ts                 # Crash reporting interface
├── searchProvider.ts                # Search interface
├── aiProvider.ts                    # AI interface
│
└── implementations/
    ├── supabaseStorage.ts           # ✅ Active — Supabase Storage
    ├── expoNotifications.ts         # ✅ Active — Expo Push
    ├── supabaseAuth.ts              # ✅ Active — Supabase Auth
    ├── postgresSearch.ts            # ✅ Active — PostgreSQL FTS
    ├── internalAnalytics.ts         # ✅ Active — Supabase-backed analytics
    ├── internalCrash.ts             # ✅ Active — Internal log + Supabase
    ├── stubProviders.ts             # ⏳ Stubs — Email, SMS, Payment, AI
    └── medacademy.ts                # ✅ Active — MedAcademy Video (VdoCipher)
```

---

## Using Providers

```typescript
// Import from the registry (NEVER import implementations directly)
import { providers } from '@/lib/providers/registry';

// Storage
const path = await providers.storage().upload('bucket', 'file.pdf', blob);
const url  = providers.storage().getPublicUrl('bucket', 'file.pdf');

// Notifications
await providers.notification().sendToUser(pushToken, { title: 'New lesson', body: '...' });
await providers.notification().broadcast({ title: 'Platform update', body: '...' });

// Auth
const session = await providers.auth().loginWithEmail(email, password);
await providers.auth().resetPassword(email);

// Search
const results = await providers.search().search({ q: 'cardiology', index: 'courses' });

// Analytics
await providers.analytics().track(userId, { name: 'course_started', properties: { courseId } });

// AI (stub until configured)
const summary = await providers.ai().summarize(longText);

// Crash reporting
providers.crash().addBreadcrumb({ category: 'navigation', message: 'Opened course screen' });
await providers.crash().captureError(error, { userId });
```

---

## Implementing a New Provider

### Step 1 — Implement the interface

Create `src/lib/providers/implementations/<providerName>.ts`:

```typescript
import type { StorageProvider, StorageUploadOptions, StorageFileMetadata } from '../storageProvider';

class AwsS3Provider implements StorageProvider {
  readonly providerKey = 'aws_s3';
  readonly displayName = 'AWS S3';

  async upload(bucket: string, path: string, data: Blob | ArrayBuffer, options?: StorageUploadOptions): Promise<string> {
    // Call your Edge Function — NEVER call AWS SDK from client
    const { data: result, error } = await supabase.functions.invoke('storage-proxy', {
      body: { action: 'upload', bucket, path, options },
    });
    if (error) throw error;
    return result.path;
  }

  async delete(bucket: string, path: string): Promise<void> { /* ... */ }
  async deleteMany(bucket: string, paths: string[]): Promise<void> { /* ... */ }
  async move(bucket: string, from: string, to: string): Promise<void> { /* ... */ }
  async copy(bucket: string, from: string, to: string): Promise<void> { /* ... */ }
  getPublicUrl(bucket: string, path: string): string { return `https://cdn.example.com/${bucket}/${path}`; }
  async getSignedUrl(bucket: string, path: string, expiresIn: number): Promise<string> { /* ... */ return ''; }
  async getMetadata(bucket: string, path: string): Promise<StorageFileMetadata> { /* ... */ return {} as any; }
  async list(bucket: string, prefix?: string): Promise<StorageFileMetadata[]> { return []; }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    // Ping your health-check endpoint
    return 'healthy';
  }
}

export const awsS3Provider = new AwsS3Provider();
```

### Step 2 — Register it

Open `src/lib/providers/index.ts` and replace ONE line:

```typescript
// Before:
registerStorageProvider(supabaseStorageProvider);

// After:
registerStorageProvider(awsS3Provider);
```

That's it. Zero other changes required.

### Step 3 — Add to provider_registry DB table

```sql
INSERT INTO provider_registry (category, provider_key, display_name, is_active, is_default, capabilities, config)
VALUES ('storage', 'aws_s3', 'AWS S3', true, true,
  '["upload","delete","move","copy","url","signed_url","metadata","list"]',
  '{"region":"us-east-1","bucket_prefix":"medacademy-"}');

-- Deactivate old default
UPDATE provider_registry SET is_default = false WHERE provider_key = 'supabase_storage';
```

### Step 4 — Add health ping to Edge Function

In `supabase/functions/provider-health/index.ts`, add a case to `pingProvider()`:

```typescript
case 'aws_s3': {
  const res = await fetch(`https://s3.${region}.amazonaws.com/`, { method: 'HEAD' });
  return res.ok ? { status: 'healthy' } : { status: 'warning' };
}
```

---

## Provider Categories & Interfaces

| Category | Interface | Active Provider | Future Options |
|---|---|---|---|
| `video` | `VideoProvider` | MedAcademy (VdoCipher) | Cloudflare Stream, Mux, Bunny, AWS |
| `storage` | `StorageProvider` | Supabase Storage | AWS S3, Cloudflare R2, GCS, Azure |
| `notification` | `NotificationProvider` | Expo Push | Firebase FCM, OneSignal, Huawei |
| `email` | `EmailProvider` | Stub | Resend, SendGrid, SES, Mailgun |
| `sms` | `SmsProvider` | Stub | Twilio, Vonage, Egyptian Gateway |
| `payment` | `PaymentProvider` | Stub | Paymob, Stripe, PayPal, Fawry |
| `auth` | `AuthProvider` | Supabase Auth | Firebase, Auth0, Clerk, Keycloak |
| `analytics` | `AnalyticsProvider` | Internal | Firebase, PostHog, Mixpanel |
| `crash` | `CrashProvider` | Internal Logging | Sentry, Crashlytics, Bugsnag |
| `search` | `SearchProvider` | PostgreSQL FTS | Meilisearch, Typesense, Algolia |
| `ai` | `AiProvider` | Stub | OpenAI, Claude, Gemini, Azure |

---

## Security Rules

1. **Secrets never touch the client.** API keys, tokens, and credentials live in Supabase Edge Function secrets only.
2. **Client code never imports SDKs.** All third-party API calls go through Edge Functions.
3. **Provider interfaces are pure TypeScript.** No external imports in interface files.
4. **Registry is read-only after startup.** Providers are registered once at app start.

---

## Hot-Swap Procedure

To switch from Provider A to Provider B at runtime:

1. Implement Provider B's interface (Step 1 above)
2. Deploy any required Edge Function changes
3. Add secrets: `supabase secrets set NEW_PROVIDER_KEY=xxx`
4. Update `index.ts` registration (Step 2 above)
5. Update `provider_registry` DB row (Step 3 above)
6. Deploy — no DB schema changes, no UI changes, no business logic changes

---

## Audit Log

Every provider operation is automatically logged to `provider_audit_log`:

```typescript
await supabase.from('provider_audit_log').insert({
  provider_key: 'aws_s3',
  category: 'storage',
  operation: 'upload',
  actor_id: userId,
  success: true,
  duration_ms: 234,
  metadata: { path: 'courses/lesson-1/video.mp4', size: 45_000_000 },
});
```

---

## Health Monitoring

Every provider exposes `checkHealth()` returning one of:

| Status | Meaning |
|---|---|
| `healthy` | Fully operational |
| `warning` | Degraded — partial functionality |
| `offline` | Unreachable — failover if available |
| `maintenance` | Planned downtime |
| `unknown` | Not yet configured or not checked |

The **System Providers** admin screen (Super Admin → Operations → System Providers) shows live health for all registered providers and allows on-demand health checks.

---

## FAQ

**Q: Can I have multiple active providers for the same category?**  
A: Not currently — one default per category. The registry holds one active instance per category. Multi-provider fallback can be added by wrapping two providers in a `FallbackStorageProvider` that tries Provider A, falls back to Provider B on failure.

**Q: Where do I put provider secrets?**  
A: Supabase Edge Function secrets only. Never in `.env`, `app.json`, or client code.

**Q: How do I test a new provider locally?**  
A: Implement a `MockXxxProvider` with hardcoded responses, register it in test setup, run your tests.

**Q: What if a provider throws?**  
A: Providers should throw typed errors. Callers should catch and handle. The `crash` provider can be used to log unexpected failures.
