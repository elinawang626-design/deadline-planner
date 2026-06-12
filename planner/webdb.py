"""Shared SQLite helpers for the web API (planner.server + planner.track_api).

Same storage convention as the rest of the project: one row per entity,
(id TEXT PRIMARY KEY, data TEXT) where ``data`` is the model's JSON dump.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from pathlib import Path

TABLES = [
    "web_tasks",
    "web_blocks",
    "web_availability",
    "web_fixed_events",
    "web_settings",
    "web_task_checklist_items",
    "web_task_work_logs",
    "web_task_attachments",
    "web_task_estimates",
    "web_task_career_cards",
]


def db_path() -> Path:
    return Path(os.environ.get("PLANNER_DB", ".planner/planner.db"))


def files_root() -> Path:
    """Directory holding app-managed copies of attachments."""
    return db_path().parent / "files"


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    for table in TABLES:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
        )
    return conn


def load_all(conn: sqlite3.Connection, table: str, model: type) -> list:
    rows = conn.execute(f"SELECT data FROM {table} ORDER BY id").fetchall()
    return [model.model_validate_json(row[0]) for row in rows]


def upsert(conn: sqlite3.Connection, table: str, entity_id: str, data: str) -> None:
    conn.execute(
        f"INSERT INTO {table} (id, data) VALUES (?, ?) "
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        (entity_id, data),
    )


def delete_row(conn: sqlite3.Connection, table: str, entity_id: str) -> None:
    conn.execute(f"DELETE FROM {table} WHERE id = ?", (entity_id,))


def get_one(conn: sqlite3.Connection, table: str, model: type, entity_id: str):
    row = conn.execute(f"SELECT data FROM {table} WHERE id = ?", (entity_id,)).fetchone()
    return model.model_validate_json(row[0]) if row else None


def new_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
