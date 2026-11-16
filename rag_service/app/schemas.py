from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator


class IngestResponse(BaseModel):
    doc_id: str
    filename: str
    chunks: int
    scope: Literal["private", "shared"]
    course_id: str


class HistoryTurn(BaseModel):
    role: Literal["student", "ai"]
    text: str = Field(..., min_length=1, max_length=6000)


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    user_id: str = Field(..., min_length=1, max_length=128)
    course_id: str = Field(default="global", min_length=1, max_length=128)
    session_id: Optional[str] = Field(default=None, max_length=128)
    # Optionally restrict the answer to specific documents
    doc_ids: Optional[list[str]] = Field(default=None, max_length=50)
    history: Optional[list[HistoryTurn]] = Field(default=None, max_length=12)
    mode: Literal["strict", "hybrid"] = "strict"

    @field_validator("doc_ids")
    @classmethod
    def validate_doc_ids(cls, value):
        if value is None:
            return value
        if not value:
            raise ValueError("Omit doc_ids to search all available documents, or include at least one ID")
        if any(not doc_id or len(doc_id) > 128 for doc_id in value):
            raise ValueError("Document IDs must contain 1-128 characters")
        return list(dict.fromkeys(value))


class Source(BaseModel):
    doc_id: str
    filename: str
    page: Optional[int] = None
    snippet: str
    scope: str


class ChatResponse(BaseModel):
    answer: str
    sources: list[Source]
    session_id: str
    grounded: bool = False


class DocumentInfo(BaseModel):
    doc_id: str
    filename: str
    scope: str
    course_id: str
    user_id: str
    chunks: int
