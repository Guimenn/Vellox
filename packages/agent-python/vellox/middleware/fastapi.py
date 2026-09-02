import re
import time
import uuid
from typing import Callable
from ..agent import VelloxAgent

UUID_REGEX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
OBJECT_ID_REGEX = re.compile(r"^[0-9a-f]{24}$", re.I)
NUM_ID_REGEX = re.compile(r"^\d+$")


def normalize_route(path: str) -> str:
    """Normalizes dynamic path parameters to prevent high cardinality."""
    parts = path.strip("/").split("/")
    if not parts or parts == [""]:
        return "/"

    normalized = []
    for part in parts:
        if NUM_ID_REGEX.match(part):
            normalized.append(":id")
        elif UUID_REGEX.match(part):
            normalized.append(":uuid")
        elif OBJECT_ID_REGEX.match(part):
            normalized.append(":objectId")
        else:
            normalized.append(part)

    return "/" + "/".join(normalized)


class VelloxMiddleware:
    """
    Zero-overhead ASGI Middleware for FastAPI / Starlette applications.
    """

    def __init__(self, app: Callable, agent: VelloxAgent = None):
        self.app = app
        self.agent = agent or VelloxAgent.get_instance()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        start_time = time.perf_counter()
        raw_path = scope.get("path", "/")
        method = scope.get("method", "GET").upper()
        route = normalize_route(raw_path)
        trace_id = f"trace-{uuid.uuid4().hex[:12]}"
        status_code = 200

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
                # Inject trace ID header
                headers = list(message.get("headers", []))
                headers.append((b"x-vellox-trace-id", trace_id.encode("utf-8")))
                message["headers"] = headers

            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = (time.perf_counter() - start_time) * 1000.0

            self.agent.record_http({
                "route": route,
                "method": method,
                "statusCode": status_code,
                "durationMs": round(duration_ms, 3),
                "traceId": trace_id,
            })
