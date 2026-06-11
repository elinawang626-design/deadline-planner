from datetime import time, timedelta, timezone

from planner.models import AvailabilityRule, FixedEvent, PreferredWindow, ScheduledBlock
from planner.scheduler import generate_schedule
from tests.conftest import dt, make_task

UTC = timezone.utc
# 2026-06-10 is a Wednesday.
NOW = dt(2026, 6, 10, 8, 30)


def run(tasks, rules=(), events=(), blocks=(), now=NOW):
    return generate_schedule(
        now=now,
        tz=UTC,
        tasks=list(tasks),
        rules=list(rules),
        fixed_events=list(events),
        existing_blocks=list(blocks),
    )


def assert_no_overlap(blocks):
    spans = sorted((b.start_at, b.end_at) for b in blocks)
    for (s1, e1), (s2, _) in zip(spans, spans[1:]):
        assert e1 <= s2, f"overlap between {e1} and {s2}"


def test_default_availability_9_to_17_and_hour_ceiling():
    task = make_task("t1", hours=3, deadline=dt(2026, 6, 10, 17))
    result, _ = run([task])
    starts = [b.start_at for b in result.blocks]
    # now is 08:30 -> first slot starts at 09:00 (ceil to next full hour)
    assert starts == [dt(2026, 6, 10, 9), dt(2026, 6, 10, 10), dt(2026, 6, 10, 11)]
    assert result.warnings == []


def test_no_blocks_outside_availability():
    rule = AvailabilityRule(
        id="r1",
        weekdays=["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start_time=time(13),
        end_time=time(15),
    )
    task = make_task("t1", hours=4, deadline=dt(2026, 6, 12, 23))
    result, _ = run([task], rules=[rule])
    for b in result.blocks:
        assert 13 <= b.start_at.hour < 15


def test_avoids_fixed_events():
    event = FixedEvent(
        id="e1",
        title="Meeting",
        start_at=dt(2026, 6, 10, 9, 30),
        end_at=dt(2026, 6, 10, 10, 30),
    )
    task = make_task("t1", hours=3, deadline=dt(2026, 6, 10, 17))
    result, _ = run([task], events=[event])
    starts = [b.start_at for b in result.blocks]
    # both the 09:00 and 10:00 slots overlap the event and must be skipped
    assert starts == [dt(2026, 6, 10, 11), dt(2026, 6, 10, 12), dt(2026, 6, 10, 13)]


def test_respects_earliest_start_and_deadline():
    task = make_task(
        "t1",
        hours=2,
        deadline=dt(2026, 6, 10, 16),
        earliest_start_at=dt(2026, 6, 10, 13),
    )
    result, _ = run([task])
    for b in result.blocks:
        assert b.start_at >= dt(2026, 6, 10, 13)
        assert b.end_at <= dt(2026, 6, 10, 16)
    assert len(result.blocks) == 2


def test_preferred_windows_are_tried_first_but_do_not_block():
    window = PreferredWindow(weekdays=["wed"], start_time=time(15), end_time=time(17))
    task = make_task(
        "t1", hours=3, deadline=dt(2026, 6, 10, 23), preferred_windows=[window]
    )
    result, _ = run([task])
    starts = sorted(b.start_at for b in result.blocks)
    # 2 preferred slots (15:00, 16:00) first, then earliest other slot (09:00)
    assert dt(2026, 6, 10, 15) in starts and dt(2026, 6, 10, 16) in starts
    assert dt(2026, 6, 10, 9) in starts
    assert result.warnings == []


def test_tasks_split_across_days_and_results_are_deterministic():
    task = make_task("t1", hours=10, deadline=dt(2026, 6, 12, 17))
    result1, _ = run([task])
    result2, _ = run([task])
    assert result1 == result2
    days = {b.start_at.date() for b in result1.blocks}
    assert len(days) >= 2  # 10 hours cannot fit into the 8 hours left on day one
    assert len(result1.blocks) == 10
    assert_no_overlap(result1.blocks)


def test_ordering_deadline_then_priority_then_id():
    same_deadline = dt(2026, 6, 11, 17)
    low = make_task("a-low", hours=1, deadline=same_deadline, priority="low")
    high = make_task("z-high", hours=1, deadline=same_deadline, priority="high")
    early = make_task("m-early", hours=1, deadline=dt(2026, 6, 10, 12), priority="low")
    result, _ = run([low, high, early])
    by_task = {b.task_id: b.start_at for b in result.blocks}
    assert by_task["m-early"] < by_task["z-high"] < by_task["a-low"]


def test_locked_blocks_are_kept_and_unlocked_auto_blocks_replaced():
    locked = ScheduledBlock(
        id="locked-1",
        task_id="t1",
        start_at=dt(2026, 6, 10, 9),
        end_at=dt(2026, 6, 10, 10),
        locked=True,
        auto_generated=True,
    )
    stale = ScheduledBlock(
        id="stale-1",
        task_id="t1",
        start_at=dt(2026, 6, 10, 10),
        end_at=dt(2026, 6, 10, 11),
        locked=False,
        auto_generated=True,
    )
    past = ScheduledBlock(
        id="past-1",
        task_id="t1",
        start_at=dt(2026, 6, 9, 9),
        end_at=dt(2026, 6, 9, 10),
        locked=False,
        auto_generated=True,
    )
    manual = ScheduledBlock(
        id="manual-1",
        task_id="t1",
        start_at=dt(2026, 6, 10, 11),
        end_at=dt(2026, 6, 10, 12),
        locked=False,
        auto_generated=False,
    )
    task = make_task("t2", hours=2, deadline=dt(2026, 6, 10, 17))
    result, delete_ids = run([task], blocks=[locked, stale, past, manual])

    assert delete_ids == ["stale-1"]  # only future unlocked auto block
    occupied = {dt(2026, 6, 10, 9), dt(2026, 6, 10, 11)}  # locked + manual kept
    for b in result.blocks:
        assert b.start_at not in occupied


def test_insufficient_time_yields_partial_warning():
    task = make_task("t1", hours=5, deadline=dt(2026, 6, 10, 12))
    result, _ = run([task])
    assert len(result.blocks) == 3  # 09:00-12:00 only
    assert any("partially scheduled" in w for w in result.warnings)
    assert result.unscheduled_task_ids == []


def test_impossible_task_is_unscheduled_with_warning():
    task = make_task("t1", hours=2, deadline=dt(2026, 6, 10, 9))  # before first slot
    result, _ = run([task])
    assert result.blocks == []
    assert result.unscheduled_task_ids == ["t1"]
    assert any("could not be scheduled" in w for w in result.warnings)


def test_deadline_beyond_14_day_window_warns_and_blocks_stay_inside():
    task = make_task("t1", hours=2, deadline=dt(2026, 7, 30, 17))
    result, _ = run([task])
    horizon_end = NOW + timedelta(days=14)
    assert all(b.end_at <= horizon_end for b in result.blocks)
    assert any("beyond" in w for w in result.warnings)
    assert len(result.blocks) == 2


def test_never_schedules_more_than_window_capacity():
    # 14 days x 8h default availability = 112 max hours
    task = make_task("t1", hours=500, deadline=dt(2026, 7, 30, 17))
    result, _ = run([task])
    horizon_end = NOW + timedelta(days=14)
    assert all(b.end_at <= horizon_end for b in result.blocks)
    assert len(result.blocks) <= 14 * 8
    assert any("partially scheduled" in w for w in result.warnings)
    assert_no_overlap(result.blocks)
