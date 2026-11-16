from functools import lru_cache
from typing import Literal
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ---- Chat LLM (any OpenAI-compatible API: Groq by default) ----
    llm_api_key: str = ""
    llm_base_url: str = "https://api.groq.com/openai/v1"
    llm_model: str = "openai/gpt-oss-120b"

    # ---- Embeddings: local (free, default) or openai ----
    embedding_provider: Literal["local", "openai"] = "local"
    local_embedding_model: str = "BAAI/bge-small-en-v1.5"
    openai_api_key: str = ""  # only needed if embedding_provider=openai
    embedding_model: str = "text-embedding-3-small"  # openai embeddings model

    service_api_key: str = ""
    cors_origins: list[str] = ["http://localhost:5173"]
    chroma_dir: str = "./data/chroma"
    collection_name: str = "lms_documents"
    shared_docs_dir: str = "./data/shared_docs"

    chunk_size: int = Field(default=800, ge=200, le=4000)
    chunk_overlap: int = Field(default=120, ge=0, le=1000)
    top_k: int = Field(default=6, ge=1, le=20)
    max_upload_mb: int = Field(default=20, ge=1, le=200)
    max_extracted_chars_per_file: int = Field(default=2000000, ge=1000)
    max_history_turns: int = Field(default=6, ge=1, le=20)
    max_history_chars: int = Field(default=6000, ge=500, le=20000)
    max_private_docs_per_user: int = Field(default=0, ge=0)
    max_chunks_per_document: int = Field(default=2500, ge=1)
    max_chat_sessions: int = Field(default=2000, ge=1)
    chat_session_ttl_seconds: int = Field(default=21600, ge=60)
    llm_timeout_seconds: int = Field(default=45, ge=1, le=300)
    llm_max_retries: int = Field(default=1, ge=0, le=5)
    llm_max_output_tokens: int = Field(default=1200, ge=128, le=4096)
    environment: Literal["development", "production"] = "development"

    @model_validator(mode="after")
    def validate_chunk_overlap(self):
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError("CHUNK_OVERLAP must be smaller than CHUNK_SIZE")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
