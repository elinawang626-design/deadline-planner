"""Typer CLI: generate-prompt, import-output, schedule, show-day, show-week."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import typer

from planner import db
from planner.importer import ImportRejected, parse_llm_output
from planner.prompt import build_prompt
from planner.scheduler import generate_schedule
from planner.timeutils import get_timezone

DEFAULT_DB = Path(".planner/planner.db")

app = typer.Typer(help="Local-first deadline planner (no LLM API calls).")


@app.callback()
def main(
    ctx: typer.Context,
    db_path: Path = typer.Option(
        DEFAULT_DB, "--db", help="Path to the SQLite database file."
    ),
) -> None:
    ctx.obj = db_path


def _tz_or_exit() -> ZoneInfo:
    try:
        return get_timezone()
    except ValueError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(code=1)


@app.command("generate-prompt")
def generate_prompt(
    ctx: typer.Context,
    input_file: Path = typer.Option(
        ..., "--input", exists=True, readable=True, help="Raw user input text file."
    ),
) -> None:
    """Print a copy-paste prompt for your LLM of choice."""
    tz = _tz_or_exit()
    raw = input_file.read_text(encoding="utf-8")
    conn = db.connect(ctx.obj)
    try:
        prompt = build_prompt(
            raw_input=raw,
            tasks=db.load_tasks(conn),
            rules=db.load_availability_rules(conn),
            fixed_events=db.load_fixed_events(conn),
            now=datetime.now(tz),
            tz_name=str(tz),
        )
    finally:
        conn.close()
    typer.echo(prompt)


@app.command("import-output")
def import_output(
    ctx: typer.Context,
    file: Path = typer.Option(
        ..., "--file", exists=True, readable=True, help="Pasted LLM output file."
    ),
) -> None:
    """Validate pasted LLM output and upsert it into the local database."""
    raw = file.read_text(encoding="utf-8")
    try:
        parsed = parse_llm_output(raw)
    except ImportRejected as exc:
        typer.echo("Import rejected; nothing was written:", err=True)
        for error in exc.errors:
            typer.echo(f"  - {error}", err=True)
        raise typer.Exit(code=1)

    conn = db.connect(ctx.obj)
    try:
        db.upsert_parsed_input(conn, parsed)
    finally:
        conn.close()
    typer.echo(
        f"Imported: {len(parsed.tasks)} task(s), "
        f"{len(parsed.availability_rules)} availability rule(s), "
        f"{len(parsed.fixed_events)} fixed event(s)."
    )


@app.command("schedule")
def schedule(ctx: typer.Context) -> None:
    """Regenerate future auto-generated blocks and print a warning summary."""
    tz = _tz_or_exit()
    conn = db.connect(ctx.obj)
    try:
        result, delete_ids = generate_schedule(
            now=datetime.now(tz),
            tz=tz,
            tasks=db.load_tasks(conn),
            rules=db.load_availability_rules(conn),
            fixed_events=db.load_fixed_events(conn),
            existing_blocks=db.load_scheduled_blocks(conn),
        )
        db.replace_blocks(conn, delete_ids, result.blocks)
    finally:
        conn.close()

    typer.echo(f"Timezone: {tz}")
    typer.echo(
        f"Replaced {len(delete_ids)} auto block(s); scheduled {len(result.blocks)} block(s)."
    )
    if result.unscheduled_task_ids:
        typer.echo("Unscheduled tasks: " + ", ".join(result.unscheduled_task_ids))
    if result.warnings:
        typer.echo("Warnings:")
        for warning in result.warnings:
            typer.echo(f"  - {warning}")
    else:
        typer.echo("Warnings: none")


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        typer.echo(f"Error: invalid date {value!r}, expected YYYY-MM-DD", err=True)
        raise typer.Exit(code=1)


def _print_day(conn, day: date, tz: ZoneInfo) -> None:
    day_start = datetime.combine(day, time(0), tzinfo=tz)
    day_end = day_start + timedelta(days=1)
    titles = {t.id: t.title for t in db.load_tasks(conn)}

    events = [
        e
        for e in db.load_fixed_events(conn)
        if e.start_at < day_end and day_start < e.end_at
    ]
    blocks = [
        b
        for b in db.load_scheduled_blocks(conn)
        if b.start_at < day_end and day_start < b.end_at
    ]
    entries = [
        (e.start_at, e.end_at, f"[event] {e.title}") for e in events
    ] + [
        (
            b.start_at,
            b.end_at,
            f"[task]  {titles.get(b.task_id, b.task_id)}"
            + (" (locked)" if b.locked else ""),
        )
        for b in blocks
    ]
    entries.sort(key=lambda item: item[0])

    typer.echo(f"{day.isoformat()} ({day.strftime('%a')}, timezone {tz})")
    if not entries:
        typer.echo("  (nothing planned)")
        return
    for start, end, label in entries:
        local_start = start.astimezone(tz).strftime("%H:%M")
        local_end = end.astimezone(tz).strftime("%H:%M")
        typer.echo(f"  {local_start}-{local_end}  {label}")


@app.command("show-day")
def show_day(ctx: typer.Context, day: str = typer.Argument(..., metavar="YYYY-MM-DD")) -> None:
    """Show fixed events and scheduled blocks for one day."""
    tz = _tz_or_exit()
    target = _parse_date(day)
    conn = db.connect(ctx.obj)
    try:
        _print_day(conn, target, tz)
    finally:
        conn.close()


@app.command("show-week")
def show_week(ctx: typer.Context, day: str = typer.Argument(..., metavar="YYYY-MM-DD")) -> None:
    """Show Monday-Sunday of the week containing the given date."""
    tz = _tz_or_exit()
    target = _parse_date(day)
    monday = target - timedelta(days=target.weekday())
    conn = db.connect(ctx.obj)
    try:
        for offset in range(7):
            _print_day(conn, monday + timedelta(days=offset), tz)
    finally:
        conn.close()


if __name__ == "__main__":
    app()
