"""Run an isolated, in-process RAG evaluation from the rag_service directory."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Any


EVAL_DIR = Path(__file__).resolve().parent
ROOT = EVAL_DIR.parent
CHROMA_DIR = EVAL_DIR / "_tmp_chroma"
COURSE_IDS = ("cn", "dbms", "oops", "os")
EVAL_USER = "rag-eval-student"
MAX_429_RETRIES = 5

OUT_OF_SCOPE_QUESTIONS = (
    ("cn", "What is the capital city of Portugal?"),
    ("cn", "How many sides does a hexagon have?"),
    ("dbms", "What is the chemical symbol for gold?"),
    ("dbms", "Why does the Moon appear bright at night?"),
    ("oops", "At what temperature does pure water freeze at standard pressure?"),
    ("oops", "Who wrote the novel Pride and Prejudice?"),
    ("os", "What is the largest planet in our solar system?"),
    ("os", "How many minutes are in two hours?"),
)


class LLMCallError(RuntimeError):
    def __init__(self, category: str, status_code: int | None, attempts: int) -> None:
        super().__init__(category)
        self.category = category
        self.status_code = status_code
        self.attempts = attempts


class RateLimitedLLM:
    def __init__(self, model: Any, delay: float) -> None:
        self._model = model
        self._delay = delay
        self._last_started: float | None = None

    @staticmethod
    def _status_code(error: Exception) -> int | None:
        status = getattr(error, "status_code", None)
        if status is None:
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None)
        return status if isinstance(status, int) else None

    def invoke(self, prompt: Any) -> Any:
        for retry in range(MAX_429_RETRIES + 1):
            if self._last_started is not None:
                wait = self._delay - (time.monotonic() - self._last_started)
                if wait > 0:
                    time.sleep(wait)
            self._last_started = time.monotonic()
            try:
                return self._model.invoke(prompt)
            except Exception as error:
                status_code = self._status_code(error)
                attempts = retry + 1
                if status_code == 429 and retry < MAX_429_RETRIES:
                    time.sleep(min(30.0, max(self._delay, 2.0**retry)))
                    continue
                category = "rate_limit" if status_code == 429 else "llm_error"
                raise LLMCallError(category, status_code, attempts) from None
        raise AssertionError("unreachable")


def _record_error(errors: list[dict[str, Any]], stage: str, question_id: str | None, error: LLMCallError) -> None:
    errors.append(
        {
            "stage": stage,
            "question_id": question_id,
            "error": error.category,
            "status_code": error.status_code,
            "attempts": error.attempts,
        }
    )


def _page_sort_key(page: Any) -> tuple[int, Any]:
    if isinstance(page, (int, float)):
        return (0, page)
    if page is None:
        return (2, "")
    return (1, str(page))


def _spread_indices(length: int, count: int) -> list[int]:
    if count <= 0 or length <= 0:
        return []
    if count >= length:
        return list(range(length))
    if count == 1:
        return [(length - 1) // 2]
    return sorted({round(i * (length - 1) / (count - 1)) for i in range(count)})


def _sample_chunks(chunks: list[Any], target: int) -> list[Any]:
    eligible: dict[str, dict[Any, list[Any]]] = defaultdict(lambda: defaultdict(list))
    for chunk in chunks:
        if len(chunk.page_content.strip()) < 300:
            continue
        filename = str(chunk.metadata.get("filename", ""))
        eligible[filename][chunk.metadata.get("page")].append(chunk)

    files = sorted(name for name, pages in eligible.items() if pages)
    if not files or target <= 0:
        return []

    chosen: list[Any] = []
    chosen_ids: set[int] = set()
    quotas = {name: target // len(files) for name in files}
    for index, name in enumerate(files[: target % len(files)]):
        quotas[name] += 1

    for name in files:
        pages = sorted(eligible[name], key=_page_sort_key)
        for page_index in _spread_indices(len(pages), quotas[name]):
            chosen.append(eligible[name][pages[page_index]][0])
            chosen_ids.add(id(chosen[-1]))

    while len(chosen) < min(target, sum(len(page_chunks) for pages in eligible.values() for page_chunks in pages.values())):
        progressed = False
        for name in files:
            for page in sorted(eligible[name], key=_page_sort_key):
                for chunk in eligible[name][page]:
                    if id(chunk) not in chosen_ids:
                        chosen.append(chunk)
                        chosen_ids.add(id(chunk))
                        progressed = True
                        break
                if progressed:
                    break
            if len(chosen) >= target:
                break
        if not progressed:
            break
    return chosen[:target]


def _round_robin_chunks(by_course: dict[str, list[Any]], limit: int | None) -> list[tuple[str, Any]]:
    selected: list[tuple[str, Any]] = []
    offset = 0
    while limit is None or len(selected) < limit:
        progressed = False
        for course_id in COURSE_IDS:
            if offset < len(by_course.get(course_id, [])):
                selected.append((course_id, by_course[course_id][offset]))
                progressed = True
                if limit is not None and len(selected) >= limit:
                    break
        if not progressed:
            break
        offset += 1
    return selected


def _parse_json_object(text: str) -> dict[str, Any]:
    start = text.find("{")
    if start < 0:
        raise ValueError("LLM response did not contain a JSON object")
    result, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(result, dict):
        raise ValueError("LLM response JSON was not an object")
    return result


def _generate_question(model: RateLimitedLLM, chunk: Any) -> tuple[str, list[str]]:
    prompt = [
        (
            "system",
            "Create one clear, specific factual question answerable only from the supplied excerpt. "
            "Do not quote the excerpt. Return only a JSON object with keys question and keywords. "
            "keywords must be an array of 3 to 5 short, exact answer concepts from the excerpt.",
        ),
        (
            "human",
            "Excerpt (use only as private evaluation input; do not reproduce it):\n"
            + chunk.page_content,
        ),
    ]
    response = model.invoke(prompt)
    item = _parse_json_object(response.content.strip())
    question = item.get("question")
    keywords = item.get("keywords")
    if (
        not isinstance(question, str)
        or not question.strip()
        or not isinstance(keywords, list)
        or not 3 <= len(keywords) <= 5
        or not all(isinstance(word, str) and word.strip() for word in keywords)
    ):
        raise ValueError("LLM response did not satisfy the question schema")
    return question.strip(), [word.strip() for word in keywords]


def _clean_page(page: Any) -> int | float | str | None:
    return page if isinstance(page, (int, float, str)) or page is None else str(page)


def _question_record(course_id: str, question: str, filename: str | None, page: Any, keywords: list[str]) -> dict[str, Any]:
    return {
        "course_id": course_id,
        "question": question,
        "source_filename": filename,
        "page": _clean_page(page),
        "keywords": keywords,
    }


def _keyword_counts(answer: str, keywords: list[str]) -> tuple[int, int]:
    normalized_answer = re.findall(r"[a-z0-9]+", answer.casefold())
    joined = " ".join(normalized_answer)
    matched = 0
    for keyword in keywords:
        normalized_keyword = " ".join(re.findall(r"[a-z0-9]+", keyword.casefold()))
        if normalized_keyword and re.search(
            rf"(?<![a-z0-9]){re.escape(normalized_keyword)}(?![a-z0-9])", joined
        ):
            matched += 1
    return matched, len(keywords)


def _is_expected_page(actual: Any, expected: Any) -> bool:
    if actual == expected:
        return True
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return abs(actual - expected) <= 1
    return False


def _is_expected_chunk(doc: Any, record: dict[str, Any]) -> bool:
    return (
        doc.metadata.get("filename") == record["source_filename"]
        and _is_expected_page(doc.metadata.get("page"), record["page"])
    )


def _ratio(successes: int, n: int) -> dict[str, Any]:
    return {
        "successes": successes,
        "n": n,
        "percent": round(100.0 * successes / n, 2) if n else None,
    }


def _metric_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    hit_count = sum(bool(row["retrieval_hit"]) for row in rows)
    mrr = sum(float(row["reciprocal_rank"]) for row in rows)
    keyword_matches = sum(row["keyword_matches"] for row in rows)
    keyword_total = sum(row["keyword_total"] for row in rows)
    labeled = [row for row in rows if row.get("judge_label") in {"correct", "partially correct", "incorrect"}]
    citations = sum(bool(row["has_citation"]) for row in rows)
    matching_citations = sum(bool(row["citation_file_matches"]) for row in rows)
    latencies = [row["chat_latency_seconds"] for row in rows if row.get("chat_latency_seconds") is not None]
    return {
        "n": len(rows),
        "retrieval_hit_at_6": _ratio(hit_count, len(rows)),
        "mrr": round(mrr / len(rows), 4) if rows else None,
        "keyword_coverage": {
            "matched": keyword_matches,
            "expected": keyword_total,
            "n": len(rows),
            "percent": round(100.0 * keyword_matches / keyword_total, 2) if keyword_total else None,
        },
        "judge": {
            "n": len(labeled),
            "correct": _ratio(sum(row["judge_label"] == "correct" for row in labeled), len(labeled)),
            "correct_or_partial": _ratio(
                sum(row["judge_label"] in {"correct", "partially correct"} for row in labeled),
                len(labeled),
            ),
            "labels": {
                label: sum(row.get("judge_label") == label for row in rows)
                for label in ("correct", "partially correct", "incorrect")
            },
        },
        "citations": {
            "with_citation": _ratio(citations, len(rows)),
            "matching_expected_file": _ratio(matching_citations, len(rows)),
        },
        "chat_latency_seconds": _latency_summary(latencies),
    }


def _latency_summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0, "median": None, "p95": None}
    ordered = sorted(values)
    p95_index = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return {
        "n": len(ordered),
        "median": round(statistics.median(ordered), 3),
        "p95": round(ordered[p95_index], 3),
    }


def _judge_answer(
    model: RateLimitedLLM,
    record: dict[str, Any],
    answer: str,
    retrieved: list[Any],
) -> str:
    excerpts = []
    for index, doc in enumerate(retrieved, start=1):
        metadata = doc.metadata
        excerpts.append(
            f"[{index}] file={metadata.get('filename', '')}, page={metadata.get('page', '')}\n"
            f"{doc.page_content}"
        )
    prompt = [
        (
            "system",
            "Judge whether the answer is supported by the retrieved excerpts and answers the question. "
            "Use the expected keywords as a checklist, not as a substitute for factual support. "
            'Return only JSON: {"label":"correct"}, {"label":"partially correct"}, or '
            '{"label":"incorrect"}. Correct means fully supported and responsive; partially correct '
            "means some correct supported content but incomplete; incorrect means unsupported or wrong.",
        ),
        (
            "human",
            f"Question: {record['question']}\n"
            f"Expected keywords: {', '.join(record['keywords'])}\n"
            f"Answer: {answer}\n"
            "Retrieved excerpts:\n"
            + ("\n\n".join(excerpts) if excerpts else "(no excerpts retrieved)"),
        ),
    ]
    response = model.invoke(prompt)
    label = _parse_json_object(response.content.strip()).get("label")
    if label not in {"correct", "partially correct", "incorrect"}:
        raise ValueError("LLM judge returned an invalid label")
    return label


def _source_summary(doc: Any) -> dict[str, Any]:
    return {
        "filename": str(doc.metadata.get("filename", "")),
        "page": _clean_page(doc.metadata.get("page")),
        "course_id": str(doc.metadata.get("course_id", "")),
        "scope": str(doc.metadata.get("scope", "")),
        "doc_id": str(doc.metadata.get("doc_id", "")),
    }


def _run_pytest() -> dict[str, Any]:
    env = os.environ.copy()
    env["CHROMA_DIR"] = str(CHROMA_DIR)
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    output = result.stdout + "\n" + result.stderr
    passed = re.search(r"(\d+) passed", output)
    failed = re.search(r"(\d+) failed", output)
    return {
        "exit_code": result.returncode,
        "passed": int(passed.group(1)) if passed else None,
        "failed": int(failed.group(1)) if failed else (0 if passed else None),
        "summary_found": bool(passed or failed),
    }


def _privacy_checks(ingest_file: Any, vector_store: Any, answer_question: Any) -> dict[str, Any]:
    checks: list[tuple[str, bool]] = []
    fd, temp_name = tempfile.mkstemp(prefix="_tmp_private_", suffix=".txt", dir=EVAL_DIR)
    os.close(fd)
    path = Path(temp_name)
    doc_id = "eval-private-isolation-check"
    marker = "RAGEVALPRIVATEQZ7319"
    try:
        path.write_text(
            f"Private evaluation marker {marker} is stored only for the privacy isolation check.",
            encoding="utf-8",
        )
        vector_store.delete_document(doc_id)
        ingest_file(
            path,
            original_name=path.name,
            user_id="eval-student-a",
            course_id="eval-private",
            scope="private",
            doc_id=doc_id,
        )
        student_a = vector_store.build_access_filter("eval-student-a", "eval-private")
        student_b = vector_store.build_access_filter("eval-student-b", "eval-private")
        a_before = vector_store.search(marker, 6, student_a)
        b_search = vector_store.search(marker, 6, student_b)
        checks.append(("student_a_can_retrieve_private", any(d.metadata.get("doc_id") == doc_id for d in a_before)))
        checks.append(("student_b_search_returns_no_private_chunk", all(d.metadata.get("doc_id") != doc_id for d in b_search)))
        b_chat = answer_question(
            f"What is the private evaluation marker {marker}?",
            user_id="eval-student-b",
            course_id="eval-private",
            session_id="eval-privacy-b",
            mode="strict",
        )
        checks.append(("student_b_chat_returns_no_private_chunk", all(s.doc_id != doc_id for s in b_chat.sources)))
        vector_store.delete_document(doc_id)
        a_after = vector_store.search(marker, 6, student_a)
        checks.append(("student_a_cannot_retrieve_after_delete", all(d.metadata.get("doc_id") != doc_id for d in a_after)))
    finally:
        vector_store.delete_document(doc_id)
        path.unlink(missing_ok=True)
    return {
        "passed": sum(ok for _, ok in checks),
        "total": len(checks),
        "checks": [{"name": name, "passed": ok} for name, ok in checks],
    }


def _build_markdown(results: dict[str, Any]) -> str:
    metrics = results["metrics"]
    courses = results["courses"]

    def pct(metric: dict[str, Any]) -> str:
        value = metric.get("percent")
        return f"{metric['successes']}/{metric['n']} ({value:.2f}%)" if value is not None else f"0/{metric['n']} (n/a)"

    def course_row(name: str, data: dict[str, Any]) -> str:
        q = data["in_scope"]
        oos = data["out_of_scope"]
        cross = data["cross_course"]
        return (
            f"| {name} | {pct(q['retrieval_hit_at_6'])} | "
            f"{q['mrr'] if q['mrr'] is not None else 'n/a'} | "
            f"{q['keyword_coverage']['matched']}/{q['keyword_coverage']['expected']} "
            f"({q['keyword_coverage']['percent'] if q['keyword_coverage']['percent'] is not None else 'n/a'}%) | "
            f"{pct(q['judge']['correct'])} | {pct(q['judge']['correct_or_partial'])} | "
            f"{pct(q['citations']['with_citation'])} | {pct(q['citations']['matching_expected_file'])} | "
            f"{pct(oos['refusal_or_ungrounded'])} | {cross['wrong_course_sources']}/{cross['n']} |"
        )

    overall = metrics["in_scope"]
    overall_oos = metrics["out_of_scope"]
    overall_cross = metrics["cross_course_leakage"]
    judge_labels = overall["judge"]["labels"]
    judge_n = overall["judge"]["n"]
    rows = [
        "# RAG evaluation results",
        "",
        f"- Run: {results['run_timestamp']}",
        f"- Questions: {results['question_counts']['in_scope']} in-scope, "
        f"{results['question_counts']['out_of_scope']} out-of-scope, "
        f"{results['question_counts']['cross_course']} cross-course.",
        f"- Config: mode `{results['config']['answer_mode']}`, LLM `{results['config']['llm_model']}`, "
        f"embedding `{results['config']['embedding_provider']}/{results['config']['embedding_model']}`, "
        f"dimension {results['config']['embedding_dimension']}, chunk size "
        f"{results['config']['chunk_size']}, overlap {results['config']['chunk_overlap']}, "
        f"top_k {results['config']['top_k']}, delay {results['config']['llm_delay_seconds']} s.",
        "",
        "## Metrics",
        "",
        "| Scope | Hit@6 | MRR | Keyword coverage | Judge correct | Judge correct+partial | Answers with citation | Cited expected file | OOS refusal/ungrounded | Wrong-course sources |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        course_row(
            "Overall",
            {
                "in_scope": overall,
                "out_of_scope": {"refusal_or_ungrounded": overall_oos["refusal_or_ungrounded"]},
                "cross_course": overall_cross,
            },
        ),
    ]
    for course_id in COURSE_IDS:
        if course_id in courses:
            rows.append(course_row(course_id, courses[course_id]))

    rows.extend(
        [
            "",
            "Hit@6 and MRR are measured over in-scope questions (n shown in the numerator/denominator). "
            "Keyword coverage is matched/expected keyword count. Citation file match and judge rates use "
            "completed in-scope answers; judge n excludes calls that did not produce a valid label.",
            f"Overall judge label counts (n={judge_n}): {judge_labels['correct']} correct, "
            f"{judge_labels['partially correct']} partially correct, {judge_labels['incorrect']} incorrect.",
            "",
            "## Privacy and performance",
            "",
            f"- Automated privacy checks: **{results['privacy']['passed']}/{results['privacy']['total']} passed**.",
            f"- Chat latency over {results['performance']['chat_latency_seconds']['n']} completed answers: "
            f"median {results['performance']['chat_latency_seconds']['median']} s; "
            f"p95 {results['performance']['chat_latency_seconds']['p95']} s.",
            f"- Embedding dimension: {results['config']['embedding_dimension']}; "
            f"chunk size/overlap: {results['config']['chunk_size']}/{results['config']['chunk_overlap']}; "
            f"top_k: {results['config']['top_k']}.",
            "",
            "| Shared PDF | Course | Ingest seconds | Chunks |",
            "|---|---|---:|---:|",
        ]
    )
    for document in results["ingested_pdfs"]:
        rows.append(
            f"| {document['filename']} | {document['course_id']} | "
            f"{document['ingest_seconds']:.3f} | {document['chunks']} |"
        )

    pytest_result = results["pytest"]
    if results.get("temporary_store_removed"):
        cleanup_line = (
            "- Temporary vector store removed after the run."
            if not results.get("temporary_store_cleanup_error")
            else "- In-process temporary-store cleanup hit "
            f"`{results['temporary_store_cleanup_error']}`; the store was removed after the evaluator exited."
        )
    else:
        cleanup_line = (
            f"- Temporary vector-store cleanup failed ({results['temporary_store_cleanup_error']}); "
            "remove `eval/_tmp_chroma/` before sharing."
            if results.get("temporary_store_cleanup_error")
            else "- Temporary vector store removed after the run."
        )
    rows.extend(
        [
            "",
            f"- `python -m pytest -q`: passed **{pytest_result['passed']}**, "
            f"failed **{pytest_result['failed']}**, exit code {pytest_result['exit_code']}."
            if pytest_result["summary_found"]
            else f"- `python -m pytest -q`: exit code {pytest_result['exit_code']}; pytest did not emit a parsed pass/fail summary.",
            cleanup_line,
            "",
            "## Five worst in-scope failures",
            "",
        ]
    )
    if results["worst_failures"]:
        rows.extend(
            [
                "| Question ID | Expected | Retrieved top-6 | Failure signals |",
                "|---|---|---|---|",
            ]
        )
        for failure in results["worst_failures"]:
            expected = f"{failure['expected']['filename']} p.{failure['expected']['page']}"
            retrieved = ", ".join(
                f"{item['filename']} p.{item['page']}" for item in failure["retrieved"]
            ) or "(none)"
            signals = ", ".join(failure["failure_signals"])
            rows.append(f"| {failure['question_id']} | {expected} | {retrieved} | {signals} |")
    else:
        rows.append("No in-scope failures were observed in the completed cases.")

    judge_limits = (
        "Judge results are not ground truth: an LLM judge can be inconsistent, biased toward its own phrasing, "
        "or misread context, and shares the answer model/provider unless configured otherwise."
        if results["config"]["judge_enabled"]
        else "LLM judging was disabled; no judge accuracy is reported."
    )
    rows.extend(
        [
            "",
            "## Limitations",
            "",
            judge_limits,
            "The evaluation is limited to the sampled PDF chunks, generated questions, current local corpus, "
            "and this model/configuration. It does not establish broad factual correctness.",
            "",
            "## Project-report paragraph",
            "",
            results["report_paragraph"],
            "",
        ]
    )
    return "\n".join(rows)


def _report_paragraph(results: dict[str, Any]) -> str:
    q = results["metrics"]["in_scope"]
    oos = results["metrics"]["out_of_scope"]["refusal_or_ungrounded"]
    cross = results["metrics"]["cross_course_leakage"]
    latency = results["performance"]["chat_latency_seconds"]
    tests = results["pytest"]

    def fmt(metric: dict[str, Any]) -> str:
        value = metric.get("percent")
        return f"{metric['successes']}/{metric['n']} ({value:.2f}%)" if value is not None else f"{metric['successes']}/{metric['n']} (not available)"

    judge_correct = fmt(q["judge"]["correct"])
    judge_partial = fmt(q["judge"]["correct_or_partial"])
    keyword = q["keyword_coverage"]
    keyword_text = (
        f"{keyword['matched']}/{keyword['expected']} expected keywords ({keyword['percent']:.2f}%)"
        if keyword["percent"] is not None
        else f"{keyword['matched']}/{keyword['expected']} expected keywords (not available)"
    )
    citation_text = fmt(q["citations"]["with_citation"])
    citation_file_text = fmt(q["citations"]["matching_expected_file"])
    test_text = f"{tests['passed']} passed and {tests['failed']} failed" if tests["summary_found"] else f"exit code {tests['exit_code']} (summary unavailable)"
    return (
        f"On {q['n']} generated in-scope questions across {len(COURSE_IDS)} courses, retrieval achieved "
        f"hit@6 {fmt(q['retrieval_hit_at_6'])} and MRR {q['mrr'] if q['mrr'] is not None else 'not available'}. "
        f"Answer keyword coverage was {keyword_text}; the LLM judge labeled {judge_correct} correct and "
        f"{judge_partial} correct or partially correct. Citations appeared in {citation_text} of answers, "
        f"and the cited source file matched the expected file in {citation_file_text}. "
        f"The hybrid out-of-scope general-answer/ungrounded criterion passed for {fmt(oos)}; cross-course "
        f"leakage was {cross['wrong_course_sources']} wrong-course sources across {cross['n']} questions. "
        f"Automated privacy checks passed {results['privacy']['passed']}/{results['privacy']['total']}; "
        f"chat latency across {latency['n']} completed answers was median {latency['median']} s and "
        f"p95 {latency['p95']} s. The test suite reported {test_text}."
    )


def _run(per_course: int, limit: int | None, delay: float, no_judge: bool) -> dict[str, Any]:
    os.environ["CHROMA_DIR"] = str(CHROMA_DIR)
    os.chdir(ROOT)

    if CHROMA_DIR.exists():
        shutil.rmtree(CHROMA_DIR)

    from app.config import get_settings
    from app.generation import chain
    from app.generation.llm import get_llm
    from app.ingestion.loaders import SUPPORTED_EXTENSIONS
    from app.ingestion.pipeline import ingest_file
    from app.retrieval import vector_store

    settings = get_settings()
    model = RateLimitedLLM(get_llm(), delay)
    chain.get_llm = lambda: model

    shared_root = Path(settings.shared_docs_dir)
    shared_files = sorted(
        path
        for path in shared_root.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if not shared_files:
        raise RuntimeError("No supported shared documents were found")

    ingested_pdfs: list[dict[str, Any]] = []
    doc_courses: dict[str, str] = {}
    for path in shared_files:
        relative = path.relative_to(shared_root)
        course_id = relative.parts[0] if len(relative.parts) > 1 else "global"
        doc_id = "shared-" + hashlib.sha1(str(relative).encode()).hexdigest()[:16]
        doc_courses[doc_id] = course_id
        vector_store.delete_document(doc_id)
        started = time.perf_counter()
        _, chunk_count = ingest_file(
            path,
            original_name=path.name,
            user_id="system",
            course_id=course_id,
            scope="shared",
            doc_id=doc_id,
        )
        elapsed = time.perf_counter() - started
        if path.suffix.lower() == ".pdf":
            ingested_pdfs.append(
                {
                    "filename": path.name,
                    "course_id": course_id,
                    "ingest_seconds": round(elapsed, 3),
                    "chunks": chunk_count,
                }
            )

    embedding_dimension = len(vector_store.get_vector_store()._embedding_function.embed_query("dimension probe"))
    sampled_by_course: dict[str, list[Any]] = {}
    for course_id in COURSE_IDS:
        where = vector_store.build_access_filter(EVAL_USER, course_id)
        stored = vector_store.get_vector_store()._collection.get(
            where=where,
            include=["documents", "metadatas"],
        )
        chunks = []
        for content, metadata in zip(stored.get("documents") or [], stored.get("metadatas") or []):
            if metadata.get("scope") == "shared" and metadata.get("course_id") == course_id:
                from langchain_core.documents import Document

                chunks.append(Document(page_content=content, metadata=metadata))
        sampled_by_course[course_id] = _sample_chunks(chunks, per_course)

    selected_chunks = _round_robin_chunks(sampled_by_course, limit)
    questions: dict[str, list[dict[str, Any]]] = {
        "in_scope": [],
        "out_of_scope": [],
        "cross_course": [],
    }
    errors: list[dict[str, Any]] = []
    in_scope_ids: list[str] = []
    for index, (course_id, chunk) in enumerate(selected_chunks, start=1):
        question_id = f"Q{index:04d}"
        try:
            question, keywords = _generate_question(model, chunk)
        except LLMCallError as error:
            _record_error(errors, "question_generation", question_id, error)
            continue
        except ValueError:
            errors.append(
                {
                    "stage": "question_generation",
                    "question_id": question_id,
                    "error": "invalid_response_schema",
                    "status_code": None,
                    "attempts": 1,
                }
            )
            continue
        questions["in_scope"].append(
            _question_record(
                course_id,
                question,
                str(chunk.metadata.get("filename", "")),
                chunk.metadata.get("page"),
                keywords,
            )
        )
        in_scope_ids.append(question_id)

    for course_id, question in OUT_OF_SCOPE_QUESTIONS:
        questions["out_of_scope"].append(_question_record(course_id, question, None, None, []))

    source_by_course: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in questions["in_scope"]:
        source_by_course[record["course_id"]].append(record)
    available_sources = [record for course_id in COURSE_IDS for record in source_by_course[course_id]]
    for index in range(4):
        if not available_sources:
            break
        source = source_by_course[COURSE_IDS[index]][0] if source_by_course[COURSE_IDS[index]] else available_sources[index % len(available_sources)]
        source_course = source["course_id"]
        target_course = COURSE_IDS[(COURSE_IDS.index(source_course) + 1 + index // len(COURSE_IDS)) % len(COURSE_IDS)]
        if target_course == source_course:
            target_course = COURSE_IDS[(COURSE_IDS.index(source_course) + 1) % len(COURSE_IDS)]
        questions["cross_course"].append(
            _question_record(
                target_course,
                source["question"],
                source["source_filename"],
                source["page"],
                source["keywords"],
            )
        )

    question_path = EVAL_DIR / "questions.json"
    question_path.write_text(json.dumps(questions, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    in_scope_rows: list[dict[str, Any]] = []
    chat_latencies: list[float] = []
    for index, record in enumerate(questions["in_scope"], start=1):
        question_id = in_scope_ids[index - 1]
        access_filter = vector_store.build_access_filter(EVAL_USER, record["course_id"])
        retrieved = vector_store.search(record["question"], 6, access_filter)
        matching_rank = next((rank for rank, doc in enumerate(retrieved, start=1) if _is_expected_chunk(doc, record)), None)
        started = time.perf_counter()
        response = chain.answer_question(
            record["question"],
            user_id=EVAL_USER,
            course_id=record["course_id"],
            session_id=f"eval-{question_id}",
            mode="hybrid",
        )
        chat_latency = time.perf_counter() - started
        chat_latencies.append(chat_latency)
        keyword_matches, keyword_total = _keyword_counts(response.answer, record["keywords"])
        has_citation = bool(re.search(r"\[\d+\]", response.answer))
        citation_file_matches = has_citation and any(
            source.filename == record["source_filename"] for source in response.sources
        )
        row: dict[str, Any] = {
            "question_id": question_id,
            "course_id": record["course_id"],
            "expected": {
                "filename": record["source_filename"],
                "page": record["page"],
            },
            "retrieved": [_source_summary(doc) for doc in retrieved],
            "retrieval_hit": matching_rank is not None,
            "reciprocal_rank": 1.0 / matching_rank if matching_rank else 0.0,
            "keyword_matches": keyword_matches,
            "keyword_total": keyword_total,
            "has_citation": has_citation,
            "citation_file_matches": citation_file_matches,
            "chat_latency_seconds": round(chat_latency, 6),
            "judge_label": None,
        }
        if not no_judge:
            try:
                row["judge_label"] = _judge_answer(model, record, response.answer, retrieved)
            except LLMCallError as error:
                _record_error(errors, "answer_judge", question_id, error)
            except ValueError:
                errors.append(
                    {
                        "stage": "answer_judge",
                        "question_id": question_id,
                        "error": "invalid_response_schema",
                        "status_code": None,
                        "attempts": 1,
                    }
                )
        in_scope_rows.append(row)

    out_of_scope_rows: list[dict[str, Any]] = []
    for index, record in enumerate(questions["out_of_scope"], start=1):
        response = chain.answer_question(
            record["question"],
            user_id=EVAL_USER,
            course_id=record["course_id"],
            session_id=f"eval-O{index:03d}",
            mode="hybrid",
        )
        out_of_scope_rows.append(
            {
                "question_id": f"O{index:03d}",
                "course_id": record["course_id"],
                "ungrounded": response.grounded is False and not response.sources,
            }
        )

    cross_course_rows: list[dict[str, Any]] = []
    for index, record in enumerate(questions["cross_course"], start=1):
        access_filter = vector_store.build_access_filter(EVAL_USER, record["course_id"])
        retrieved = vector_store.search(record["question"], 6, access_filter)
        response = chain.answer_question(
            record["question"],
            user_id=EVAL_USER,
            course_id=record["course_id"],
            session_id=f"eval-X{index:03d}",
            mode="hybrid",
        )
        returned = {_source_summary(doc)["doc_id"]: _source_summary(doc) for doc in retrieved}
        for source in response.sources:
            returned[source.doc_id] = {
                "doc_id": source.doc_id,
                "filename": source.filename,
                "page": _clean_page(source.page),
                "course_id": doc_courses.get(source.doc_id, ""),
                "scope": source.scope,
            }
        wrong_sources = [
            source
            for source in returned.values()
            if source["scope"] == "shared" and source["course_id"] not in {record["course_id"], "global"}
        ]
        cross_course_rows.append(
            {
                "question_id": f"X{index:03d}",
                "course_id": record["course_id"],
                "wrong_course_sources": len(wrong_sources),
                "retrieved": [
                    {key: value for key, value in source.items() if key != "doc_id"}
                    for source in returned.values()
                ],
            }
        )

    privacy = _privacy_checks(ingest_file, vector_store, chain.answer_question)
    pytest_result = _run_pytest()

    course_metrics: dict[str, Any] = {}
    for course_id in COURSE_IDS:
        scope_group = [row for row in in_scope_rows if row["course_id"] == course_id]
        oos_group = [row for row in out_of_scope_rows if row["course_id"] == course_id]
        cross_group = [row for row in cross_course_rows if row["course_id"] == course_id]
        course_metrics[course_id] = {
            "in_scope": _metric_summary(scope_group),
            "out_of_scope": {
                "n": len(oos_group),
                "refusal_or_ungrounded": _ratio(sum(row["ungrounded"] for row in oos_group), len(oos_group)),
            },
            "cross_course": {
                "n": len(cross_group),
                "wrong_course_sources": sum(row["wrong_course_sources"] for row in cross_group),
            },
        }
    metrics = {
        "in_scope": _metric_summary(in_scope_rows),
        "out_of_scope": {
            "n": len(out_of_scope_rows),
            "refusal_or_ungrounded": _ratio(
                sum(row["ungrounded"] for row in out_of_scope_rows),
                len(out_of_scope_rows),
            ),
        },
        "cross_course_leakage": {
            "n": len(cross_course_rows),
            "wrong_course_sources": sum(row["wrong_course_sources"] for row in cross_course_rows),
        },
    }

    def failure_score(row: dict[str, Any]) -> tuple[float, str]:
        score = 0.0
        signals = []
        if not row["retrieval_hit"]:
            score += 5.0
            signals.append("retrieval miss")
        if row.get("judge_label") == "incorrect":
            score += 4.0
            signals.append("judge incorrect")
        elif row.get("judge_label") == "partially correct":
            score += 2.0
            signals.append("judge partial")
        if not row["has_citation"]:
            score += 1.0
            signals.append("no citation")
        if row["has_citation"] and not row["citation_file_matches"]:
            score += 1.0
            signals.append("citation file mismatch")
        if row["keyword_total"]:
            score += 1.0 - row["keyword_matches"] / row["keyword_total"]
            if row["keyword_matches"] < row["keyword_total"]:
                signals.append("incomplete keyword coverage")
        return score, ", ".join(signals)

    worst_failures = []
    ranked = sorted(
        ((failure_score(row), row) for row in in_scope_rows),
        key=lambda item: (-item[0][0], item[1]["question_id"]),
    )
    for (score, signals), row in ranked:
        if score <= 0:
            continue
        worst_failures.append(
            {
                "question_id": row["question_id"],
                "expected": row["expected"],
                "retrieved": row["retrieved"],
                "failure_signals": signals.split(", ") if signals else [],
            }
        )
        if len(worst_failures) == 5:
            break

    config_data = {
        "chroma_dir": str(CHROMA_DIR),
        "shared_docs_dir": str(shared_root.resolve()),
        "answer_mode": "hybrid",
        "llm_model": settings.llm_model,
        "embedding_provider": settings.embedding_provider,
        "embedding_model": settings.embedding_model if settings.embedding_provider == "openai" else settings.local_embedding_model,
        "embedding_dimension": embedding_dimension,
        "chunk_size": settings.chunk_size,
        "chunk_overlap": settings.chunk_overlap,
        "top_k": settings.top_k,
        "llm_delay_seconds": delay,
        "judge_enabled": not no_judge,
    }
    results: dict[str, Any] = {
        "run_timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "config": config_data,
        "question_counts": {
            "in_scope": len(questions["in_scope"]),
            "out_of_scope": len(questions["out_of_scope"]),
            "cross_course": len(questions["cross_course"]),
        },
        "ingested_pdfs": ingested_pdfs,
        "metrics": metrics,
        "courses": course_metrics,
        "privacy": privacy,
        "performance": {"chat_latency_seconds": _latency_summary(chat_latencies)},
        "pytest": pytest_result,
        "errors": errors,
        "worst_failures": worst_failures,
        "question_results": in_scope_rows,
        "out_of_scope_results": out_of_scope_rows,
        "cross_course_results": cross_course_rows,
    }
    results["report_paragraph"] = _report_paragraph(results)
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--per-course", type=int, default=10, help="Maximum sampled in-scope chunks per course.")
    parser.add_argument(
        "--limit",
        type=int,
        help="Cap total in-scope questions, distributed round-robin across courses; out-of-scope/cross-course cases remain separate.",
    )
    parser.add_argument("--no-judge", action="store_true", help="Skip LLM answer-judge calls.")
    parser.add_argument("--delay", type=float, default=2.5, help="Minimum seconds between LLM call attempts.")
    args = parser.parse_args()
    if args.per_course < 1:
        parser.error("--per-course must be at least 1")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.delay < 0:
        parser.error("--delay must not be negative")

    os.environ["CHROMA_DIR"] = str(CHROMA_DIR)
    os.chdir(ROOT)
    try:
        results = _run(args.per_course, args.limit, args.delay, args.no_judge)
    except Exception as error:
        if CHROMA_DIR.exists():
            shutil.rmtree(CHROMA_DIR, ignore_errors=True)
        print(
            f"Evaluation stopped ({type(error).__name__}); exception details were suppressed "
            "to avoid exposing configuration secrets."
        )
        return 1

    from app.retrieval import vector_store

    store = vector_store.get_vector_store()
    store._client.close()
    vector_store.get_vector_store.cache_clear()
    del store
    gc.collect()
    cleanup_error: str | None = None
    if CHROMA_DIR.exists():
        try:
            shutil.rmtree(CHROMA_DIR)
        except OSError as error:
            cleanup_error = type(error).__name__
    results["temporary_store_cleanup_error"] = cleanup_error
    results["temporary_store_removed"] = not CHROMA_DIR.exists()
    results["report_paragraph"] = _report_paragraph(results)
    results_path = EVAL_DIR / "results.json"
    markdown_path = EVAL_DIR / "results.md"
    results_path.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    markdown_path.write_text(_build_markdown(results), encoding="utf-8")
    print(markdown_path.read_text(encoding="utf-8"))
    if cleanup_error:
        print(f"Temporary vector-store cleanup failed ({cleanup_error}); remove eval/_tmp_chroma before sharing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
