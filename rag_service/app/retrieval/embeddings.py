from functools import lru_cache
from langchain_core.embeddings import Embeddings
from app.config import get_settings


@lru_cache
def get_embeddings() -> Embeddings:
    s = get_settings()
    if s.embedding_provider == "local":
        # Free, runs on your machine (model downloads on first use, ~130 MB).
        from langchain_huggingface import HuggingFaceEmbeddings

        return HuggingFaceEmbeddings(model_name=s.local_embedding_model)

    if s.embedding_provider != "openai":
        raise ValueError("EMBEDDING_PROVIDER must be 'local' or 'openai'")
    if not s.openai_api_key:
        raise ValueError("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai")

    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(
        model=s.embedding_model,
        api_key=s.openai_api_key,
        request_timeout=s.llm_timeout_seconds,
        max_retries=s.llm_max_retries,
        chunk_size=100,
    )
