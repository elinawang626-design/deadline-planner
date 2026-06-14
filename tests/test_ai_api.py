"""External-AI mode: provider adapters, key safety, settings compat, run flow."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from planner import providers
from planner.server import app
from planner.webmodels import Settings


@pytest.fixture()
def db_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PLANNER_DB", str(tmp_path / "web.db"))
    return tmp_path


@pytest.fixture()
def client(db_dir):
    return TestClient(app)


def iso(dt):
    return dt.isoformat()


def future(days=0):
    return datetime.now(timezone.utc) + timedelta(days=days)


def make_task_body():
    return {
        "title": "Write report",
        "type": "assignment",
        "deadline": iso(future(days=5)),
        "estimatedMinutes": 120,
        "priority": "high",
        "splittable": True,
    }


def mock_httpx(monkeypatch, handler):
    """Route every planner.providers httpx call through a MockTransport."""
    real_client = httpx.Client

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(providers.httpx, "Client", factory)


# ---- settings backward compatibility ----


def test_old_settings_json_loads_with_defaults():
    settings = Settings.model_validate_json('{"dailyMaxPlannedHours": 5}')
    assert settings.dailyMaxPlannedHours == 5
    assert settings.language == "zh-CN"
    assert settings.aiMode == "manual"
    assert settings.activeProvider == "openai"
    assert set(settings.providers) == {"openai", "deepseek", "claude"}
    assert settings.providers["openai"].baseUrl.startswith("https://")


def test_partial_providers_are_filled():
    settings = Settings.model_validate(
        {"dailyMaxPlannedHours": 6, "providers": {"openai": {"baseUrl": "x", "model": "m"}}}
    )
    assert settings.providers["openai"].model == "m"
    assert "deepseek" in settings.providers and "claude" in settings.providers


def test_get_settings_reports_configured_flags(client):
    body = client.get("/api/settings").json()
    assert body["language"] == "zh-CN"
    assert body["configured"] == {"openai": False, "deepseek": False, "claude": False}


def test_put_settings_persists_language_and_provider(client):
    payload = client.get("/api/settings").json()
    payload.pop("configured")
    payload["language"] = "en-US"
    payload["aiMode"] = "api"
    payload["activeProvider"] = "deepseek"
    saved = client.put("/api/settings", json=payload).json()
    assert saved["language"] == "en-US"
    assert client.get("/api/settings").json()["aiMode"] == "api"


# ---- key storage safety ----


def test_key_never_stored_in_sqlite_or_returned(client, db_dir):
    secret = "sk-secret-abc123"
    resp = client.put("/api/ai-import/keys/openai", json={"key": secret})
    assert resp.json()["configured"]["openai"] is True

    # not in any API response
    assert secret not in client.get("/api/settings").text

    # not anywhere in the SQLite file
    db_bytes = (db_dir / "web.db").read_bytes()
    assert secret.encode() not in db_bytes

    # present in the dedicated key file, which is user-only readable
    key_file = db_dir / "api_keys.json"
    assert key_file.exists()
    assert oct(key_file.stat().st_mode)[-3:] == "600"
    assert secret in key_file.read_text()


def test_key_delete(client):
    client.put("/api/ai-import/keys/claude", json={"key": "sk-x"})
    assert client.get("/api/settings").json()["configured"]["claude"] is True
    client.delete("/api/ai-import/keys/claude")
    assert client.get("/api/settings").json()["configured"]["claude"] is False


def test_unknown_provider_rejected(client):
    assert client.put("/api/ai-import/keys/gemini", json={"key": "x"}).status_code == 404


def test_empty_key_rejected(client):
    assert client.put("/api/ai-import/keys/openai", json={"key": "  "}).status_code == 422


# ---- provider request format + response parsing ----


def _plan_text(task_id: str) -> str:
    return json.dumps({"tasks": [{"id": task_id, "estimated_minutes": 180}]})


def test_openai_request_shape_and_parse(monkeypatch):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": _plan_text("t1")}],
                    }
                ]
            },
        )

    mock_httpx(monkeypatch, handler)
    raw = providers.call_provider(
        "openai",
        base_url="https://api.openai.com/v1",
        model="gpt-4o",
        api_key="sk-1",
        prompt="plan please",
        schema={"type": "object"},
        language="zh-CN",
    )
    assert json.loads(raw)["tasks"][0]["id"] == "t1"
    assert captured["url"].endswith("/responses")
    assert captured["auth"] == "Bearer sk-1"
    assert captured["body"]["text"]["format"]["type"] == "json_schema"


def test_deepseek_uses_json_object(monkeypatch):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"choices": [{"message": {"content": _plan_text("t2")}}]}
        )

    mock_httpx(monkeypatch, handler)
    raw = providers.call_provider(
        "deepseek",
        base_url="https://api.deepseek.com",
        model="deepseek-chat",
        api_key="sk-2",
        prompt="plan",
        schema={"type": "object"},
        language="en-US",
    )
    assert json.loads(raw)["tasks"][0]["id"] == "t2"
    assert captured["url"].endswith("/chat/completions")
    assert captured["body"]["response_format"] == {"type": "json_object"}


def test_claude_forces_tool_call_and_reads_input(monkeypatch):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["version"] = request.headers.get("anthropic-version")
        captured["xkey"] = request.headers.get("x-api-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "content": [
                    {
                        "type": "tool_use",
                        "name": "submit_plan",
                        "input": {"tasks": [{"id": "t3", "estimated_minutes": 60}]},
                    }
                ]
            },
        )

    mock_httpx(monkeypatch, handler)
    raw = providers.call_provider(
        "claude",
        base_url="https://api.anthropic.com",
        model="claude-3-5-sonnet-latest",
        api_key="sk-3",
        prompt="plan",
        schema={"type": "object"},
        language="zh-CN",
    )
    assert json.loads(raw)["tasks"][0]["id"] == "t3"
    assert captured["url"].endswith("/v1/messages")
    assert captured["version"] == "2023-06-01"
    assert captured["xkey"] == "sk-3"
    assert captured["body"]["tool_choice"] == {"type": "tool", "name": "submit_plan"}


# ---- provider error classification ----


@pytest.mark.parametrize(
    "status,kind",
    [(401, "auth"), (403, "auth"), (429, "rate_limit"), (400, "model")],
)
def test_status_errors_classified(monkeypatch, status, kind):
    mock_httpx(monkeypatch, lambda req: httpx.Response(status, text="nope"))
    with pytest.raises(providers.ProviderError) as exc:
        providers.call_provider(
            "deepseek", base_url="https://api.deepseek.com", model="m",
            api_key="k", prompt="p", schema={}, language="zh-CN",
        )
    assert exc.value.kind == kind


def test_timeout_classified(monkeypatch):
    def handler(request):
        raise httpx.TimeoutException("slow", request=request)

    mock_httpx(monkeypatch, handler)
    with pytest.raises(providers.ProviderError) as exc:
        providers.call_provider(
            "openai", base_url="https://api.openai.com/v1", model="m",
            api_key="k", prompt="p", schema={}, language="zh-CN",
        )
    assert exc.value.kind == "timeout"


def test_non_json_response_classified(monkeypatch):
    mock_httpx(monkeypatch, lambda req: httpx.Response(200, text="<html>down</html>"))
    with pytest.raises(providers.ProviderError) as exc:
        providers.call_provider(
            "deepseek", base_url="https://api.deepseek.com", model="m",
            api_key="k", prompt="p", schema={}, language="zh-CN",
        )
    assert exc.value.kind == "invalid_response"


def test_missing_model_or_key_rejected_before_call():
    # no HTTP mock: must fail before any request is made
    with pytest.raises(providers.ProviderError) as exc:
        providers.call_provider(
            "openai", base_url="x", model="", api_key="k",
            prompt="p", schema={}, language="zh-CN",
        )
    assert exc.value.kind == "model"
    with pytest.raises(providers.ProviderError) as exc:
        providers.call_provider(
            "openai", base_url="x", model="m", api_key="",
            prompt="p", schema={}, language="zh-CN",
        )
    assert exc.value.kind == "auth"


# ---- run endpoint: previews without writing, surfaces errors ----


def _configure_api(client, provider="openai"):
    payload = client.get("/api/settings").json()
    payload.pop("configured")
    payload["aiMode"] = "api"
    payload["activeProvider"] = provider
    client.put("/api/settings", json=payload)
    client.put(f"/api/ai-import/keys/{provider}", json={"key": "sk-run"})


def test_run_previews_without_writing(client, monkeypatch):
    task = client.post("/api/tasks", json=make_task_body()).json()
    _configure_api(client, "openai")

    def handler(request):
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": _plan_text(task["id"])}
                        ],
                    }
                ]
            },
        )

    mock_httpx(monkeypatch, handler)
    resp = client.post("/api/ai-import/run", json={"mode": "tasks_only", "requirements": ""})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["rawOutput"]
    assert any(c["kind"] == "task_update" for c in data["changes"])

    # the task must be unchanged in the DB (run never writes)
    stored = client.get("/api/tasks").json()[0]
    assert stored["estimatedMinutes"] == 120


def test_run_without_key_returns_400(client):
    _configure_api(client, "openai")
    client.delete("/api/ai-import/keys/openai")
    resp = client.post("/api/ai-import/run", json={"mode": "ai_plan"})
    assert resp.status_code == 400


def test_run_provider_auth_error_surfaces_502(client, monkeypatch):
    _configure_api(client, "deepseek")
    mock_httpx(monkeypatch, lambda req: httpx.Response(401, text="bad key"))
    resp = client.post("/api/ai-import/run", json={"mode": "ai_plan"})
    assert resp.status_code == 502
    assert resp.json()["detail"]["kind"] == "auth"


def test_run_non_plan_reply_returns_422(client, monkeypatch):
    _configure_api(client, "deepseek")
    mock_httpx(
        monkeypatch,
        lambda req: httpx.Response(
            200, json={"choices": [{"message": {"content": "sorry, no idea"}}]}
        ),
    )
    resp = client.post("/api/ai-import/run", json={"mode": "ai_plan"})
    assert resp.status_code == 422
