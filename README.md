# Fieldops Intelligence

![Evals](https://github.com/jakemorganlabs/field_ops_capstone/actions/workflows/evals.yml/badge.svg)

Fieldops Intelligence is a construction-proposal pipeline. It reads an intake. It extracts a project spec. It retrieves evidence. It estimates a bill of materials. It writes a proposal. It reviews the output.

NOTE: The pipeline reads the generation model from `GENERATION_MODEL_ID`. The deployed system uses `deepseek-ai/DeepSeek-V4-Flash-0731` for generation. It uses `google/gemma-4-31B-it` as the judge. The prompts were first tuned for Gemma. DeepSeek needs one named required field at each stage. See Deviation Notes.

## Guarantees

1. Schema gates check every model output against JSON Schema 2020-12.
2. The grounding rule marks a BOM line as an assumption when its citation is not verified.
3. The drift rule checks every number in the proposal against the BOM, the totals, or the spec.
4. The review loop cap is 2 regeneration rounds (`config/loop_cap.json`). A run gets up to 3 review passes.
5. A human gate marks a run as `needs_review` when the loop cannot close all issues.

## Architecture

1. An intake enters the pipeline.
2. Extraction makes a `ProjectSpec` from the intake.
3. Qualification sends the spec to `proceed`, `clarify`, or `reject`.
4. Retrieval gets chunks for `similar_projects`, `manufacturer_specs`, and `code_references`.
5. The Estimator builds a BOM and the totals.
6. The Writer makes a proposal from the BOM.
7. The Reviewer critiques the proposal. It can start a regeneration.
8. A human gate reviews each run that does not pass.
9. A renderer writes the final proposal to PDF.

## Models

| Role | Env name | Model |
| --- | --- | --- |
| Generation | `GENERATION_MODEL_ID` | `deepseek-ai/DeepSeek-V4-Flash-0731` |
| Judge | `JUDGE_MODEL_ID` | `google/gemma-4-31B-it` |
| Embedding | `EMBEDDING_MODEL_ID` | `Qwen/Qwen3-Embedding-4B` (1536-dim) |

Source: `config/pricing.json` and `deploy/.env.production`.

## Evaluation

The harness seeds an isolated corpus into a separate `fieldops_eval` database. It runs the full pipeline over 50 fixtures: 15 answerable, 10 near-miss, 10 no-evidence, and 15 adversarial. Each case runs the complete agent chain. Each case reaches a terminal state.

Retrieval is verified against the database. For sampled cases, the chunks returned for each intent match the gold documents that the case expects. The evidence files under `docs/evidence/` are real runs from the deployed system.

The metric scorer is corrected. After the pipeline ends, the harness reads each finished case back from the database. It scores each metric only against the cases that can show that metric. A clarify case has no bill of materials and no proposal. So it does not count against the structural scores. Each scorer reports the number of cases it scored. A count of zero fails the gate. The judge schema accepts extra keys, so the semantic scorer records the judge scores. The injection check reads the computed total of an adversarial run, not the proposal text. The command `npm run eval` writes the current figures to `evals/results.json`.

The eval run scored five metrics at 1.0: schema validity, calculator balance, grounding integrity, correct refusal, and idempotent ingest. Retrieval passed for `similar_projects`. Three metrics need more work. The Roadmap section gives the details.

## CI & Release

1. `Evals` is a required status check on `main`.
2. A `v*` tag creates a GitHub Release and a SLSA build-provenance attestation.
3. Release: https://github.com/jakemorganlabs/field_ops_capstone/releases/tag/v1.0.0

## Demo

Two captured runs from the deployed system show the pipeline at work:

1. A delivered proposal. A human approved it through the Cloudflare Access review queue. The system rendered it to PDF: [`docs/evidence/delivered_proposal.pdf`](docs/evidence/delivered_proposal.pdf).
2. A no-evidence intake. The job was outside the corpus. The pipeline refused to price it. It produced an assumption-only BOM. It escalated to `needs_review` instead of an invented figure: [`docs/evidence/escalation_no_evidence.json`](docs/evidence/escalation_no_evidence.json).

## Run locally

1. Install Node 22.
2. Start Postgres 18 with pgvector, or set `DATABASE_URL` to an existing instance. The deployed system runs as a systemd service against a host Postgres. It does not use a container stack.
3. Set `DATABASE_URL`, `DEEPINFRA_API_KEY`, `GENERATION_MODEL_ID`, `JUDGE_MODEL_ID`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL_ID`, and `EMBEDDING_DIMENSIONS`.
4. Run `npm ci`.
5. Run `npm run migrate`.
6. Run `npm test`.
7. Run `npm run eval` to make `evals/results.json`.
8. Run `npm run eval:gate` to check the thresholds.

## Limitations

1. The reviewer can change between a spec-driven and an evidence-driven judgment across rounds on one run. A precedence rule in the reviewer prompt would make this stable. The loop cap and the human gate bound the effect.
2. The prompts were tuned for Gemma. On DeepSeek, a stage can return an empty object when its schema does not name a concrete required field. Each stage now names one.

## Roadmap

Three metrics need more work. The eval run measured each one.

1. Reviewer calibration. The reviewer recall was 0.37. The reviewer marks revise on answerable cases that the fixtures expect it to pass. It then sends these cases to needs_review. A precedence rule in the reviewer prompt must make the reviewer mark revise only for a defect against the spec or the evidence. The same rule corrects the reviewer change in Limitation 1.
2. Qualifier calibration. The route accuracy was 0.88. Five near-miss cases continued. The fixtures expect the qualifier to return these cases for more data. The clarify threshold and the field rules need adjustment for the borderline cases.
3. Retrieval on two intents. The recall was 0.90 for `similar_projects`. The recall was 0.48 for `manufacturer_specs`. The recall was 0.52 for `code_references`. Each case has one dedicated proposal document, so `similar_projects` is strong. The corpus has only a few shared specification documents and code documents. So the other two intents use generic references. More documents for each topic must raise the recall.

## Deviation Notes

The deployment found about a dozen faults. In each fault, the committed code did not match a working end-to-end run. Each fault was diagnosed from the database (the `run`, `audit`, and `dead_letter` tables). Each fault was fixed. These are three examples:

1. The server pipeline stopped after qualification. The estimator, the writer, and the review chain were only in the evaluation runner. Live runs stayed open with no end. The chain was moved into the server path.
2. Some hand-written schemas required a field that the model was never asked to send. One case was a `run_id` that the code adds after parsing. One case was an evidence id that a no-evidence finding does not have. Each schema was aligned to the real model output.
3. The estimator wrote a terminal `completed` status in mid-pipeline. This hid later faults. The review loop now owns the terminal status.

The commit history has the full sequence.

## Portfolio

Five-link card: [`docs/portfolio_card.md`](docs/portfolio_card.md).

## Author

Jake Morgan

## License

ISC
