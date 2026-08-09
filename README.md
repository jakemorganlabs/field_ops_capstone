# Fieldops Intelligence

![Evals](https://github.com/jakemorganlabs/field_ops_capstone/actions/workflows/evals.yml/badge.svg)

A construction-proposal pipeline. It extracts a project spec from an intake, retrieves evidence, estimates a bill of materials, writes a proposal, and reviews the output.

NOTE: The pipeline reads the generation model from `GENERATION_MODEL_ID`. The full local eval uses `google/gemma-4-26B-A4B-it`. The CI smoke eval uses `deepseek-ai/DeepSeek-V4-Flash` for speed.

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

| Role | Env name | CI smoke eval | Full local eval |
| --- | --- | --- | --- |
| Generation | `GENERATION_MODEL_ID` | `deepseek-ai/DeepSeek-V4-Flash` | `google/gemma-4-26B-A4B-it` |
| Judge | `JUDGE_MODEL_ID` | stored as a GitHub secret | stored as a GitHub secret |
| Embedding | `EMBEDDING_MODEL_ID` | `Qwen/Qwen3-Embedding-4B` | `Qwen/Qwen3-Embedding-4B` |

Source: `.github/workflows/evals.yml` and `config/pricing.json`

## Evaluation

CI runs a fast smoke eval (`npm run eval:smoke`) that seeds the corpus and checks retrieval recall against the eval gold sources. The full eval (`npm run eval`) can be run locally.

| Metric | Threshold | CI smoke value |
| --- | --- | --- |
| Retrieval recall at k, similar_projects | 0.80 | 1.00 |
| Retrieval recall at k, manufacturer_specs | 0.80 | 1.00 |
| Retrieval recall at k, code_references | 0.80 | 1.00 |
| Schema validity | 1.00 | 1.00 |
| Calculator balance | 1.00 | 1.00 |
| Grounding integrity | 1.00 | 1.00 |
| Judge min average per dimension | 3.50 | 5.00 |
| Judge max variance | 1.00 | 0.00 |
| Reviewer recall | 0.85 | 1.00 |
| Injection obeyed | 0 | 0 |
| Idempotent ingest | exact | exact |

Source: `evals/thresholds.json`

## CI & Release

- `Evals` is a required status check on `main`.
- Pushing a `v*` tag creates a GitHub Release and a SLSA build-provenance attestation.
- Release: https://github.com/jakemorganlabs/field_ops_capstone/releases/tag/v1.0.0

## Demo

A local intake smoke test exercises the signed `/intake` endpoint, qualification routing, and idempotency. See [`docs/evidence/intake_smoke.log`](docs/evidence/intake_smoke.log).

## Run locally

1. Install Node 22.
2. Start Postgres with pgvector. Use `docker-compose.dev.yml` or a local database.
3. Set `DATABASE_URL`, `DEEPINFRA_API_KEY`, `GENERATION_MODEL_ID`, `JUDGE_MODEL_ID`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL_ID`, and `EMBEDDING_DIMENSIONS`.
4. Run `npm ci`.
5. Run `npm run migrate`.
6. Run `npm test`.
7. Run `npm run eval` to generate `evals/results.json`.
8. Run `npm run eval:gate` to check thresholds.

## Portfolio

Five-link card: [`docs/portfolio_card.md`](docs/portfolio_card.md).

## Author

Jake Morgan

## License

ISC
