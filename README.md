# Fieldops Intelligence

![Evals (smoke)](https://github.com/jakemorganlabs/field_ops_capstone/actions/workflows/evals.yml/badge.svg)

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

The metric scorer is corrected. After the pipeline ends, the harness reads each finished case back from the database. It scores each metric only against the cases that can show that metric. A clarify case has no bill of materials and no proposal. So it does not count against the structural scores. Each scorer reports the number of cases it scored. A count of zero fails the gate. The judge client repairs the shapes the Gemma judge returns before validation (a stray token glued to the first key, the wrapper key replaced by a junk key, a stray excerpt, scores as strings). Before that repair the semantic metrics were unmeasured: 37 judge-schema failures and every dimension scored on 0 cases. On the current run 17 of 99 judge calls still fail, all in one shape where the first field is mangled beyond repair, and every priced case scored on its remaining calls. The rubric anchors 5 as best on every dimension and shows the judge the BOM, so an empty assumptions list on a BOM with no assumption lines scores as correct. The injection check reads the computed total of an adversarial run, not the proposal text. The command `npm run eval` writes the current figures to `evals/results.json`.

`npm run eval:retrieval` is a retrieval-only probe. It seeds the eval corpus, then for every case the full eval would score for recall it builds the same fixed intent queries the pipeline builds and scores recall the same way `evals/metrics/retrieval.ts` does. No model call is made, so it costs embeddings only and runs in under a minute. It is a close proxy for the retrieval metric, not the metric: the full eval derives its queries from the extracted spec rather than the intake. Use it to check a corpus change before spending a full run.

### Current figures

Full run of 2026-09-06 at commit `07c1deb`, 50 cases, 49 reached a terminal state (one failed on a generation schema error). The results file is kept as evidence at [`docs/evidence/eval_results_2026-09-06.json`](docs/evidence/eval_results_2026-09-06.json). The gate fails on one metric, reviewer recall. Every other metric passes.

| Metric | Gate | 2026-08-11 | 2026-09-06 | Cases scored |
| --- | --- | --- | --- | --- |
| Retrieval recall, `similar_projects` | 0.80 | 0.90 | 0.91 | 34 |
| Retrieval recall, `manufacturer_specs` | 0.80 | 0.48 | 0.97 | 34 |
| Retrieval recall, `code_references` | 0.80 | 0.52 | 0.94 | 34 |
| Schema validity | 1.00 | 1.00 | 1.00 | 44 |
| Calculator balance | 1.00 | 1.00 | 1.00 | 44 |
| Grounding integrity | 1.00 | 1.00 | 1.00 | 44 |
| Structural coverage | 1.00 | 1.00 | 1.00 | 44 of 44 |
| Judge: scope completeness | 3.5 | unmeasured | 5.00 | 33 |
| Judge: hallucination | 3.5 | unmeasured | 4.91 | 33 |
| Judge: assumptions surfaced | 3.5 | unmeasured | 5.00 | 33 |
| Judge: pricing narrated | 3.5 | unmeasured | 4.88 | 33 |
| Judge: concise without missing content | 3.5 | unmeasured | 4.97 | 33 |
| Route accuracy | 0.90 | 0.88 | 0.94 | 49 |
| Correct refusal | 1.00 | 1.00 | 1.00 | 10 |
| Injection obeyed | 0 | 0.07 | 0 | 15 |
| Idempotent ingest | exact | exact | exact | 15 |
| Reviewer recall | 0.85 | 0.37 | 0.75 | 44 |

The 2026-08-11 column is the run this README carried before. Its reviewer recall was measured with 37 of 38 cases ending needs_review on a revise verdict; its judge dimensions read 0 because the judge never returned a valid payload. Between the two runs the corpus, the reviewer prompt, the qualifier rules, the judge client, the refusal path, and the estimator's labor and duplicate handling all changed. The Roadmap section records what each change measured, including the two changes that made the reviewer worse and were reverted.

The badge at the top of this page is the `Evals (smoke)` workflow. On each push it seeds the eval corpus and checks retrieval recall for one answerable case. It does not run the agent chain. So it measures none of the structural, semantic, reviewer, escalation, injection, ingest, or refusal metrics, and its results file lists those sections as unmeasured. A green badge means retrieval on one case cleared the floor and nothing more. The full figures come only from `npm run eval`.

## CI & Release

1. `Evals (smoke)` is a required status check on `main`. It checks retrieval recall on one case. It does not stand in for the full eval.
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
7. Run `npm run eval:retrieval` for a fast retrieval-only check, or `npm run eval` for the full run that writes `evals/results.json`.
8. Run `npm run eval:gate` to check the thresholds.

## Limitations

1. The reviewer can change between a spec-driven and an evidence-driven judgment across rounds on one run. The reviewer prompt carries a precedence rule, and the code enforces its core: a revise verdict must name at least one error-severity defect against the spec or the evidence, or it becomes a pass with the advisory issues kept on the critique. The loop cap and the human gate still bound the effect. Reviewer recall is the one gate still failing (0.75 against 0.85); the Roadmap explains what the remaining misses are.
2. A run that ends needs_review is not a failure of the system; it is the human gate doing its job. On the current run 24 of 50 cases ended there. The eval scores them against what the fixtures expected, which is the strict reading.
3. The prompts were tuned for Gemma. On DeepSeek, a stage can return an empty object when its schema does not name a concrete required field. Each stage now names one.

## Roadmap

One metric still fails its gate. The others passed on the 2026-09-06 run. Each item below records what was measured, not what was hoped.

1. Reviewer recall, 0.37 to 0.75, gate 0.85. Five full runs on 2026-09-06 measured each change. The precedence rule alone (revise only for an error-severity defect against spec or evidence, assumptions are not defects, code text need not be restated, evidence-listed ancillary parts are not scope mismatches) took recall from 0.37 to 0.77. A four-item defect checklist added on top of it dropped recall to 0.51 on two consecutive runs by making the reviewer hunt for defects generally, and was reverted; unit basis and jurisdiction stay as named examples inside rule 1. The remaining 11 misses on expected-pass cases are mostly the reviewer catching real estimator mistakes: an item listed twice from two evidence sources, a per-device ratio not scaled to the spec's count, a labor role named in the spec and left out. The fixtures label these cases "pass" on the assumption of a correct BOM, so the honest next step is on the estimator, not the reviewer. The two misses in the other direction are adversarial cases whose seeded unit-basis defect the reviewer passed. `applyDecisionPrecedence` in `src/agents/reviewer.ts` enforces the core rule in code and logs each downgrade; on these runs the model always attached an error-severity issue to a revise, so the guard never fired.
2. Qualifier, route accuracy 0.88 to 0.94, gate 0.90. Two rules in `config/qualification_rules.json` catch the borderline intakes the fixtures describe: a scope with an indefinite quantity ("some", "several") routes to clarify because the estimator cannot size it, and a constraint that references a code (NEC, NFPA, ASHRAE, Title 24, TIA-568) with no region routes to clarify because code requirements are jurisdiction-specific. The three remaining misroutes are near-miss cases identical on every visible field to a proceed case; `tests/qualification.test.ts` names them so a change in either direction shows up. Region cannot be a required field: the no-evidence cases omit it and must reach the refusal path (measured: 0.82 when tried).
3. Retrieval, 0.48 and 0.52 to 0.97 and 0.94 on the two weak intents, gate 0.80. The cause was the corpus: 14 of 15 topics shared one generic code reference and had no specification document, so the gold for those intents was a document about Cat6A cabling in California. The corpus now carries a manufacturer specification and a code reference for every topic (58 documents, up from 30) and the fixtures point at them. `npm run eval:retrieval` (embeddings only, under a minute) measured the change before the full run and agrees with it within 0.03. The remaining misses are adversarial cases whose injected text pollutes the query.
4. Refusal path. The no-evidence escalation used to depend on the reviewer marking revise on an all-assumption BOM until the loop cap fired. When the precedence rule stopped treating assumptions as defects, correct refusal fell to 0.00 for one run. The review loop now has a deterministic gate: a BOM with no evidence-backed line is escalated to needs_review regardless of the verdict. Correct refusal is back at 1.00 on 10 cases.
5. Failed cases, 9 to 1. Four were labor lines with a rate key not in `config/labor_rates.json`; they are now recast to noted assumptions instead of crashing the calculator. The rest were generation payload shapes (`{"/prose": ...}`) that the model client now repairs before validation. The one remaining failure is a generation schema error the client cannot repair.
6. Estimator quality is the next real lever. With two documents pricing the same item per topic, the estimator listed items twice until its prompt was changed to one line per item the project needs, one source cited. The reviewer's remaining over-revises point at the same place: quantities that do not scale to the spec's count and spec-named roles left out.

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
