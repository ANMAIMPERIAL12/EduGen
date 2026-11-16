"""The RAG chat flow: retrieve (access-filtered) -> grounded answer + cited sources."""
import re
import uuid
from typing import Optional

from langchain_core.documents import Document
from langchain_core.messages import HumanMessage, SystemMessage

from app.config import get_settings
from app.generation.llm import get_llm
from app.generation.prompts import ANSWER_SYSTEM_PROMPT, HYBRID_ANSWER_SYSTEM_PROMPT
from app.memory import memory
from app.retrieval import vector_store
from app.schemas import ChatResponse, Source

NO_CONTEXT_REPLY = (
    "I couldn't find anything relevant in your course materials. "
    "Try uploading the related document or rephrasing your question."
)


FOLLOW_UP_RE = re.compile(
    r"^(and\b|also\b|what about\b|how about\b|it\b|its\b|they\b|them\b|"
    r"this\b|that\b|these\b|those\b|same\b|another\b|example\b|give me\b|"
    r"explain more\b|elaborate\b|can you elaborate\b|could you elaborate\b)",
    re.IGNORECASE,
)


def _history_turns(
    supplied: Optional[list[dict]], history: list[tuple[str, str]]
) -> list[dict[str, str]]:
    if supplied is not None:
        turns = [{"role": item["role"], "text": item["text"]} for item in supplied[-12:]]
        return _limit_history(turns)
    turns = []
    for question, answer in history:
        turns.extend(({"role": "student", "text": question}, {"role": "ai", "text": answer}))
    return _limit_history(turns[-12:])


def _limit_history(turns: list[dict[str, str]]) -> list[dict[str, str]]:
    remaining = get_settings().max_history_chars
    kept = []
    for turn in reversed(turns):
        if remaining <= 0:
            break
        text = turn["text"]
        clipped = text[-remaining:]
        kept.append({"role": turn["role"], "text": clipped})
        remaining -= len(clipped)
    return list(reversed(kept))


def _is_follow_up(question: str) -> bool:
    cleaned_question = question.strip()
    terse_follow_up = bool(re.fullmatch(r"(why|where|when|how|who|what)[?.!]*", cleaned_question, re.IGNORECASE))
    refers_back = bool(re.search(r"\b(it|its|they|them|this|that|these|those|same)\b", cleaned_question, re.IGNORECASE))
    return bool(FOLLOW_UP_RE.search(cleaned_question) or terse_follow_up or refers_back)


def _retrieval_query(question: str, history: list[dict[str, str]]) -> str:
    if not history or not _is_follow_up(question):
        return question
    previous_question = next(
        (turn["text"] for turn in reversed(history) if turn["role"] == "student"),
        None,
    )
    if not previous_question:
        return question
    return f"{previous_question}\nFollow-up: {question}"


def _history_context(history: list[dict[str, str]]) -> str:
    if not history:
        return ""
    return "Recent conversation (for resolving references only; use the provided document context as evidence):\n" + "\n".join(
        f"{turn['role'].title()}: {turn['text']}" for turn in history
    )


def _format_context(docs: list[Document]) -> str:
    blocks = []
    for i, d in enumerate(docs, start=1):
        label = d.metadata.get("filename", "document")
        page = d.metadata.get("page")
        if page:
            label += f", p.{page}"
        blocks.append(f"[{i}] ({label})\n{d.page_content}")
    return "\n\n".join(blocks)


def answer_question(
    question: str,
    user_id: str,
    course_id: str = "global",
    session_id: Optional[str] = None,
    doc_ids: Optional[list[str]] = None,
    mode: str = "strict",
    conversation_history: Optional[list[dict]] = None,
) -> ChatResponse:
    session_id = session_id or uuid.uuid4().hex
    memory_history = memory.get(user_id, session_id) if conversation_history is None else []
    history = _history_turns(conversation_history, memory_history)

    retrieval_query = _retrieval_query(question, history)
    flt = vector_store.build_access_filter(user_id, course_id, doc_ids)
    docs = vector_store.search(retrieval_query, k=get_settings().top_k, flt=flt)

    if not docs and mode == "strict":
        if conversation_history is None:
            memory.append(user_id, session_id, question, NO_CONTEXT_REPLY)
        return ChatResponse(answer=NO_CONTEXT_REPLY, sources=[], session_id=session_id)

    prompt = HYBRID_ANSWER_SYSTEM_PROMPT if mode == "hybrid" else ANSWER_SYSTEM_PROMPT
    relevant_history = history if _is_follow_up(question) else []
    messages = [
        SystemMessage(content=prompt.format(context=_format_context(docs))),
        HumanMessage(content=f"{_history_context(relevant_history)}\n\nCurrent question: {question}".strip()),
    ]
    answer = get_llm().invoke(messages).content.strip()
    if conversation_history is None:
        memory.append(user_id, session_id, question, answer)

    cited_indexes = {
        int(match) for match in re.findall(r"\[(\d+)\]", answer)
    }
    sources = [
        Source(
            doc_id=d.metadata.get("doc_id", ""),
            filename=d.metadata.get("filename", ""),
            page=d.metadata.get("page"),
            snippet=d.page_content[:300],
            scope=d.metadata.get("scope", ""),
        )
        for index, d in enumerate(docs, start=1)
        if index in cited_indexes
    ]
    return ChatResponse(
        answer=answer,
        sources=sources,
        session_id=session_id,
        grounded=bool(sources),
    )
