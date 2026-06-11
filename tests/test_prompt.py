from datetime import time

from planner.models import AvailabilityRule, FixedEvent
from planner.prompt import build_prompt
from tests.conftest import dt, make_task


def test_prompt_contains_all_required_context():
    now = dt(2026, 6, 10, 8, 30)
    task = make_task("t1", title="Write quarterly report")
    rule = AvailabilityRule(
        id="r1", weekdays=["mon"], start_time=time(9), end_time=time(17)
    )
    event = FixedEvent(
        id="e1",
        title="Dentist appointment",
        start_at=dt(2026, 6, 11, 10),
        end_at=dt(2026, 6, 11, 11),
    )

    prompt = build_prompt(
        raw_input="finish the report by Monday evening",
        tasks=[task],
        rules=[rule],
        fixed_events=[event],
        now=now,
        tz_name="UTC",
    )

    assert "finish the report by Monday evening" in prompt  # raw input
    assert now.isoformat() in prompt  # current time
    assert "Timezone: UTC" in prompt  # timezone
    assert "Write quarterly report" in prompt  # existing task
    assert '"r1"' in prompt  # existing rule
    assert "Dentist appointment" in prompt  # existing fixed event
    assert "estimated_hours" in prompt and "fixed_events" in prompt  # schema
    assert "ONLY a single JSON object" in prompt
    assert "Do NOT produce any calendar blocks" in prompt
