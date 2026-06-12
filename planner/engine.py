"""Shared deterministic scheduling engine (15-minute granularity).

Used by the CLI scheduler, the web server and mirrored by the frontend mock
scheduler so every surface follows the same rules:

- Range: from now (snapped up to the 15-minute grid) to the latest task
  deadline, capped at 90 days. Tasks due later get a ``beyond_horizon``
  warning and only use slots inside the range.
- Phase 1 never exceeds the daily planned-minutes cap. Work is balanced
  across the days before each deadline (lower-load days first) with a mild
  preference for earlier days, and preferred windows act as a score bonus
  that never overrides deadlines or the cap.
- Phase 2 runs only for work that cannot fit before its deadline under the
  cap. It may exceed the cap but never overlaps other occupied time or runs
  past the deadline, and it spreads the unavoidable overload so the highest
  single-day overload stays minimal.
- Fixed events and kept blocks occupy time; only task blocks count toward
  the daily load cap.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo
from typing import Optional, Sequence

SLOT_MINUTES = 15
DEFAULT_CHUNK_MINUTES = 60
MAX_HORIZON_DAYS = 90

# Score weights (phase 1). Balance dominates, then preferred windows, then
# chunk size (favor contiguous ~60 min runs), then a mild earlier-day bonus.
BALANCE_WEIGHT = 100.0
PREFERRED_BONUS = 15.0
CHUNK_BONUS = 5.0
EARLY_DAY_PENALTY = 2.0
# Balancing denominator when no daily cap is configured.
FALLBACK_DAY_MINUTES = 8 * 60

DEFAULT_WINDOW_MINUTES = (9 * 60, 17 * 60)


@dataclass(frozen=True)
class EngineTask:
    id: str
    deadline: datetime
    remaining_minutes: int
    priority_rank: int
    splittable: bool = True
    earliest_start_at: Optional[datetime] = None
    min_block_minutes: Optional[int] = None
    max_block_minutes: Optional[int] = None
    # (python weekday Mon=0, start minute of day, end minute of day)
    preferred_windows: tuple[tuple[int, int, int], ...] = ()


@dataclass(frozen=True)
class EngineBlock:
    task_id: str
    start_at: datetime
    end_at: datetime
    overloaded: bool = False  # placed in phase 2 above the daily cap


@dataclass(frozen=True)
class EngineWarning:
    # beyond_horizon | partial | no_slot | non_splittable | overload
    kind: str
    task_id: str
    day: Optional[date] = None
    requested_minutes: int = 0
    placed_minutes: int = 0
    cap_minutes: int = 0
    extra_minutes: int = 0


@dataclass(frozen=True)
class TaskStat:
    task_id: str
    placed_minutes: int
    remaining_minutes: int


@dataclass(frozen=True)
class EngineResult:
    blocks: list[EngineBlock]
    warnings: list[EngineWarning]
    stats: list[TaskStat]
    horizon_end: datetime


def snap_up(value: datetime) -> datetime:
    """Snap a datetime up to the next 15-minute grid point."""
    base = value.replace(
        minute=value.minute - value.minute % SLOT_MINUTES, second=0, microsecond=0
    )
    return base if base == value else base + timedelta(minutes=SLOT_MINUTES)


def _span_minutes(start: datetime, end: datetime) -> int:
    return int((end - start).total_seconds() // 60)


def _subtract_busy(
    span: tuple[datetime, datetime], busy: Sequence[tuple[datetime, datetime]]
) -> list[tuple[datetime, datetime]]:
    """Remove busy intervals from one span; result is sorted and disjoint."""
    pieces = [span]
    for b_start, b_end in busy:
        next_pieces: list[tuple[datetime, datetime]] = []
        for p_start, p_end in pieces:
            if b_end <= p_start or p_end <= b_start:
                next_pieces.append((p_start, p_end))
                continue
            if p_start < b_start:
                next_pieces.append((p_start, b_start))
            if b_end < p_end:
                next_pieces.append((b_end, p_end))
        pieces = next_pieces
    return pieces


def _build_free_intervals(
    days: Sequence[date],
    tz: tzinfo,
    windows_by_weekday: dict[int, list[tuple[int, int]]],
    busy: Sequence[tuple[datetime, datetime]],
    horizon_start: datetime,
    horizon_end: datetime,
) -> dict[date, list[tuple[datetime, datetime]]]:
    """Free intervals per day: availability minus busy, snapped to the grid.

    When no availability is configured at all, every day defaults to
    09:00-17:00; once any window exists, only configured weekdays are usable.
    """
    free: dict[date, list[tuple[datetime, datetime]]] = {}
    for day in days:
        if windows_by_weekday:
            windows = windows_by_weekday.get(day.weekday(), [])
        else:
            windows = [DEFAULT_WINDOW_MINUTES]
        midnight = datetime.combine(day, time(0), tzinfo=tz)
        intervals: list[tuple[datetime, datetime]] = []
        for start_min, end_min in sorted(windows):
            span_start = max(midnight + timedelta(minutes=start_min), horizon_start)
            span_end = min(midnight + timedelta(minutes=end_min), horizon_end)
            if span_start >= span_end:
                continue
            for piece_start, piece_end in _subtract_busy((span_start, span_end), busy):
                piece_start = snap_up(piece_start)
                if _span_minutes(piece_start, piece_end) >= SLOT_MINUTES:
                    intervals.append((piece_start, piece_end))
        intervals.sort()
        free[day] = intervals
    return free


def _in_preferred(start: datetime, windows: tuple[tuple[int, int, int], ...]) -> bool:
    start_min = start.hour * 60 + start.minute
    return any(wd == start.weekday() and ws <= start_min < we for wd, ws, we in windows)


def _capacity_before_deadline(
    task: EngineTask,
    days: Sequence[date],
    free: dict[date, list[tuple[datetime, datetime]]],
    day_load: dict[date, int],
    cap: Optional[int],
) -> int:
    total = 0
    for day in days:
        day_minutes = 0
        for iv_start, iv_end in free.get(day, []):
            clipped_end = min(iv_end, task.deadline)
            if iv_start < clipped_end:
                day_minutes += _span_minutes(iv_start, clipped_end)
        if cap is not None:
            day_minutes = min(day_minutes, max(0, cap - day_load.get(day, 0)))
        total += day_minutes
    return total


@dataclass(frozen=True)
class _Candidate:
    score: tuple
    day: date
    interval_index: int
    start: datetime
    chunk: int


def _desired_chunk(task: EngineTask) -> int:
    desired = max(DEFAULT_CHUNK_MINUTES, task.min_block_minutes or SLOT_MINUTES)
    if task.max_block_minutes:
        desired = min(desired, task.max_block_minutes)
    return max(SLOT_MINUTES, desired)


def _candidate_starts(
    lo: datetime, hi: datetime, day: date, task: EngineTask, tz: tzinfo
) -> list[datetime]:
    starts = [lo]
    midnight = datetime.combine(day, time(0), tzinfo=tz)
    for wd, ws, _we in task.preferred_windows:
        if wd != day.weekday():
            continue
        window_start = snap_up(midnight + timedelta(minutes=ws))
        if lo < window_start < hi:
            starts.append(window_start)
    return sorted(set(starts))


def _find_candidates(
    task: EngineTask,
    remaining: int,
    days: Sequence[date],
    free: dict[date, list[tuple[datetime, datetime]]],
    day_load: dict[date, int],
    cap: Optional[int],
    tz: tzinfo,
    overload_allowed: bool,
) -> list[_Candidate]:
    desired = _desired_chunk(task)
    min_block = task.min_block_minutes or SLOT_MINUTES
    denom = cap if cap else FALLBACK_DAY_MINUTES
    candidates: list[_Candidate] = []
    for day_index, day in enumerate(days):
        load = day_load.get(day, 0)
        cap_left: Optional[int] = None
        if cap is not None and not overload_allowed:
            cap_left = cap - load
            if cap_left < SLOT_MINUTES:
                continue
        for iv_index, (iv_start, iv_end) in enumerate(free.get(day, [])):
            lo = iv_start
            if task.earliest_start_at and lo < task.earliest_start_at:
                lo = snap_up(task.earliest_start_at)
            hi = min(iv_end, task.deadline)
            if _span_minutes(lo, hi) < SLOT_MINUTES:
                continue
            for start in _candidate_starts(lo, hi, day, task, tz):
                avail = _span_minutes(start, hi)
                if avail < SLOT_MINUTES:
                    continue
                if not task.splittable:
                    chunk = remaining
                    if avail < chunk or (cap_left is not None and cap_left < chunk):
                        continue
                else:
                    chunk = min(remaining, desired, avail)
                    if cap_left is not None:
                        chunk = min(chunk, cap_left)
                    chunk -= chunk % SLOT_MINUTES
                    if chunk < SLOT_MINUTES:
                        continue
                    # never create a sub-min_block piece unless it finishes the task
                    if chunk < min_block and chunk < remaining:
                        continue
                preferred = _in_preferred(start, task.preferred_windows)
                if overload_allowed:
                    overload_after = max(0, load + chunk - cap) if cap is not None else 0
                    score = (-float(overload_after), -float(load + chunk), -float(day_index))
                else:
                    score = (
                        -(load / denom) * BALANCE_WEIGHT
                        + (PREFERRED_BONUS if preferred else 0.0)
                        + (chunk / desired) * CHUNK_BONUS
                        - day_index * EARLY_DAY_PENALTY,
                    )
                candidates.append(_Candidate(score, day, iv_index, start, chunk))
    return candidates


def _pick(candidates: list[_Candidate]) -> _Candidate:
    """Best score wins; ties go to the earlier day, then earlier start."""
    return max(
        candidates,
        key=lambda c: (c.score, -c.day.toordinal(), -c.start.timestamp()),
    )


def _place(
    free: dict[date, list[tuple[datetime, datetime]]], chosen: _Candidate
) -> tuple[datetime, datetime]:
    """Carve the chosen chunk out of its free interval."""
    iv_start, iv_end = free[chosen.day][chosen.interval_index]
    block_start = chosen.start
    block_end = block_start + timedelta(minutes=chosen.chunk)
    replacement: list[tuple[datetime, datetime]] = []
    if _span_minutes(iv_start, block_start) >= SLOT_MINUTES:
        replacement.append((iv_start, block_start))
    if _span_minutes(block_end, iv_end) >= SLOT_MINUTES:
        replacement.append((snap_up(block_end), iv_end))
    day_intervals = free[chosen.day]
    free[chosen.day] = (
        day_intervals[: chosen.interval_index]
        + replacement
        + day_intervals[chosen.interval_index + 1 :]
    )
    return block_start, block_end


def _schedule_task(
    task: EngineTask,
    remaining: int,
    days: Sequence[date],
    free: dict[date, list[tuple[datetime, datetime]]],
    day_load: dict[date, int],
    cap: Optional[int],
    tz: tzinfo,
    overload_allowed: bool,
    blocks: list[EngineBlock],
    overload_by_day: dict[date, int],
) -> int:
    """Greedily place chunks for one task; returns the minutes still unplaced."""
    while remaining >= SLOT_MINUTES:
        candidates = _find_candidates(
            task, remaining, days, free, day_load, cap, tz, overload_allowed
        )
        if not candidates:
            break
        chosen = _pick(candidates)
        block_start, block_end = _place(free, chosen)
        previous_load = day_load.get(chosen.day, 0)
        day_load[chosen.day] = previous_load + chosen.chunk
        overloaded = (
            overload_allowed and cap is not None and day_load[chosen.day] > cap
        )
        if overloaded:
            already_over = max(0, previous_load - cap)
            newly_over = (day_load[chosen.day] - cap) - already_over
            overload_by_day[chosen.day] = overload_by_day.get(chosen.day, 0) + newly_over
        blocks.append(
            EngineBlock(
                task_id=task.id,
                start_at=block_start,
                end_at=block_end,
                overloaded=overloaded,
            )
        )
        remaining -= chosen.chunk
        if not task.splittable:
            break
    return remaining


def schedule(
    now: datetime,
    tz: tzinfo,
    tasks: Sequence[EngineTask],
    windows_by_weekday: dict[int, list[tuple[int, int]]],
    busy: Sequence[tuple[datetime, datetime]],
    initial_day_load: dict[date, int],
    daily_max_minutes: Optional[int],
) -> EngineResult:
    """Compute new blocks for the given tasks. Pure: no persistence."""
    now_local = now.astimezone(tz)
    horizon_start = snap_up(now_local)
    horizon_cap = now_local + timedelta(days=MAX_HORIZON_DAYS)
    latest_deadline = max((t.deadline for t in tasks), default=horizon_start)
    horizon_end = min(max(latest_deadline, horizon_start), horizon_cap)

    days: list[date] = []
    day = horizon_start.date()
    while day <= horizon_end.date():
        days.append(day)
        day += timedelta(days=1)

    free = _build_free_intervals(
        days, tz, windows_by_weekday, busy, horizon_start, horizon_end
    )
    day_load = dict(initial_day_load)
    cap = daily_max_minutes

    warnings: list[EngineWarning] = []
    pending = [t for t in tasks if t.remaining_minutes > 0]
    ordered = sorted(
        pending,
        key=lambda t: (
            t.deadline,
            _capacity_before_deadline(t, days, free, day_load, cap),
            t.priority_rank,
            t.id,
        ),
    )

    blocks: list[EngineBlock] = []
    overload_by_day: dict[date, int] = {}
    remaining_by_task: dict[str, int] = {}
    requested_by_task: dict[str, int] = {}
    phase2_queue: list[tuple[EngineTask, int]] = []

    for task in ordered:
        requested = -(-task.remaining_minutes // SLOT_MINUTES) * SLOT_MINUTES
        requested_by_task[task.id] = requested
        if task.deadline > horizon_cap:
            warnings.append(EngineWarning(kind="beyond_horizon", task_id=task.id))
        remaining = _schedule_task(
            task, requested, days, free, day_load, cap, tz,
            overload_allowed=False, blocks=blocks, overload_by_day=overload_by_day,
        )
        remaining_by_task[task.id] = remaining
        if remaining > 0 and cap is not None:
            phase2_queue.append((task, remaining))

    # Phase 2: only tasks that could not finish before their deadline under
    # the daily cap may overload days, as evenly and as little as possible.
    for task, remaining in phase2_queue:
        overload_before = dict(overload_by_day)
        remaining = _schedule_task(
            task, remaining, days, free, day_load, cap, tz,
            overload_allowed=True, blocks=blocks, overload_by_day=overload_by_day,
        )
        remaining_by_task[task.id] = remaining
        for day_key in sorted(overload_by_day):
            extra = overload_by_day[day_key] - overload_before.get(day_key, 0)
            if extra > 0:
                warnings.append(
                    EngineWarning(
                        kind="overload",
                        task_id=task.id,
                        day=day_key,
                        cap_minutes=cap or 0,
                        extra_minutes=extra,
                    )
                )

    stats: list[TaskStat] = []
    for task in ordered:
        requested = requested_by_task[task.id]
        remaining = remaining_by_task[task.id]
        placed = requested - remaining
        stats.append(
            TaskStat(task_id=task.id, placed_minutes=placed, remaining_minutes=remaining)
        )
        if remaining <= 0:
            continue
        if placed == 0:
            kind = "non_splittable" if not task.splittable else "no_slot"
            warnings.append(
                EngineWarning(
                    kind=kind, task_id=task.id, requested_minutes=requested
                )
            )
        else:
            warnings.append(
                EngineWarning(
                    kind="partial",
                    task_id=task.id,
                    requested_minutes=requested,
                    placed_minutes=placed,
                )
            )

    blocks.sort(key=lambda b: (b.start_at, b.task_id))
    return EngineResult(
        blocks=blocks, warnings=warnings, stats=stats, horizon_end=horizon_end
    )
