# RAG evaluation results

- Run: 2026-11-15T11:09:49+0530
- Questions: 40 in-scope, 8 out-of-scope, 4 cross-course.
- Config: mode `hybrid`, LLM `openai/gpt-oss-120b`, embedding `local/BAAI/bge-small-en-v1.5`, dimension 384, chunk size 800, overlap 120, top_k 6, delay 2.5 s.

## Metrics

| Scope | Hit@6 | MRR | Keyword coverage | Judge correct | Judge correct+partial | Answers with citation | Cited expected file | OOS refusal/ungrounded | Wrong-course sources |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Overall | 36/40 (90.00%) | 0.825 | 97/128 (75.78%) | 38/40 (95.00%) | 38/40 (95.00%) | 17/40 (42.50%) | 17/40 (42.50%) | 8/8 (100.00%) | 0/4 |
| cn | 10/10 (100.00%) | 0.95 | 22/32 (68.75%) | 10/10 (100.00%) | 10/10 (100.00%) | 5/10 (50.00%) | 5/10 (50.00%) | 2/2 (100.00%) | 0/1 |
| dbms | 10/10 (100.00%) | 1.0 | 25/33 (75.76%) | 10/10 (100.00%) | 10/10 (100.00%) | 6/10 (60.00%) | 6/10 (60.00%) | 2/2 (100.00%) | 0/1 |
| oops | 6/10 (60.00%) | 0.4 | 25/31 (80.65%) | 8/10 (80.00%) | 8/10 (80.00%) | 4/10 (40.00%) | 4/10 (40.00%) | 2/2 (100.00%) | 0/1 |
| os | 10/10 (100.00%) | 0.95 | 25/32 (78.12%) | 10/10 (100.00%) | 10/10 (100.00%) | 2/10 (20.00%) | 2/10 (20.00%) | 2/2 (100.00%) | 0/1 |

Hit@6 and MRR are measured over in-scope questions (n shown in the numerator/denominator). Keyword coverage is matched/expected keyword count. Citation file match and judge rates use completed in-scope answers; judge n excludes calls that did not produce a valid label.
Overall judge label counts (n=40): 38 correct, 0 partially correct, 2 incorrect.

## Privacy and performance

- Automated privacy checks: **4/4 passed**.
- Chat latency over 40 completed answers: median 10.117 s; p95 14.032 s.
- Embedding dimension: 384; chunk size/overlap: 800/120; top_k: 6.

| Shared PDF | Course | Ingest seconds | Chunks |
|---|---|---:|---:|
| Computer Networking Notes for Tech Placements.pdf | cn | 2.560 | 39 |
| DBMS_Notes.pdf | dbms | 3.573 | 60 |
| oops_java.pdf | oops | 6.055 | 50 |
| oops_py.pdf | oops | 5.878 | 46 |
| Operating System Notes Placement.pdf | os | 1.789 | 30 |

- `python -m pytest -q`: passed **8**, failed **0**, exit code 0.
- In-process temporary-store cleanup hit `PermissionError`; the store was removed after the evaluator exited.

## Five worst in-scope failures

| Question ID | Expected | Retrieved top-6 | Failure signals |
|---|---|---|---|
| Q0015 | oops_java.pdf p.23 | oops_py.pdf p.19, oops_py.pdf p.20, oops_py.pdf p.7, oops_java.pdf p.9, oops_java.pdf p.3, oops_java.pdf p.6 | retrieval miss, judge incorrect, no citation, incomplete keyword coverage |
| Q0011 | oops_java.pdf p.15 | oops_java.pdf p.20, oops_py.pdf p.20, oops_java.pdf p.21, oops_java.pdf p.27, oops_py.pdf p.9, oops_py.pdf p.6 | retrieval miss, judge incorrect, no citation |
| Q0003 | oops_java.pdf p.1 | oops_java.pdf p.6, oops_java.pdf p.5, oops_java.pdf p.7, oops_java.pdf p.5, oops_java.pdf p.9, oops_java.pdf p.8 | retrieval miss, no citation, incomplete keyword coverage |
| Q0023 | oops_py.pdf p.1 | oops_py.pdf p.20, oops_py.pdf p.6, oops_py.pdf p.7, oops_py.pdf p.19, oops_py.pdf p.8, oops_py.pdf p.9 | retrieval miss, no citation |
| Q0017 | Computer Networking Notes for Tech Placements.pdf p.8 | Computer Networking Notes for Tech Placements.pdf p.8, Computer Networking Notes for Tech Placements.pdf p.8, Computer Networking Notes for Tech Placements.pdf p.6, Computer Networking Notes for Tech Placements.pdf p.11, Computer Networking Notes for Tech Placements.pdf p.7, Computer Networking Notes for Tech Placements.pdf p.6 | no citation, incomplete keyword coverage |

## Limitations

Judge results are not ground truth: an LLM judge can be inconsistent, biased toward its own phrasing, or misread context, and shares the answer model/provider unless configured otherwise.
The evaluation is limited to the sampled PDF chunks, generated questions, current local corpus, and this model/configuration. It does not establish broad factual correctness.

## Project-report paragraph

On 40 generated in-scope questions across 4 courses, retrieval achieved hit@6 36/40 (90.00%) and MRR 0.825. Answer keyword coverage was 97/128 expected keywords (75.78%); the LLM judge labeled 38/40 (95.00%) correct and 38/40 (95.00%) correct or partially correct. Citations appeared in 17/40 (42.50%) of answers, and the cited source file matched the expected file in 17/40 (42.50%). The hybrid out-of-scope general-answer/ungrounded criterion passed for 8/8 (100.00%); cross-course leakage was 0 wrong-course sources across 4 questions. Automated privacy checks passed 4/4; chat latency across 40 completed answers was median 10.117 s and p95 14.032 s. The test suite reported 8 passed and 0 failed.
