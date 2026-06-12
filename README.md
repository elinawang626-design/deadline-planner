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
6. **生成日程**：`planner schedule`，按 15 分钟粒度在截止前（最长 90 天）确定性地排出约一小时的连续块，并打印警告（时间不足、截止日超出范围等）。

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

CLI、Web 后端与前端 Mock 共享同一套确定性调度引擎（`planner/engine.py`）：

- 范围：当前时间（上取整到下一个 15 分钟）起，至最晚任务截止时间，最长 90 天；更远的截止时间会返回范围警告，只安排范围内时段。
- 15 分钟槽粒度；默认期望块约 60 分钟，遵守任务的 `minBlockMinutes` / `maxBlockMinutes`，最后不足部分允许精确到 15 分钟；不可拆分任务必须找到完整连续时间。
- 未配置 availability rules 时默认每天 `09:00-17:00` 可用；一旦配置了任何窗口，只有配置过的星期可用。
- 任务按截止时间升序、截止前剩余可用容量升序、优先级降序、ID 升序处理。
- 工作量在截止前的可用日期间均衡分配（优先负荷较低的日期），并对较早日期给予小幅优先，使任务适度提前完成。
- 偏好窗口是评分加分项，不凌驾于截止时间和每日上限；偏好不足不会阻止安排。
- 每日负荷统计所有任务时间块（自动、手动、锁定）；固定事件只占用时间、不计入每日负荷上限；已完成或过去的块不占未来容量。
- **第一阶段**严格不超过每日上限（Web 端 `dailyMaxPlannedHours`，CLI 无上限）；**第二阶段**只处理截止前正常容量确实不足的任务，允许突破每日上限，但不与其他占用重叠、不超过截止时间，并把必要超载均衡分散、最小化单日最高超载量，每个被迫超载的任务和日期都会返回警告。
- 若即使超载也没有可用时间槽，保留未排时长并返回 insufficient-time 警告；调度摘要包含总未排分钟数及每任务已排/未排分钟数。
- 重新生成只替换未来、未锁定、自动生成的块；过去块、锁定块（`locked: true`）和手工块保留。

## 手动计划（Web）

- 今天、日、周、月四个日历视图均提供「新建任务」和「新建计划」入口；周/月视图每个日期单元有快捷创建按钮，所点日期会预填为任务截止日期或计划日期。
- 「新建计划」可绑定现有 active 任务，也可在同一弹窗中原子创建新任务（`POST /api/plans` 一次事务完成，不会留下孤立任务）。
- 手动计划保存为 `source="manual"`、`locked=true`，保存后自动重排其他未锁定计划。
- 手动计划允许重叠、超出可用时间、超过截止时间或超过每日上限，但响应会返回明确警告（overlap / outside_availability / past_deadline / overloaded_day），前端以 toast 展示。
- 新任务的预计时长表示整个任务；手动计划计入已安排时长，自动调度只补剩余部分。
- 周/月视图中，接近每日上限的日期显示提示色，超载日期显示红色并展示超载时长。

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
- "AI 导入"页是 AI 主导、人类可控的规划流程，分四步：选模式（AI 制定新计划 / AI 优化现有计划 / AI 整理任务、本地排程）并填写本次要求 → 生成包含全部上下文、记录 ID 和 JSON Schema 的提示词 → 粘贴外部 AI 的完整回复（支持纯 JSON、```json 代码块或带说明文字，仅接受唯一有效计划 JSON）→ 逐条预览、接受或拒绝变更后一次性事务写入。
- 时间块按来源区分 `ai` / `local_auto` / `manual`；过去、已完成、手动和锁定的块不会被 AI 覆盖，用户手动移动 AI 块后自动转为 `manual`。
- 正式导入前后端会按预览版本号重新校验最新数据，预览期间数据被改动会拒绝旧版本；任一记录失败整批回滚。
- 离线演示模式：`cd frontend && VITE_USE_MOCK=true npm run dev`，数据存浏览器 localStorage，解析/预览/导入规则与后端一致。
- 也可单独起后端：`python3 -m uvicorn planner.server:app --port 8000`（或安装后用 `planner-server`）。

## 测试

```bash
python3 -m pytest
```
