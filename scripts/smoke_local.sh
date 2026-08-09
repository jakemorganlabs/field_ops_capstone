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

reset_run_state() {
  $PG -c "TRUNCATE run, spec, audit, critique, dead_letter, feedback, human_edits RESTART IDENTITY CASCADE;" >/dev/null
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
  local attempts=$2
  for _ in $(seq 1 "$attempts"); do
    local status
    status=$(curl -s http://127.0.0.1:$PORT/run/"$run_id" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ "$status" = "completed" ] || [ "$status" = "needs_review" ] || [ "$status" = "failed" ]; then
      echo "$status"
      return 0
    fi
    sleep 5
  done
  echo "timeout"
  return 1
}

extract_run_id() {
  echo "$1" | grep -o '"run_id":"[^"]*"' | head -1 | cut -d'"' -f4
}

mkdir -p /tmp/smoke_local

# Use the first answerable case as the intake.
node -e "
const fs = require('fs');
const cases = JSON.parse(fs.readFileSync('fixtures/eval_cases/answerable.json', 'utf-8'));
fs.writeFileSync('/tmp/smoke_local/intake.json', JSON.stringify(cases[0].intake));
" >/dev/null

echo "=== reset run state ==="
reset_run_state

echo "=== ingest corpus ==="
npm run ingest -- --path fixtures/synthetic_corpus --doc-type eval_document --date 2026-08-01 >/tmp/smoke_local/ingest.log 2>&1

echo "=== start server ==="
node --experimental-strip-types --import ./scripts/ts-register.mjs src/server.ts > /tmp/smoke_local/server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
wait_for_server

echo "=== post signed intake ==="
AUTH=$(sign_request POST /intake /tmp/smoke_local/intake.json)
BODY=$(curl -s -X POST http://127.0.0.1:$PORT/intake -H "Authorization: $AUTH" --data-binary @/tmp/smoke_local/intake.json)
echo "body: $BODY"
RUN_ID=$(extract_run_id "$BODY")
if [ -z "$RUN_ID" ]; then
  echo "missing run_id"
  exit 1
fi

echo "=== poll run ==="
STATUS=$(poll_run "$RUN_ID" 120)
echo "final status: $STATUS"

if [ "$STATUS" = "failed" ]; then
  echo "run failed"
  exit 1
fi

if [ "$STATUS" != "completed" ] && [ "$STATUS" != "needs_review" ]; then
  echo "run did not complete"
  exit 1
fi

echo "=== assert grounded BOM ==="
$PG -v ON_ERROR_STOP=1 -c "
DO \$\$
DECLARE
  bom JSONB;
  line JSONB;
  non_assumption_count INT := 0;
  grounded_count INT := 0;
BEGIN
  SELECT r.bom INTO bom FROM run r WHERE r.id = '$RUN_ID';
  IF bom IS NULL THEN
    RAISE EXCEPTION 'run has no BOM';
  END IF;
  FOR line IN SELECT jsonb_array_elements(bom->'lines')
  LOOP
    IF (line->>'assumption')::boolean = false OR line->>'assumption' IS NULL THEN
      non_assumption_count := non_assumption_count + 1;
      IF line->'citation' IS NOT NULL THEN
        grounded_count := grounded_count + 1;
      END IF;
    END IF;
  END LOOP;
  IF non_assumption_count = 0 THEN
    RAISE EXCEPTION 'BOM has no non-assumption lines';
  END IF;
  IF grounded_count = 0 THEN
    RAISE EXCEPTION 'BOM has no grounded non-assumption lines';
  END IF;
END
\$\$;
"

echo "=== smoke_local passed ==="
