"""SQLite persistence. Centralizes serialization and transactions.

Each entity is stored as one row: (id TEXT PRIMARY KEY, data TEXT) where
``data`` is the model's JSON dump (datetimes as ISO 8601 with offsets).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable, Sequence

from planner.models import (
    AvailabilityRule,
    FixedEvent,
    ParsedInput,
    ParsedTask,
    ScheduledBlock,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS availability_rules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fixed_events (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled_blocks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA)
    return conn


def _upsert_rows(
    conn: sqlite3.Connection, table: str, rows: Iterable[tuple[str, str]]
) -> None:
    conn.executemany(
        f"INSERT INTO {table} (id, data) VALUES (?, ?) "
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        list(rows),
    )


def upsert_parsed_input(conn: sqlite3.Connection, parsed: ParsedInput) -> None:
    """Upsert tasks, rules and fixed events by id in one transaction.

    Records not present in ``parsed`` are kept untouched.
    """
    with conn:
        _upsert_rows(conn, "tasks", ((t.id, t.model_dump_json()) for t in parsed.tasks))
        _upsert_rows(
            conn,
            "availability_rules",
            ((r.id, r.model_dump_json()) for r in parsed.availability_rules),
        )
        _upsert_rows(
            conn,
            "fixed_events",
            ((e.id, e.model_dump_json()) for e in parsed.fixed_events),
        )


def _load_all(conn: sqlite3.Connection, table: str, model: type) -> list:
    rows = conn.execute(f"SELECT data FROM {table} ORDER BY id").fetchall()
    return [model.model_validate_json(row[0]) for row in rows]


def load_tasks(conn: sqlite3.Connection) -> list[ParsedTask]:
    return _load_all(conn, "tasks", ParsedTask)


def load_availability_rules(conn: sqlite3.Connection) -> list[AvailabilityRule]:
    return _load_all(conn, "availability_rules", AvailabilityRule)


def load_fixed_events(conn: sqlite3.Connection) -> list[FixedEvent]:
    return _load_all(conn, "fixed_events", FixedEvent)


def load_scheduled_blocks(conn: sqlite3.Connection) -> list[ScheduledBlock]:
    return _load_all(conn, "scheduled_blocks", ScheduledBlock)


def replace_blocks(
    conn: sqlite3.Connection,
    delete_ids: Sequence[str],
    new_blocks: Sequence[ScheduledBlock],
) -> None:
    """Delete the given block ids and insert new blocks in one transaction."""
    with conn:
        conn.executemany(
            "DELETE FROM scheduled_blocks WHERE id = ?", [(i,) for i in delete_ids]
        )
        _upsert_rows(
            conn,
            "scheduled_blocks",
            ((b.id, b.model_dump_json()) for b in new_blocks),
        )
