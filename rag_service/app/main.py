import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import get_settings

logger = logging.getLogger(__name__)


def _warm_components() -> None:
    from app.config import get_settings
    from app.generation.llm import get_llm
    from app.retrieval.embeddings import get_embeddings
    from app.retrieval.vector_store import get_vector_store

    settings = get_settings()
    if not settings.llm_api_key:
        raise RuntimeError("LLM_API_KEY must be configured before starting the RAG service")
    if settings.environment.lower() == "production" and not settings.service_api_key:
        raise RuntimeError("SERVICE_API_KEY must be configured in production")
    get_llm()
    get_embeddings().embed_query("EduGen startup warmup")
    get_vector_store()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load local model weights and open Chroma before serving traffic, avoiding a slow first request.
    try:
        await asyncio.to_thread(_warm_components)
    except Exception:
        logger.exception("RAG startup warmup failed")
        raise
    yield


app = FastAPI(title="LMS RAG Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["X-API-Key", "Content-Type"],
)

app.include_router(router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}
