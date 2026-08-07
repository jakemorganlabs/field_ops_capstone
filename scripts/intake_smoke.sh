#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

DATABASE_URL="${DATABASE_URL:-postgresql://fieldops:fieldops@127.0.0.1:5432/fieldops}"
export DATABASE_URL
PORT="${PORT:-3004}"
export PORT
HMAC_SECRET="${HMAC_SECRET:-test-secret}"
export HMAC_SECRET
OBJECT_STORE_DIR="${OBJECT_STORE_DIR:-$(pwd)/objects}"
export OBJECT_STORE_DIR

PG="psql $DATABASE_URL -v ON_ERROR_STOP=1"

reset_state() {
  $PG -c "TRUNCATE run, spec, audit, dead_letter RESTART IDENTITY CASCADE;" >/dev/null
}

sign_request() {
  local method=$1
  local path=$2
  local body_file=$3
  local ts
  ts=$(date +%s)
  local body_hash data sig
  body_hash=$(openssl dgst -sha256 -hmac "$HMAC_SECRET" -binary < "$body_file" | xxd -p -c 64)
  data="${ts}.${method}.${path}.${body_hash}"
  sig=$(printf '%s' "$data" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -binary | xxd -p -c 64)
  echo "HMAC ${ts}:${sig}"
}

wait_for_server() {
  for _ in $(seq 1 30); do
    if curl -s http://127.0.0.1:$PORT/health >/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "server did not start"
  return 1
}

poll_run() {
  local run_id=$1
  local expected=$2
  local attempts=$3
  for _ in $(seq 1 "$attempts"); do
    local status
    status=$(curl -s http://127.0.0.1:$PORT/run/"$run_id" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ "$status" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  echo "run $run_id did not reach $expected"
  return 1
}

extract_run_id() {
  echo "$1" | grep -o '"run_id":"[^"]*"' | head -1 | cut -d'"' -f4
}

extract_route() {
  echo "$1" | grep -o '"route":"[^"]*"' | head -1 | cut -d'"' -f4
}

mkdir -p /tmp/intake_smoke

cat > /tmp/intake_smoke/valid.json <<'EOF'
{
  "project_name": "Site Alpha Cable Run",
  "client_name": "Acme Corp",
  "location": "Building 7, Floor 3",
  "region": "CA",
  "scope": "Install 40 CAT6A drops from IDF to workstations",
  "materials": ["CAT6A cable", "patch panels", "faceplates"],
  "labor": ["cable technician", "project manager"],
  "constraints": ["after hours", "no ceiling access"]
}
EOF

cat > /tmp/intake_smoke/vague.json <<'EOF'
{
  "project_name": "Site work",
  "scope": "Install something"
}
EOF

cat > /tmp/intake_smoke/reject.json <<'EOF'
{
  "project_name": "Home alarm"
}
EOF

echo "=== reset state ==="
reset_state

echo "=== start server ==="
node --experimental-strip-types --import ./scripts/ts-register.mjs src/server.ts > /tmp/intake_server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
wait_for_server

echo "=== valid intake proceeds ==="
AUTH=$(sign_request POST /intake /tmp/intake_smoke/valid.json)
BODY=$(curl -s -X POST http://127.0.0.1:$PORT/intake -H "Authorization: $AUTH" --data-binary @/tmp/intake_smoke/valid.json)
echo "body: $BODY"
RUN_ID=$(extract_run_id "$BODY")
if [ -z "$RUN_ID" ]; then echo "missing run_id"; exit 1; fi
poll_run "$RUN_ID" "running" 60
RUN=$(curl -s http://127.0.0.1:$PORT/run/"$RUN_ID")
ROUTE=$(extract_route "$RUN")
if [ "$ROUTE" != "proceed" ]; then echo "expected proceed, got $ROUTE"; exit 1; fi

echo "=== vague intake clarifies ==="
AUTH=$(sign_request POST /intake /tmp/intake_smoke/vague.json)
BODY=$(curl -s -X POST http://127.0.0.1:$PORT/intake -H "Authorization: $AUTH" --data-binary @/tmp/intake_smoke/vague.json)
RUN_ID2=$(extract_run_id "$BODY")
poll_run "$RUN_ID2" "completed" 60
RUN2=$(curl -s http://127.0.0.1:$PORT/run/"$RUN_ID2")
ROUTE=$(extract_route "$RUN2")
if [ "$ROUTE" != "clarify" ]; then echo "expected clarify, got $ROUTE"; exit 1; fi
MISSING=$(echo "$RUN2" | grep -o '"missing_fields":\[[^]]*\]')
if [ -z "$MISSING" ]; then echo "clarify response missing missing_fields"; exit 1; fi

echo "=== residential alarm rejects ==="
AUTH=$(sign_request POST /intake /tmp/intake_smoke/reject.json)
BODY=$(curl -s -X POST http://127.0.0.1:$PORT/intake -H "Authorization: $AUTH" --data-binary @/tmp/intake_smoke/reject.json)
RUN_ID3=$(extract_run_id "$BODY")
poll_run "$RUN_ID3" "rejected" 60
RUN3=$(curl -s http://127.0.0.1:$PORT/run/"$RUN_ID3")
ROUTE=$(extract_route "$RUN3")
if [ "$ROUTE" != "reject" ]; then echo "expected reject, got $ROUTE"; exit 1; fi

echo "=== idempotency: same body returns same run_id ==="
AUTH=$(sign_request POST /intake /tmp/intake_smoke/valid.json)
BODY=$(curl -s -X POST http://127.0.0.1:$PORT/intake -H "Authorization: $AUTH" --data-binary @/tmp/intake_smoke/valid.json)
RUN_ID_REPEAT=$(extract_run_id "$BODY")
if [ "$RUN_ID_REPEAT" != "$RUN_ID" ]; then echo "expected same run_id"; exit 1; fi

COUNT=$($PG -t -A -c "SELECT COUNT(*) FROM run WHERE intake_hash = (SELECT intake_hash FROM run WHERE id = '$RUN_ID');")
if [ "$COUNT" -ne 1 ]; then echo "expected 1 run row, got $COUNT"; exit 1; fi

echo "=== unsigned request returns 401 ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:$PORT/intake --data-binary @/tmp/intake_smoke/valid.json)
if [ "$HTTP_CODE" -ne 401 ]; then echo "expected 401, got $HTTP_CODE"; exit 1; fi

echo "=== smoke passed ==="
