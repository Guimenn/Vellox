import json
import logging
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional
import urllib.request
import urllib.error

logger = logging.getLogger("vellox")


class VelloxAgent:
    _instance: Optional["VelloxAgent"] = None
    _lock = threading.Lock()

    def __init__(
        self,
        service_name: str = "python-service",
        collector_url: str = "http://localhost:3000",
        flush_interval_seconds: float = 5.0,
        max_buffer_size: int = 5000,
    ):
        self.service_name = service_name
        self.collector_url = collector_url.rstrip("/")
        self.flush_interval_seconds = flush_interval_seconds
        self.max_buffer_size = max_buffer_size

        self._http_buffer: deque = deque(maxlen=max_buffer_size)
        self._db_buffer: deque = deque(maxlen=max_buffer_size)
        self._buffer_lock = threading.Lock()

        self._running = True
        self._worker_thread = threading.Thread(
            target=self._flush_loop, daemon=True, name="Vellox-FlushWorker"
        )
        self._worker_thread.start()

    @classmethod
    def get_instance(cls, **kwargs) -> "VelloxAgent":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(**kwargs)
            return cls._instance

    def record_http(self, telemetry: Dict[str, Any]) -> None:
        """Records an HTTP endpoint metric without blocking the caller."""
        telemetry["service"] = self.service_name
        if "timestamp" not in telemetry:
            telemetry["timestamp"] = int(time.time() * 1000)

        with self._buffer_lock:
            self._http_buffer.append(telemetry)

    def record_database(self, telemetry: Dict[str, Any]) -> None:
        """Records a database query metric without blocking the caller."""
        telemetry["service"] = self.service_name
        if "timestamp" not in telemetry:
            telemetry["timestamp"] = int(time.time() * 1000)

        with self._buffer_lock:
            self._db_buffer.append(telemetry)

    def flush(self) -> None:
        """Synchronously flushes all buffered telemetry to the collector."""
        with self._buffer_lock:
            if not self._http_buffer and not self._db_buffer:
                return

            http_items = list(self._http_buffer)
            db_items = list(self._db_buffer)
            self._http_buffer.clear()
            self._db_buffer.clear()

        batch_payload = {
            "batchId": f"batch-py-{int(time.time() * 1000)}",
            "service": self.service_name,
            "timestamp": int(time.time() * 1000),
            "httpMetrics": http_items,
            "databaseMetrics": db_items,
        }

        try:
            url = f"{self.collector_url}/api/v1/telemetry/batches"
            data = json.dumps(batch_payload).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                pass
        except Exception as e:
            # Principle 10: Telemetry collection failure must never crash the host application
            logger.debug(f"[Vellox] Collector flush failed (ignoring gracefully): {e}")

    def _flush_loop(self) -> None:
        while self._running:
            time.sleep(self.flush_interval_seconds)
            try:
                self.flush()
            except Exception:
                pass

    def shutdown(self) -> None:
        self._running = False
        self.flush()
