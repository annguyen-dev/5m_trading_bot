#!/usr/bin/env bash
#
# audit-auth.sh — verify every /api/* endpoint is JWT-gated.
#
# How it works:
#   1. Hit every known endpoint with NO token, expect 401.
#   2. Hit the two intentionally-public endpoints, expect non-401.
#
# Path params (`:envId`, `:runId` etc.) get a placeholder — auth middleware
# fires BEFORE the route handler, so it returns 401 regardless of whether
# the param is valid.
#
# Usage:
#   pnpm audit:auth https://13.235.115.6
#   pnpm audit:auth http://localhost:3000
#
# Exit code: 0 if all checks pass, 1 if any fail.

set -uo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "Usage: $0 <base-url>" >&2
  echo "  e.g. $0 https://13.235.115.6" >&2
  echo "       $0 http://localhost:3000" >&2
  exit 2
fi
BASE="${BASE%/}"   # strip trailing slash

# -k: accept self-signed cert. -o /dev/null: discard body. -w '%{http_code}': print status only.
CURL=(curl -sk -o /dev/null -w '%{http_code}' --max-time 5)

# format: "METHOD /path"
PUBLIC=(
  "GET  /api/health"
  "POST /api/auth/login"
)

PROTECTED=(
  "GET    /api/auth/me"
  "POST   /api/backtest/run"
  "GET    /api/backtest/progress/X"
  "DELETE /api/backtest/runs/X"
  "POST   /api/backtest/poly/run"
  "GET    /api/backtest/poly/progress/X"
  "GET    /api/formula/configs"
  "GET    /api/formula/configs/active"
  "POST   /api/formula/configs"
  "PUT    /api/formula/configs/X"
  "PUT    /api/formula/configs/X/activate"
  "DELETE /api/formula/configs/X"
  "POST   /api/formula/analyze"
  "GET    /api/environments"
  "GET    /api/signals/X"
  "GET    /api/summary/X"
  "GET    /api/candles/X"
  "GET    /api/run-candles/X"
  "GET    /api/backtest/compare"
  "GET    /api/backtest/equity/X"
  "GET    /api/positions"
  "GET    /api/simulate/candles"
  "POST   /api/simulate/run"
  "POST   /api/poly-simulate/run"
  "GET    /api/settings"
  "PUT    /api/settings/X"
  "GET    /api/poly/status"
  "GET    /api/poly/markets/upcoming"
  "GET    /api/poly/market/current"
  "GET    /api/poly/share-history"
  "GET    /api/poly/btc-history"
  "GET    /api/poly/past-windows"
  "POST   /api/poly/orders/simulate"
  "POST   /api/poly/orders/sell"
  "GET    /api/poly/balance"
  "GET    /api/poly/positions/X"
  "GET    /api/poly/orders"
  "GET    /api/poly/portfolio"
  "DELETE /api/poly/admin/reset-test-data"
  "GET    /api/poly/verify-slugs"
  "GET    /api/coin-configs"
  "PUT    /api/coin-configs/X"
  "GET    /api/telegram-channels"
  "PUT    /api/telegram-channels"
  "GET    /api/analyze/streak-stats"
  "GET    /api/poly/stream"
)

# Sanity ping — bail early if base URL is unreachable.
ping_code=$("${CURL[@]}" "${BASE}/api/health" || echo "000")
if [[ "$ping_code" == "000" ]]; then
  echo "✗ cannot reach ${BASE}/api/health (network or TLS issue)" >&2
  exit 2
fi

fail=0
pass=0

echo "Auditing ${BASE}"
echo
echo "── Public (expect != 401) ─────────────────────────────────"
for ep in "${PUBLIC[@]}"; do
  read -r method path <<< "$ep"
  code=$("${CURL[@]}" -X "$method" "${BASE}${path}")
  if [[ "$code" == "401" ]]; then
    printf "  FAIL   %-7s %-50s → %s (should be public)\n" "$method" "$path" "$code"
    fail=$((fail+1))
  else
    printf "  ok     %-7s %-50s → %s\n" "$method" "$path" "$code"
    pass=$((pass+1))
  fi
done

echo
echo "── Protected (expect 401 without token) ──────────────────"
for ep in "${PROTECTED[@]}"; do
  read -r method path <<< "$ep"
  code=$("${CURL[@]}" -X "$method" "${BASE}${path}")
  if [[ "$code" != "401" ]]; then
    printf "  FAIL   %-7s %-50s → %s (expected 401 — UNPROTECTED)\n" "$method" "$path" "$code"
    fail=$((fail+1))
  else
    printf "  ok     %-7s %-50s → 401\n" "$method" "$path"
    pass=$((pass+1))
  fi
done

echo
echo "── Result ────────────────────────────────────────────────"
if [[ $fail -eq 0 ]]; then
  echo "  ✓ all $pass checks passed"
  exit 0
else
  echo "  ✗ $fail check(s) failed, $pass passed"
  exit 1
fi
