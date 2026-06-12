"""Tests for the shared load-aware scheduling engine."""
from datetime import date, timedelta, timezone

from planner.engine import EngineTask, schedule
from tests.conftest import dt

UTC = timezone.utc
# 2026-06-10 is a Wednesday.
NOW = dt(2026, 6, 10, 8, 30)
D0 = date(2026, 6, 10)
D1 = date(2026, 6, 11)


def make(task_id="t1", deadline=None, minutes=60, priority=1, **extra):
    return EngineTask(
        id=task_id,
        deadline=deadline or dt(2026, 6, 24, 17),
        remaining_minutes=minutes,
        priority_rank=priority,
        **extra,
    )


def run(tasks, windows=None, busy=(), load=None, cap=None, now=NOW):
    return schedule(
        now=now,
        tz=UTC,
        tasks=list(tasks),
        windows_by_weekday=windows or {},
        busy=list(busy),
        initial_day_load=dict(load or {}),
        daily_max_minutes=cap,
    )


def minutes_by_day(blocks):
    out = {}
    for b in blocks:
        key = b.start_at.date()
        out[key] = out.get(key, 0) + int((b.end_at - b.start_at).total_seconds() // 60)
    return out


def total_minutes(blocks):
    return sum(int((b.end_at - b.start_at).total_seconds() // 60) for b in blocks)


def assert_no_overlap(blocks):
    spans = sorted((b.start_at, b.end_at) for b in blocks)
    for (s1, e1), (s2, _) in zip(spans, spans[1:]):
        assert e1 <= s2, f"overlap between {e1} and {s2}"


def test_phase1_never_exceeds_daily_cap_when_capacity_is_enough():
    task = make(minutes=20 * 60, deadline=dt(2026, 6, 20, 17))
    result = run([task], cap=240)
    by_day = minutes_by_day(result.blocks)
    assert by_day and all(v <= 240 for v in by_day.values())
    assert total_minutes(result.blocks) == 20 * 60
    assert all(not b.overloaded for b in result.blocks)
    assert result.warnings == []


def test_work_is_balanced_and_moderately_front_loaded():
    task = make(minutes=8 * 60, deadline=dt(2026, 6, 14, 17))
    result = run([task], cap=480)
    by_day = minutes_by_day(result.blocks)
    # spread over several days instead of stuffing the first day
    assert len(by_day) >= 4
    assert max(by_day.values()) <= 120
    # earlier days carry at least as much as later ones (mild front-load)
    assert by_day[D0] == max(by_day.values())
    assert_no_overlap(result.blocks)


def test_overload_only_when_capacity_is_insufficient_and_is_spread():
    task = make(minutes=10 * 60, deadline=dt(2026, 6, 12, 17))
    result = run([task], cap=120)
    by_day = minutes_by_day(result.blocks)
    assert total_minutes(result.blocks) == 10 * 60
    overload = {d: v - 120 for d, v in by_day.items() if v > 120}
    # 600 needed - 360 normal capacity = 240 forced overload, spread out
    assert sum(overload.values()) == 240
    assert max(overload.values()) <= 120
    overload_warnings = [w for w in result.warnings if w.kind == "overload"]
    assert {w.day for w in overload_warnings} == set(overload)
    assert all(w.extra_minutes > 0 and w.cap_minutes == 120 for w in overload_warnings)


def test_no_overload_when_normal_capacity_suffices():
    task = make(minutes=4 * 60, deadline=dt(2026, 6, 12, 17))
    result = run([task], cap=120)
    by_day = minutes_by_day(result.blocks)
    assert all(v <= 120 for v in by_day.values())
    assert not [w for w in result.warnings if w.kind == "overload"]


def test_fixed_events_block_slots_but_do_not_count_toward_load():
    busy = [(dt(2026, 6, 10, 9), dt(2026, 6, 10, 13))]
    task = make(minutes=240, deadline=dt(2026, 6, 10, 17))
    result = run([task], busy=busy, cap=240)
    assert total_minutes(result.blocks) == 240
    assert all(b.start_at >= dt(2026, 6, 10, 13) for b in result.blocks)
    assert not [w for w in result.warnings if w.kind == "overload"]


def test_existing_blocks_count_toward_daily_load():
    task = make(minutes=180, deadline=dt(2026, 6, 10, 17))
    result = run([task], load={D0: 180}, cap=240)
    # only one hour of capacity left today; the rest is forced overload
    phase1 = [b for b in result.blocks if not b.overloaded]
    assert total_minutes(phase1) == 60


def test_15_minute_task_gets_one_slot():
    task = make(minutes=15, deadline=dt(2026, 6, 10, 17))
    result = run([task], cap=240)
    assert len(result.blocks) == 1
    assert total_minutes(result.blocks) == 15


def test_min_and_max_block_minutes_are_respected():
    task = make(
        minutes=180,
        deadline=dt(2026, 6, 10, 17),
        min_block_minutes=90,
        max_block_minutes=90,
    )
    result = run([task])
    lengths = sorted(
        int((b.end_at - b.start_at).total_seconds() // 60) for b in result.blocks
    )
    assert lengths == [90, 90]


def test_final_remainder_may_be_smaller_than_min_block():
    task = make(minutes=75, deadline=dt(2026, 6, 10, 17), min_block_minutes=60)
    result = run([task])
    lengths = sorted(
        int((b.end_at - b.start_at).total_seconds() // 60) for b in result.blocks
    )
    assert lengths == [15, 60]
    assert total_minutes(result.blocks) == 75


def test_non_splittable_needs_one_contiguous_run():
    busy = [(dt(2026, 6, 10, 10), dt(2026, 6, 10, 16))]
    task = make(minutes=120, splittable=False, deadline=dt(2026, 6, 10, 17))
    result = run([task], busy=busy)
    assert result.blocks == []
    assert any(w.kind == "non_splittable" for w in result.warnings)

    task2 = make(minutes=120, splittable=False, deadline=dt(2026, 6, 11, 17))
    result2 = run([task2], busy=busy)
    assert len(result2.blocks) == 1
    assert total_minutes(result2.blocks) == 120


def test_preferred_window_is_a_bonus_not_a_constraint():
    task = make(
        minutes=180,
        deadline=dt(2026, 6, 10, 23),
        preferred_windows=((2, 15 * 60, 17 * 60),),  # Wednesday 15:00-17:00
    )
    result = run([task])
    starts = sorted(b.start_at for b in result.blocks)
    assert dt(2026, 6, 10, 15) in starts
    assert total_minutes(result.blocks) == 180


def test_horizon_capped_at_90_days_with_warning():
    task = make(minutes=120, deadline=dt(2027, 1, 30, 17))
    result = run([task])
    horizon_end = NOW + timedelta(days=90)
    assert all(b.end_at <= horizon_end for b in result.blocks)
    assert any(w.kind == "beyond_horizon" for w in result.warnings)


def test_insufficient_time_even_with_overload_keeps_remainder():
    task = make(minutes=240, deadline=dt(2026, 6, 10, 10))
    result = run([task], cap=120)
    placed = total_minutes(result.blocks)
    assert placed < 240
    stat = next(s for s in result.stats if s.task_id == "t1")
    assert stat.placed_minutes == placed
    assert stat.remaining_minutes == 240 - placed
    assert any(w.kind in ("partial", "no_slot") for w in result.warnings)


def test_earliest_start_is_respected():
    task = make(
        minutes=120,
        deadline=dt(2026, 6, 10, 17),
        earliest_start_at=dt(2026, 6, 10, 13),
    )
    result = run([task])
    assert all(b.start_at >= dt(2026, 6, 10, 13) for b in result.blocks)


def test_configured_availability_limits_days():
    # Only Thursday 13:00-15:00 is available once any window is configured.
    windows = {3: [(13 * 60, 15 * 60)]}
    task = make(minutes=120, deadline=dt(2026, 6, 12, 23))
    result = run([task], windows=windows)
    assert all(b.start_at.date() == D1 for b in result.blocks)
    assert all(13 <= b.start_at.hour < 15 for b in result.blocks)


def test_deterministic():
    tasks = [
        make("a", minutes=300, deadline=dt(2026, 6, 13, 17)),
        make("b", minutes=200, deadline=dt(2026, 6, 12, 17), priority=0),
    ]
    assert run(tasks, cap=240) == run(tasks, cap=240)
