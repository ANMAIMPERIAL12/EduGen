import logging
import tempfile
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.config import get_settings
from app.generation.chain import answer_question
from app.ingestion.loaders import SUPPORTED_EXTENSIONS
from app.ingestion.pipeline import ingest_file
from app.retrieval import vector_store
from app.schemas import ChatRequest, ChatResponse, DocumentInfo, IngestResponse
from app.security import verify_api_key

router = APIRouter(dependencies=[Depends(verify_api_key)])
logger = logging.getLogger(__name__)


# NOTE: plain `def` routes on purpose: LangChain/OpenAI calls are blocking, so FastAPI runs them in a threadpool.


@router.post("/ingest", response_model=IngestResponse)
def ingest(
    file: UploadFile = File(...),
    user_id: str = Form(..., min_length=1, max_length=128),
    course_id: str = Form("global", min_length=1, max_length=128),
    scope: Literal["private", "shared"] = Form("private"),
):
    s = get_settings()
    ext = Path(file.filename or "").suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Allowed: {sorted(SUPPORTED_EXTENSIONS)}")

    if not file.filename or len(file.filename) > 255:
        raise HTTPException(400, "Filename must be between 1 and 255 characters")

    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / f"upload{ext}"
        max_bytes = s.max_upload_mb * 1024 * 1024
        total_bytes = 0
        with dest.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > max_bytes:
                    raise HTTPException(413, f"File larger than {s.max_upload_mb} MB")
                out.write(chunk)
        if total_bytes == 0:
            raise HTTPException(400, "Uploaded file is empty")
        if scope == "private" and s.max_private_docs_per_user > 0:
            docs = vector_store.list_documents(user_id)
            private_count = sum(1 for doc in docs if doc["scope"] == "private")
            if private_count >= s.max_private_docs_per_user:
                raise HTTPException(
                    429,
                    f"Private document limit reached ({s.max_private_docs_per_user})",
                    headers={"X-Private-Document-Limit": str(s.max_private_docs_per_user)},
                )
        try:
            doc_id, n = ingest_file(
                dest, original_name=file.filename, user_id=user_id, course_id=course_id, scope=scope
            )
        except ValueError as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            logger.exception("Document indexing failed")
            raise HTTPException(503, "Document indexing is temporarily unavailable") from e
    return IngestResponse(doc_id=doc_id, filename=file.filename, chunks=n, scope=scope, course_id=course_id)


@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    try:
        return answer_question(
            question=req.question,
            user_id=req.user_id,
            course_id=req.course_id,
            session_id=req.session_id,
            doc_ids=req.doc_ids,
            mode=req.mode,
            conversation_history=(
                [{"role": turn.role, "text": turn.text} for turn in req.history]
                if req.history is not None else None
            ),
        )
    except Exception as e:
        logger.exception("RAG chat request failed")
        raise HTTPException(503, "The document question service is temporarily unavailable") from e


@router.get("/documents", response_model=list[DocumentInfo])
def documents(user_id: str, course_id: Optional[str] = None):
    try:
        return vector_store.list_documents(user_id, course_id)
    except Exception as e:
        logger.exception("Document listing failed")
        raise HTTPException(503, "The document index is temporarily unavailable") from e


@router.delete("/documents/{doc_id}")
def delete_document(doc_id: str, user_id: str, allow_shared: bool = False):
    metas = vector_store.get_doc_metadatas({"doc_id": doc_id})
    if not metas:
        raise HTTPException(404, "Document not found")
    meta = metas[0]
    if meta.get("scope") == "shared":
        if not allow_shared:
            raise HTTPException(403, "Shared documents cannot be deleted by this request")
    elif meta.get("user_id") != user_id:
        raise HTTPException(403, "You can only delete your own documents")
    try:
        vector_store.delete_document(doc_id)
        return {"deleted": doc_id}
    except Exception as e:
        logger.exception("Document deletion failed")
        raise HTTPException(503, "The document index is temporarily unavailable") from e
