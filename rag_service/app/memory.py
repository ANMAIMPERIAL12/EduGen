"""Bounded in-process history for direct RAG API callers; the LMS supplies DB history itself."""
from collections import OrderedDict, deque
from threading import Lock
from time import monotonic

from app.config import get_settings


class ChatMemory:
    def __init__(self) -> None:
        self._store: OrderedDict[tuple[str, str], tuple[deque, float]] = OrderedDict()
        self._lock = Lock()

    def _prune(self, now: float) -> None:
        settings = get_settings()
        expired = [
            key for key, (_, touched) in self._store.items()
            if now - touched > settings.chat_session_ttl_seconds
        ]
        for key in expired:
            self._store.pop(key, None)
        while len(self._store) > settings.max_chat_sessions:
            self._store.popitem(last=False)

    def get(self, user_id: str, session_id: str) -> list[tuple[str, str]]:
        with self._lock:
            now = monotonic()
            self._prune(now)
            key = (user_id, session_id)
            item = self._store.get(key)
            if item is None:
                return []
            history, _ = item
            self._store[key] = (history, now)
            self._store.move_to_end(key)
            return list(history)

    def append(self, user_id: str, session_id: str, question: str, answer: str) -> None:
        limit = get_settings().max_history_turns
        with self._lock:
            now = monotonic()
            self._prune(now)
            key = (user_id, session_id)
            item = self._store.get(key)
            q = item[0] if item else deque()
            q.append((question, answer))
            while len(q) > limit:
                q.popleft()
            self._store[key] = (q, now)
            self._store.move_to_end(key)
            self._prune(now)


memory = ChatMemory()
