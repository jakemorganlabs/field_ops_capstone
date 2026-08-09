#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
export REVIEW_HOST="review.local"
export APPROVER_DEV_EMAIL="approver@example.com"
export PORT="3004"
export NODE_ENV="development"

mkdir -p objects

# Start the server in the background.
node --experimental-strip-types --import ./scripts/ts-register.mjs src/server.ts > /tmp/gate_server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the server to be ready.
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3004/health > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS http://127.0.0.1:3004/health > /dev/null

# Seed test runs and capture their IDs.
SEED_FILE=$(mktemp)
node --experimental-strip-types --import ./scripts/ts-register.mjs scripts/gate_seed.ts "$SEED_FILE" > /dev/null
IDS_JSON=$(cat "$SEED_FILE")
HAPPY_ID=$(echo "$IDS_JSON" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).happy))")
EDIT_ID=$(echo "$IDS_JSON" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).edit))")
ESCALATED_ID=$(echo "$IDS_JSON" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).escalated))")
REJECT_ID=$(echo "$IDS_JSON" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).reject))")
rm -f "$SEED_FILE"

echo "Test run IDs: happy=$HAPPY_ID edit=$EDIT_ID escalated=$ESCALATED_ID reject=$REJECT_ID"

# Case 1: happy path approval produces a PDF.
echo "Case 1: happy path approval"
APPROVE_RESPONSE=$(curl -sS -H "Host: review.local" -H "Content-Type: application/json" -X POST "http://127.0.0.1:3004/queue/$HAPPY_ID/approve" -d '{"edits":[]}')
echo "$APPROVE_RESPONSE"
PDF_KEY=$(echo "$APPROVE_RESPONSE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).pdf_key || ''))")
if [ -z "$PDF_KEY" ]; then
  echo "FAIL: no pdf_key returned"
  exit 1
fi
PDF_PATH="objects/$PDF_KEY"
if [ ! -f "$PDF_PATH" ]; then
  echo "FAIL: PDF file not found at $PDF_PATH"
  exit 1
fi
PDF_SIZE=$(stat -f%z "$PDF_PATH" 2>/dev/null || stat -c%s "$PDF_PATH" 2>/dev/null)
if [ "$PDF_SIZE" -lt 100 ]; then
  echo "FAIL: PDF too small ($PDF_SIZE bytes)"
  exit 1
fi
echo "PASS: PDF stored at $PDF_KEY ($PDF_SIZE bytes)"

# Case 2: needs_review run takes an edit and records it in human_edits.
echo "Case 2: edit capture"
EDIT_RESPONSE=$(curl -sS -H "Host: review.local" -H "Content-Type: application/json" -X POST "http://127.0.0.1:3004/queue/$EDIT_ID/approve" -d '{"edits":[{"target":"line","field_path":"lines[0].unit_cost","new_value":"550.00"}]}')
echo "$EDIT_RESPONSE"
EDIT_PDF_KEY=$(echo "$EDIT_RESPONSE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).pdf_key || ''))")
if [ -z "$EDIT_PDF_KEY" ]; then
  echo "FAIL: edit approval did not return pdf_key"
  exit 1
fi
EDIT_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM human_edits WHERE run_id = '$EDIT_ID' AND field_path = 'lines[0].unit_cost';")
if [ "$(echo "$EDIT_COUNT" | tr -d ' ')" != "1" ]; then
  echo "FAIL: human_edits did not record the edit"
  exit 1
fi
echo "PASS: human_edits recorded the edit"

# Case 3: escalated run shows open issues and approval with a note works.
echo "Case 3: escalated run open issues"
DETAIL_HTML=$(curl -sS -H "Host: review.local" "http://127.0.0.1:3004/queue/$ESCALATED_ID")
if ! echo "$DETAIL_HTML" | grep -q "Router price seems high"; then
  echo "FAIL: open issue not shown on detail page"
  exit 1
fi
echo "PASS: open issue shown on detail page"
ESCALATED_RESPONSE=$(curl -sS -H "Host: review.local" -H "Content-Type: application/json" -X POST "http://127.0.0.1:3004/queue/$ESCALATED_ID/approve" -d '{"edits":[]}')
echo "$ESCALATED_RESPONSE"
ESCALATED_PDF_KEY=$(echo "$ESCALATED_RESPONSE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).pdf_key || ''))")
if [ -z "$ESCALATED_PDF_KEY" ]; then
  echo "FAIL: escalated approval did not return pdf_key"
  exit 1
fi
echo "PASS: escalated run approved"

# Case 4: reject records reason and no PDF exists.
echo "Case 4: reject"
REJECT_RESPONSE=$(curl -sS -H "Host: review.local" -H "Content-Type: application/json" -X POST "http://127.0.0.1:3004/queue/$REJECT_ID/reject" -d '{"rejection_reason":"scope mismatch"}')
echo "$REJECT_RESPONSE"
FEEDBACK_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM feedback WHERE run_id = '$REJECT_ID' AND comment = 'scope mismatch';")
if [ "$(echo "$FEEDBACK_COUNT" | tr -d ' ')" != "1" ]; then
  echo "FAIL: feedback not recorded"
  exit 1
fi
REJECT_PDF_KEY=$(psql "$DATABASE_URL" -t -c "SELECT pdf_key FROM run WHERE id = '$REJECT_ID';")
if [ -n "$(echo "$REJECT_PDF_KEY" | tr -d ' ')" ]; then
  echo "FAIL: reject run has a pdf_key"
  exit 1
fi
echo "PASS: reject recorded reason and no PDF"

# Double approval should be a no-op and create one PDF.
echo "Double approval idempotency"
APPROVE_RESPONSE_2=$(curl -sS -H "Host: review.local" -H "Content-Type: application/json" -X POST "http://127.0.0.1:3004/queue/$HAPPY_ID/approve" -d '{"edits":[]}')
PDF_KEY_2=$(echo "$APPROVE_RESPONSE_2" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).pdf_key || ''))")
if [ "$PDF_KEY" != "$PDF_KEY_2" ]; then
  echo "FAIL: double approval produced a different PDF key"
  exit 1
fi
PDF_FILE_COUNT=$(find objects/proposals -name "${HAPPY_ID}_*.pdf" 2>/dev/null | wc -l | tr -d ' ')
if [ "$PDF_FILE_COUNT" != "1" ]; then
  echo "FAIL: expected one PDF file for happy run, found $PDF_FILE_COUNT"
  exit 1
fi
echo "PASS: double approval creates one PDF"

echo "All gate smoke cases passed."
