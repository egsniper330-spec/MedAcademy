# Edge Functions

Place Supabase Edge Functions here. Each function lives in its own subdirectory.

## Structure

```
functions/
  <function-name>/
    index.ts      ← entry point (Deno)
```

## Deploy

```bash
# Deploy all functions
supabase functions deploy

# Deploy one function
supabase functions deploy <function-name>

# Set secrets for functions
supabase secrets set KEY=value
```

## Local development

```bash
supabase functions serve <function-name> --env-file .env.local
```

## Planned functions

| Function | Purpose |
|----------|---------|
| `vdocipher-otp` | Generate VdoCipher OTP tokens for secure video playback |
| `send-notification` | Trigger push notifications via Expo Push API |
| `generate-activation-code` | Server-side activation code generation with credit deduction |
