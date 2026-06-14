"""External LLM provider adapters (OpenAI, DeepSeek, Claude).

Each adapter takes the same input — the fully rendered planning prompt, a short
language-aware system instruction, the ``AiPlan`` JSON schema and the target
model/base URL/key — and returns raw JSON *text*. That text is never trusted:
the caller still runs it through ``ai_plan.extract_plan`` and the existing
semantic validation before anything is previewed or written.

Structured-output features are used as a best effort (OpenAI ``json_schema``,
DeepSeek ``json_object``, Claude forced tool call with ``input_schema``) but the
download path treats every reply as untrusted text.

Protocol references:
- OpenAI Responses:   https://developers.openai.com/api/reference/resources/responses/methods/create
- DeepSeek Chat:      https://api-docs.deepseek.com/api/create-chat-completion
- Claude Messages:    https://platform.claude.com/docs/en/api/messages
"""
from __future__ import annotations

import json
from typing import Any

import httpx

CONNECT_TIMEOUT_S = 10.0
READ_TIMEOUT_S = 120.0
CLAUDE_MAX_TOKENS = 8000
ANTHROPIC_VERSION = "2023-06-01"
PLAN_TOOL_NAME = "submit_plan"

ErrorKind = str  # auth | rate_limit | timeout | model | invalid_response | network

_SYSTEM_INSTRUCTION = {
    "zh-CN": "你只能输出一个符合给定 JSON Schema 的 JSON 对象，不要包含任何额外文字。",
    "en-US": (
        "Output exactly one JSON object conforming to the given JSON Schema, "
        "with no extra text."
    ),
}


class ProviderError(Exception):
    """A provider call failed; ``kind`` lets the UI show an actionable message."""

    def __init__(self, kind: ErrorKind, message: str):
        self.kind = kind
        super().__init__(message)


def system_instruction(language: str) -> str:
    return _SYSTEM_INSTRUCTION.get(language, _SYSTEM_INSTRUCTION["zh-CN"])


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(READ_TIMEOUT_S, connect=CONNECT_TIMEOUT_S)


def _base(url: str) -> str:
    return url.rstrip("/")


def _status_error(status: int, body: str) -> ProviderError:
    if status in (401, 403):
        return ProviderError("auth", f"认证失败（HTTP {status}），请检查 API Key")
    if status == 429:
        return ProviderError("rate_limit", "请求过于频繁或额度不足（HTTP 429）")
    if status in (400, 404, 422):
        return ProviderError(
            "model", f"请求被拒绝（HTTP {status}），请检查模型名与参数：{body[:300]}"
        )
    return ProviderError("network", f"服务返回 HTTP {status}：{body[:300]}")


def _post(client: httpx.Client, url: str, *, headers: dict, payload: dict) -> dict:
    try:
        response = client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        raise ProviderError("timeout", "请求超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError("network", f"网络错误：{exc}") from exc
    if response.status_code >= 400:
        raise _status_error(response.status_code, response.text)
    try:
        return response.json()
    except json.JSONDecodeError as exc:
        raise ProviderError("invalid_response", "服务返回了非 JSON 响应") from exc


# ---- OpenAI Responses API ----


def _call_openai(
    *, base_url: str, model: str, api_key: str, system: str, prompt: str, schema: dict
) -> str:
    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "plan",
                "schema": schema,
                "strict": False,
            }
        },
    }
    headers = {"Authorization": f"Bearer {api_key}"}
    with httpx.Client(timeout=_timeout()) as client:
        data = _post(client, f"{_base(base_url)}/responses", headers=headers, payload=payload)
    texts: list[str] = []
    for item in data.get("output", []):
        if item.get("type") != "message":
            continue
        for part in item.get("content", []):
            if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
    if not texts:
        raise ProviderError("invalid_response", "OpenAI 响应中未找到文本输出")
    return "".join(texts)


# ---- DeepSeek Chat Completions ----


def _call_deepseek(
    *, base_url: str, model: str, api_key: str, system: str, prompt: str, schema: dict
) -> str:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {api_key}"}
    with httpx.Client(timeout=_timeout()) as client:
        data = _post(
            client, f"{_base(base_url)}/chat/completions", headers=headers, payload=payload
        )
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ProviderError("invalid_response", "DeepSeek 响应缺少消息内容") from exc
    if not isinstance(content, str) or not content.strip():
        raise ProviderError("invalid_response", "DeepSeek 返回了空响应")
    return content


# ---- Claude Messages API (forced tool call) ----


def _call_claude(
    *, base_url: str, model: str, api_key: str, system: str, prompt: str, schema: dict
) -> str:
    payload = {
        "model": model,
        "max_tokens": CLAUDE_MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
        "tools": [
            {
                "name": PLAN_TOOL_NAME,
                "description": "提交规划结果（必须调用本工具返回结构化计划）",
                "input_schema": schema,
            }
        ],
        "tool_choice": {"type": "tool", "name": PLAN_TOOL_NAME},
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
    }
    with httpx.Client(timeout=_timeout()) as client:
        data = _post(client, f"{_base(base_url)}/v1/messages", headers=headers, payload=payload)
    for part in data.get("content", []):
        if part.get("type") == "tool_use" and part.get("name") == PLAN_TOOL_NAME:
            return json.dumps(part.get("input", {}), ensure_ascii=False)
    raise ProviderError("invalid_response", "Claude 响应中未找到工具调用结果")


_DISPATCH = {
    "openai": _call_openai,
    "deepseek": _call_deepseek,
    "claude": _call_claude,
}


def call_provider(
    provider: str,
    *,
    base_url: str,
    model: str,
    api_key: str,
    prompt: str,
    schema: dict[str, Any],
    language: str,
) -> str:
    """Call ``provider`` and return raw JSON text (still unvalidated)."""
    handler = _DISPATCH.get(provider)
    if handler is None:
        raise ProviderError("model", f"未知服务商：{provider}")
    if not (model or "").strip():
        raise ProviderError("model", "未配置模型名，请在设置中填写模型")
    if not (api_key or "").strip():
        raise ProviderError("auth", "未配置 API Key，请先在设置中保存密钥")
    return handler(
        base_url=base_url,
        model=model,
        api_key=api_key,
        system=system_instruction(language),
        prompt=prompt,
        schema=schema,
    )


def test_connection(provider: str, *, base_url: str, model: str, api_key: str) -> None:
    """Lightweight reachability/auth check; raises ProviderError on failure."""
    if not (api_key or "").strip():
        raise ProviderError("auth", "未配置 API Key")
    if not (model or "").strip():
        raise ProviderError("model", "未配置模型名")
    if provider == "openai":
        payload = {"model": model, "input": "ping", "max_output_tokens": 16}
        headers = {"Authorization": f"Bearer {api_key}"}
        url = f"{_base(base_url)}/responses"
    elif provider == "deepseek":
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }
        headers = {"Authorization": f"Bearer {api_key}"}
        url = f"{_base(base_url)}/chat/completions"
    elif provider == "claude":
        payload = {
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
        headers = {"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}
        url = f"{_base(base_url)}/v1/messages"
    else:
        raise ProviderError("model", f"未知服务商：{provider}")
    with httpx.Client(timeout=_timeout()) as client:
        _post(client, url, headers=headers, payload=payload)
