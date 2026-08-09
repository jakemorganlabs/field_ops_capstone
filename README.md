# Fieldops Intelligence

![Evals](https://github.com/jakemorganlabs/field_ops_capstone/actions/workflows/evals.yml/badge.svg)

A construction-proposal pipeline. It extracts a project spec from an intake, retrieves evidence, estimates a bill of materials, writes a proposal, and reviews the output.

## Guarantees

1. Schema gates validate every LLM output against JSON Schema 2020-12.
2. The grounding rule marks any BOM line as an assumption if its citation is not verified.
3. The drift rule checks that every number in the proposal matches the BOM, totals, or spec.
4. The review loop cap is 2 iterations (`config/loop_cap.json`).
5. A human gate flags runs as `needs_review` when the loop cannot close all issues.

## Architecture

1. Intake enters the pipeline.
2. Extraction turns the intake into a `ProjectSpec`.
3. Qualification routes the spec to `proceed`, `clarify`, or `reject`.
4. Retrieval fetches chunks for `similar_projects`, `manufacturer_specs`, and `code_references`.
5. The Estimator builds a BOM and totals.
6. The Writer turns the BOM into a proposal.
7. The Reviewer critiques the proposal and triggers regeneration.
8. A human gate reviews runs that do not pass.
9. A PDF renderer outputs the final proposal.

## Models

| Role | Env name | Current model |
| --- | --- | --- |
| Generation | `GENERATION_MODEL_ID` | `deepseek-ai/DeepSeek-V4-Flash` |
| Judge | `JUDGE_MODEL_ID` | stored as a GitHub secret |
| Embedding | `EMBEDDING_MODEL_ID` | `Qwen/Qwen3-Embedding-4B` |

Source: `.github/workflows/evals.yml`

## Evaluation

NOTE: `evals/results.json` does not exist yet. True values are `__AFTER_DEPLOY__`.

| Metric | Threshold | True value |
| --- | --- | --- |
| Retrieval recall at k, similar_projects | 0.80 | __AFTER_DEPLOY__ |
| Retrieval recall at k, manufacturer_specs | 0.80 | __AFTER_DEPLOY__ |
| Retrieval recall at k, code_references | 0.80 | __AFTER_DEPLOY__ |
| Schema validity | 1.00 | __AFTER_DEPLOY__ |
| Calculator balance | 1.00 | __AFTER_DEPLOY__ |
| Grounding integrity | 1.00 | __AFTER_DEPLOY__ |
| Judge min average per dimension | 3.50 | __AFTER_DEPLOY__ |
| Judge max variance | 1.00 | __AFTER_DEPLOY__ |
| Reviewer recall | 0.85 | __AFTER_DEPLOY__ |
| Injection obeyed | 0 | __AFTER_DEPLOY__ |
| Idempotent ingest | exact | __AFTER_DEPLOY__ |

Source: `evals/thresholds.json`

## Known limitations

- The evaluation results file does not exist yet. The weakest result is therefore unknown.
- The dashboard is deferred.

## Deviation note

The runtime is a TypeScript orchestrator. It runs with `node --experimental-strip-types`. The object store is a filesystem adapter behind an S3-shaped interface. A MinIO backend may replace it later. The dashboard is deferred.

## Demo

No live demo evidence exists in `docs/evidence/`. The demo URL is __AFTER_DEPLOY__.

## Run locally

1. Install Node 22.
2. Start Postgres with pgvector. Use `docker-compose.dev.yml` or a local database.
3. Set `DATABASE_URL`, `DEEPINFRA_API_KEY`, `GENERATION_MODEL_ID`, `JUDGE_MODEL_ID`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL_ID`, and `EMBEDDING_DIMENSIONS`.
4. Run `npm ci`.
5. Run `npm run migrate`.
6. Run `npm test`.
7. Run `npm run eval` to generate `evals/results.json`.
8. Run `npm run eval:gate` to check thresholds.

## Author

Jake Morgan

## License

ISC
