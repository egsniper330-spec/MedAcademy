#!/usr/bin/env bash
# =============================================================================
# MedAcademy — One-Shot Production Setup Script
# =============================================================================
# Run this script ONCE from your local machine to:
#   1. Apply all database migrations to your Supabase project
#   2. Set all required secrets in Edge Function runtime
#   3. Deploy all Edge Functions
#   4. Create the first Super Admin account
#
# Prerequisites:
#   - Supabase CLI installed (brew install supabase/tap/supabase  or  npm i -g supabase)
#   - curl installed (built-in on macOS/Linux)
#   - Your .env.local and supabase/.env.secrets files are filled in
#
# Usage:
#   chmod +x scripts/setup-production.sh
#   ./scripts/setup-production.sh
# =============================================================================

set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Load project secrets ───────────────────────────────────────────────────────
SECRETS_FILE="supabase/.env.secrets"
ENV_LOCAL=".env.local"

[[ -f "$SECRETS_FILE" ]] || error "$SECRETS_FILE not found. Copy supabase/secrets.template → $SECRETS_FILE and fill in values."
[[ -f "$ENV_LOCAL" ]]    || error "$ENV_LOCAL not found. Copy .env.local.template → $ENV_LOCAL and fill in values."

# shellcheck disable=SC1090
source "$SECRETS_FILE"
# shellcheck disable=SC1090
source "$ENV_LOCAL"

: "${SUPABASE_PROJECT_ID:?SUPABASE_PROJECT_ID is required in $SECRETS_FILE}"
: "${SUPABASE_DB_PASSWORD:?SUPABASE_DB_PASSWORD is required in $SECRETS_FILE}"
: "${EXPO_PUBLIC_SUPABASE_URL:?EXPO_PUBLIC_SUPABASE_URL is required in $ENV_LOCAL}"

# ── Derive values ──────────────────────────────────────────────────────────────
SUPABASE_URL="$EXPO_PUBLIC_SUPABASE_URL"
DB_HOST="db.${SUPABASE_PROJECT_ID}.supabase.co"

echo ""
echo "======================================================="
echo "  MedAcademy Production Setup"
echo "  Project: $SUPABASE_PROJECT_ID"
echo "  URL:     $SUPABASE_URL"
echo "======================================================="
echo ""

# ── Step 1: Login & link ───────────────────────────────────────────────────────
info "Step 1/5 — Linking Supabase project..."
supabase link --project-ref "$SUPABASE_PROJECT_ID" --password "$SUPABASE_DB_PASSWORD" || \
  error "supabase link failed. Run 'supabase login' first if you haven't authenticated."
success "Project linked: $SUPABASE_PROJECT_ID"

# ── Step 2: Apply all migrations ───────────────────────────────────────────────
info "Step 2/5 — Pushing database migrations..."
supabase db push --password "$SUPABASE_DB_PASSWORD"
success "All migrations applied"

# ── Step 3: Set Edge Function secrets ─────────────────────────────────────────
info "Step 3/5 — Setting Edge Function secrets..."

set_secret() {
  local key="$1" val="$2"
  if [[ -z "$val" ]]; then
    warn "Skipping empty secret: $key"
    return
  fi
  supabase secrets set "${key}=${val}"
  success "Secret set: $key"
}

# Required
set_secret "SERVICE_ROLE_KEY"    "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY is required in $SECRETS_FILE}"
set_secret "VDOCIPHER_API_SECRET" "${VDOCIPHER_API_SECRET:?VDOCIPHER_API_SECRET is required in $SECRETS_FILE}"
set_secret "BOOTSTRAP_SECRET"    "${BOOTSTRAP_SECRET:?BOOTSTRAP_SECRET is required in $SECRETS_FILE}"

# Optional
[[ -n "${VDOCIPHER_WEBHOOK_SECRET:-}" ]] && set_secret "VDOCIPHER_WEBHOOK_SECRET" "$VDOCIPHER_WEBHOOK_SECRET"
[[ -n "${APP_DOMAIN:-}" ]]               && set_secret "APP_DOMAIN" "$APP_DOMAIN"

# ── Step 4: Deploy Edge Functions ──────────────────────────────────────────────
info "Step 4/5 — Deploying Edge Functions..."
for fn in credits device-binding activation-codes vdocipher-otp bootstrap-super-admin; do
  supabase functions deploy "$fn" --no-verify-jwt 2>/dev/null || \
  supabase functions deploy "$fn"
  success "Deployed: $fn"
done

# ── Step 5: Create Super Admin ─────────────────────────────────────────────────
info "Step 5/5 — Creating Super Admin account..."
echo ""
echo "Please provide the Super Admin account details:"
read -rp "  Email:     " SA_EMAIL
read -rsp "  Password:  " SA_PASSWORD; echo ""
read -rp "  Full Name: " SA_FULL_NAME
read -rp "  Phone (+countrycode, optional): " SA_PHONE

[[ -z "$SA_EMAIL" ]]     && error "Email is required"
[[ -z "$SA_PASSWORD" ]]  && error "Password is required"
[[ -z "$SA_FULL_NAME" ]] && error "Full Name is required"

PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'email':     '$SA_EMAIL',
    'password':  '$SA_PASSWORD',
    'full_name': '$SA_FULL_NAME',
    'phone':     '$SA_PHONE'
}))
")

RESPONSE=$(curl -sf -X POST \
  "${SUPABASE_URL}/functions/v1/bootstrap-super-admin" \
  -H "Content-Type: application/json" \
  -H "x-bootstrap-secret: ${BOOTSTRAP_SECRET}" \
  -d "$PAYLOAD") || error "bootstrap-super-admin request failed"

echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('success'):
    print(f\"  ✅ Super Admin created!\")
    print(f\"     user_id : {d['user_id']}\")
    print(f\"     email   : {d['email']}\")
    print(f\"     role    : {d['role']}\")
    print(f\"     status  : {d['status']}\")
    print(f\"     note    : {d.get('message', '')}\")
else:
    print(f\"  ❌ Failed: {d.get('error', d)}\")
    sys.exit(1)
"

echo ""
echo "======================================================="
echo -e "${GREEN}  Setup complete! MedAcademy is production-ready.${NC}"
echo "======================================================="
echo ""
warn "IMPORTANT: Keep supabase/.env.secrets out of version control (it is gitignored)."
warn "IMPORTANT: The bootstrap-super-admin endpoint is now permanently locked."
