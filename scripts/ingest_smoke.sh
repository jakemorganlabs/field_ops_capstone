#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

DATABASE_URL="${DATABASE_URL:-postgresql://fieldops:fieldops@127.0.0.1:5432/fieldops}"
export DATABASE_URL

OBJECT_STORE_DIR="${OBJECT_STORE_DIR:-$(pwd)/objects}"
export OBJECT_STORE_DIR

PG="psql $DATABASE_URL -v ON_ERROR_STOP=1"

reset_state() {
  $PG -c "TRUNCATE document, chunk, dead_letter RESTART IDENTITY CASCADE;" >/dev/null
  rm -rf "$OBJECT_STORE_DIR"
  mkdir -p "$OBJECT_STORE_DIR"
}

count_rows() {
  $PG -t -A -c "SELECT COUNT(*) FROM $1;"
}

echo "=== reset state ==="
reset_state

echo "=== first ingest ==="
npm run ingest -- --path fixtures/synthetic_corpus --doc-type proposal --region CA --date 2025-11-01 > /tmp/first_ingest.json
DOC_COUNT=$(count_rows document)
CHUNK_COUNT=$(count_rows chunk)
DEAD_COUNT=$(count_rows dead_letter)

echo "documents: $DOC_COUNT"
echo "chunks: $CHUNK_COUNT"
echo "dead_letters: $DEAD_COUNT"

if [ "$DOC_COUNT" -ne 5 ]; then
  echo "expected 5 documents, got $DOC_COUNT"
  exit 1
fi

if [ "$CHUNK_COUNT" -lt 1 ]; then
  echo "expected at least 1 chunk, got $CHUNK_COUNT"
  exit 1
fi

if [ "$DEAD_COUNT" -ne 0 ]; then
  echo "expected 0 dead letters, got $DEAD_COUNT"
  exit 1
fi

echo "=== re-ingest (idempotency) ==="
npm run ingest -- --path fixtures/synthetic_corpus --doc-type proposal --region CA --date 2025-11-01 > /tmp/second_ingest.json
DOC_COUNT2=$(count_rows document)
CHUNK_COUNT2=$(count_rows chunk)
DEAD_COUNT2=$(count_rows dead_letter)

echo "documents: $DOC_COUNT2"
echo "chunks: $CHUNK_COUNT2"
echo "dead_letters: $DEAD_COUNT2"

if [ "$DOC_COUNT2" -ne "$DOC_COUNT" ]; then
  echo "re-ingest changed document count from $DOC_COUNT to $DOC_COUNT2"
  exit 1
fi

if [ "$CHUNK_COUNT2" -ne "$CHUNK_COUNT" ]; then
  echo "re-ingest changed chunk count from $CHUNK_COUNT to $CHUNK_COUNT2"
  exit 1
fi

if [ "$DEAD_COUNT2" -ne 0 ]; then
  echo "expected 0 dead letters after re-ingest, got $DEAD_COUNT2"
  exit 1
fi

echo "=== corrupt one file ==="
cp fixtures/synthetic_corpus/synthetic.pdf /tmp/synthetic.pdf.bak
head -c 128 /dev/urandom > fixtures/synthetic_corpus/synthetic.pdf

npm run ingest -- --path fixtures/synthetic_corpus --doc-type proposal --region CA --date 2025-11-01 > /tmp/corrupt_ingest.json

cp /tmp/synthetic.pdf.bak fixtures/synthetic_corpus/synthetic.pdf

DOC_COUNT3=$(count_rows document)
CHUNK_COUNT3=$(count_rows chunk)
DEAD_COUNT3=$(count_rows dead_letter)

echo "documents: $DOC_COUNT3"
echo "chunks: $CHUNK_COUNT3"
echo "dead_letters: $DEAD_COUNT3"

if [ "$DOC_COUNT3" -ne "$DOC_COUNT" ]; then
  echo "corrupt ingest changed document count from $DOC_COUNT to $DOC_COUNT3"
  exit 1
fi

if [ "$CHUNK_COUNT3" -ne "$CHUNK_COUNT" ]; then
  echo "corrupt ingest changed chunk count from $CHUNK_COUNT to $CHUNK_COUNT3"
  exit 1
fi

if [ "$DEAD_COUNT3" -ne 1 ]; then
  echo "expected 1 dead letter after corrupt ingest, got $DEAD_COUNT3"
  exit 1
fi

echo "=== verify object store round-trip ==="
OBJECT_KEY=$($PG -t -A -c "SELECT object_key FROM document LIMIT 1;")
if [ -z "$OBJECT_KEY" ]; then
  echo "no object key recorded"
  exit 1
fi
if [ ! -f "$OBJECT_STORE_DIR/$OBJECT_KEY" ]; then
  echo "object not found at $OBJECT_STORE_DIR/$OBJECT_KEY"
  exit 1
fi

echo "=== verify embed_model and dim recorded ==="
BAD_DIM=$($PG -t -A -c "SELECT COUNT(*) FROM chunk WHERE embed_model IS NULL OR embedding IS NULL;")
if [ "$BAD_DIM" -ne 0 ]; then
  echo "found chunk with missing embed_model or embedding"
  exit 1
fi

echo "=== smoke passed ==="
