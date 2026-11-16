from functools import lru_cache
from langchain_openai import ChatOpenAI
from app.config import get_settings


@lru_cache
def get_llm() -> ChatOpenAI:
    """Groq, OpenRouter, OpenAI... anything OpenAI-compatible: change LLM_BASE_URL / LLM_MODEL / LLM_API_KEY."""
    s = get_settings()
    return ChatOpenAI(
        model=s.llm_model,
        api_key=s.llm_api_key,
        base_url=s.llm_base_url,
        temperature=0.2,
        timeout=s.llm_timeout_seconds,
        max_retries=s.llm_max_retries,
        max_tokens=s.llm_max_output_tokens,
    )
