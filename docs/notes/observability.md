# Observability

This note holds the nine dashboard widgets from SRS section 17.3 as ready SQL queries. The dashboard container is deferred to a later session.

## Alert thresholds

| Widget | Metric | Warning | Critical |
| --- | --- | --- | --- |
| Run throughput | runs per minute | < 1 | 0 for 5 minutes |
| Failure rate | failed / total runs | > 5% | > 15% |
| Queue depth | needs_review count | > 5 | > 20 |
| Average latency | end-to-end seconds | > 120 | > 300 |
| DB health | connection errors per minute | > 1 | > 5 |
| Object store health | failed puts per minute | > 1 | > 5 |
| Cost burn | USD per day | > $50 | > $100 |
| Citation integrity | unverified non-assumption lines | > 2% | > 10% |
| Model repair rate | repaired calls / total calls | > 10% | > 25% |

## Widget queries

### 1. Runs per minute

```sql
SELECT
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute') AS runs_last_minute,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes') / 5.0 AS runs_per_minute_5m
FROM run;
```

### 2. Failure rate

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  COUNT(*) AS total,
  CASE WHEN COUNT(*) > 0
    THEN ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / COUNT(*), 2)
    ELSE 0
  END AS failure_rate_pct
FROM run
WHERE created_at >= NOW() - INTERVAL '24 hours';
```

### 3. Queue depth

```sql
SELECT COUNT(*) AS needs_review_count
FROM run
WHERE status = 'needs_review';
```

### 4. Average end-to-end latency

```sql
SELECT
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::integer AS avg_latency_sec
FROM run
WHERE created_at >= NOW() - INTERVAL '24 hours'
  AND updated_at IS NOT NULL;
```

### 5. DB connection errors

```sql
SELECT
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute') AS errors_last_minute,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes') AS errors_last_5m
FROM dead_letter;
```

### 6. Object store failed puts

```sql
SELECT
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute') AS fails_last_minute,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes') AS fails_last_5m
FROM dead_letter
WHERE error LIKE '%object%' OR error LIKE '%ENOENT%';
```

### 7. Daily cost burn

```sql
SELECT
  SUM(tokens_in) AS tokens_in,
  SUM(tokens_out) AS tokens_out,
  (SUM(tokens_in) / 1000000.0) * 0.2 + (SUM(tokens_out) / 1000000.0) * 0.4 AS estimated_usd
FROM audit
WHERE action LIKE '%_tokens'
  AND created_at >= NOW() - INTERVAL '1 day';
```

### 8. Citation integrity

```sql
WITH lines AS (
  SELECT jsonb_array_elements(bom->'lines') AS line
  FROM run
  WHERE created_at >= NOW() - INTERVAL '24 hours'
)
SELECT
  COUNT(*) FILTER (WHERE (line->>'assumption')::boolean = false AND line->'citation' IS NULL) AS unverified,
  COUNT(*) FILTER (WHERE (line->>'assumption')::boolean = false) AS total_non_assumption,
  CASE WHEN COUNT(*) FILTER (WHERE (line->>'assumption')::boolean = false) > 0
    THEN ROUND(
      100.0 * COUNT(*) FILTER (WHERE (line->>'assumption')::boolean = false AND line->'citation' IS NULL)
      / COUNT(*) FILTER (WHERE (line->>'assumption')::boolean = false),
      2
    )
    ELSE 0
  END AS unverified_pct
FROM lines;
```

### 9. Model repair rate

```sql
SELECT
  COUNT(*) FILTER (WHERE new_value->>'repaired' = 'true') AS repaired,
  COUNT(*) AS total,
  CASE WHEN COUNT(*) > 0
    THEN ROUND(100.0 * COUNT(*) FILTER (WHERE new_value->>'repaired' = 'true') / COUNT(*), 2)
    ELSE 0
  END AS repair_rate_pct
FROM audit
WHERE action LIKE '%_tokens'
  AND created_at >= NOW() - INTERVAL '24 hours';
```
