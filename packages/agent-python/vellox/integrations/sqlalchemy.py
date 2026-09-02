import re
import time
from typing import Any
from ..agent import VelloxAgent

LITERAL_REGEX = re.compile(r"['\"][^'\"]*['\"]|\b\d+\b")
SPACE_REGEX = re.compile(r"\s+")


def fingerprint_sql(statement: str) -> str:
    """Normalizes SQL statement into a canonical fingerprint."""
    norm = LITERAL_REGEX.sub("?", statement.strip())
    return SPACE_REGEX.sub(" ", norm)


def bind_sqlalchemy_telemetry(engine: Any, agent: VelloxAgent = None) -> None:
    """
    Hooks into SQLAlchemy Engine execution events to capture query durations and fingerprints.
    """
    try:
        from sqlalchemy import event
    except ImportError:
        return

    active_agent = agent or VelloxAgent.get_instance()

    @event.listens_for(engine, "before_cursor_execute")
    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        conn.info.setdefault("query_start_time", []).append(time.perf_counter())

    @event.listens_for(engine, "after_cursor_execute")
    def after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        total_time = 0.0
        if "query_start_time" in conn.info and conn.info["query_start_time"]:
            start = conn.info["query_start_time"].pop()
            total_time = (time.perf_counter() - start) * 1000.0

        op = statement.strip().split()[0].upper() if statement else "SELECT"
        fingerprint = fingerprint_sql(statement)
        db_type = engine.name or "postgresql"

        active_agent.record_database({
            "databaseType": db_type,
            "operation": op,
            "fingerprint": fingerprint,
            "totalDurationMs": round(total_time, 3),
            "p50DurationMs": round(total_time, 3),
            "p95DurationMs": round(total_time, 3),
            "p99DurationMs": round(total_time, 3),
            "executionCount": 1,
            "errorCount": 0,
            "rowsReturned": cursor.rowcount if hasattr(cursor, "rowcount") and cursor.rowcount > 0 else 0,
        })
