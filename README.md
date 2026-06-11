# 本地优先 AI 截止日期规划器

一个不调用任何 LLM API 的命令行规划工具：

- **无需 API key** —— 应用本身从不联网。
- **支持任意 LLM** —— ChatGPT、Claude、本地模型……任何能输出 JSON 的都行。
- **只接受验证后的 JSON** —— 人工粘贴的 LLM 输出经 Pydantic 严格校验（拒绝额外字段、非法枚举、无时区 datetime、夹杂文本、多个 JSON 对象），验证失败不写库。
- **确定性调度** —— 日程由本地算法生成，输入相同则输出相同。
- **单文件 SQLite 持久化** —— 默认 `.planner/planner.db`，可用 `--db` 指定。

## 安装

```bash
pip install -e .          # 在项目根目录执行；之后可直接使用 planner 命令
pip install -e ".[dev]"   # 含 pytest
```

时区通过 `TZ` 环境变量设置（如 `export TZ=Asia/Shanghai`），未设置时使用 UTC。

## 六步手工 LLM 流程

1. **写下原始需求**：把任务、空闲时间、固定日程随意写进一个文本文件（如 `input.txt`）。
2. **生成提示词**：`planner generate-prompt --input input.txt`，工具会拼出包含当前时间、时区、已有数据和 JSON Schema 的完整提示词。
3. **粘贴给任意 LLM**：复制提示词，粘贴到你喜欢的 LLM 聊天窗口。
4. **保存 LLM 回复**：把模型返回的 JSON（纯 JSON 或 ```json 围栏块均可）存为 `llm_output.txt`。
5. **导入**：`planner import-output --file llm_output.txt`。验证通过才会按 ID upsert 写入 SQLite；失败时打印结构化错误且不写任何数据。
6. **生成日程**：`planner schedule`，在未来 14 天内确定性地排出一小时块，并打印警告（时间不足、截止日超出范围等）。

之后随时用 `planner show-day` / `planner show-week` 查看。需要修改数据时，用同一 ID 修正 JSON 后重新导入即可。

## 完整演示

```bash
export TZ=UTC

cat > input.txt <<'EOF'
下周一 18 点前完成季度报告，大约 3 小时，优先级高。
明天 10:00-11:00 有牙医预约。
EOF

planner generate-prompt --input input.txt
# 复制输出 → 粘贴给任意 LLM → 把回复存为 llm_output.txt，例如：

cat > llm_output.txt <<'EOF'
{
  "tasks": [
    {"id": "report", "title": "季度报告", "deadline": "2026-06-15T18:00:00+00:00",
     "estimated_hours": 3, "priority": "high"}
  ],
  "availability_rules": [],
  "fixed_events": [
    {"id": "dentist", "title": "牙医", "start_at": "2026-06-11T10:00:00+00:00",
     "end_at": "2026-06-11T11:00:00+00:00"}
  ]
}
EOF

planner import-output --file llm_output.txt
planner schedule
planner show-day 2026-06-11
planner show-week 2026-06-11
```

## 调度规则摘要

- 范围：当前时间（上取整到下一个整点）起 14 天。
- 未配置 availability rules 时默认每天 `09:00-17:00` 可用。
- 任务按截止时间升序、优先级降序（high > medium > low）、ID 升序排列。
- 任务可跨天拆成一小时块；只用不早于 `earliest_start_at`、不晚于 deadline 的槽。
- 偏好窗口优先，但偏好不足不会阻止安排。
- 固定事件有任何重叠的一小时槽整体视为不可用。
- 重新生成只替换未来、未锁定、自动生成的块；过去块、锁定块（`locked: true`）和手工块保留。

## 限制（MVP）

- 无任务完成状态、交互式编辑或删除命令；通过同 ID 重新导入修正数据。
- availability 与偏好窗口不支持跨午夜，需拆成两条规则。
- deadline 表示任务块必须在该时刻前结束。

## 前端（frontend/）

React + TypeScript + Vite + Tailwind 的本地 Web 界面（无认证、无云同步、不调用任何 LLM API）：

一键启动（后端 FastAPI :8000 + 前端 Vite :5173，前端经代理访问 `/api`）：

```bash
pip install -e ".[dev]"        # 首次：安装后端（含 fastapi/uvicorn）
cd frontend && npm install && cd ..   # 首次：安装前端依赖
./dev.sh                       # 打开 http://localhost:5173
```

- 数据存在本地 SQLite（`.planner/planner.db` 的 `web_*` 表），无认证、无云同步、不调用任何 LLM API。
- "AI 导入"页走后端严格校验（Pydantic `extra="forbid"`），与 CLI 同一套拒绝规则。
- 离线演示模式：`cd frontend && VITE_USE_MOCK=true npm run dev`，数据存浏览器 localStorage。
- 也可单独起后端：`python3 -m uvicorn planner.server:app --port 8000`（或安装后用 `planner-server`）。

## 测试

```bash
python3 -m pytest
```
