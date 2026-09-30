"""Small in-memory LRU cache of recent analyses.

The AI service is stateless by design; long-term storage belongs to the Express backend. The cache
only lets clients fetch the images / CSV of a recent analysis by id without re-running the models.
"""

import threading
from collections import OrderedDict
from dataclasses import dataclass

from app.core.config import settings


@dataclass
class StoredAnalysis:
    result: dict
    annotated_jpeg: bytes
    filtered_jpeg: bytes


class AnalysisStore:
    def __init__(self, capacity: int):
        self.capacity = max(1, capacity)
        self._items: OrderedDict[str, StoredAnalysis] = OrderedDict()
        self._lock = threading.Lock()

    def put(self, key: str, item: StoredAnalysis):
        with self._lock:
            self._items[key] = item
            self._items.move_to_end(key)
            while len(self._items) > self.capacity:
                self._items.popitem(last=False)

    def __len__(self) -> int:
        return len(self._items)

    def get(self, key: str) -> StoredAnalysis | None:
        with self._lock:
            item = self._items.get(key)
            if item is not None:
                self._items.move_to_end(key)
            return item


analysis_cache = AnalysisStore(settings.cache_size)
