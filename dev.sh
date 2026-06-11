#!/usr/bin/env bash
# One-command dev environment: backend API on :8000 + frontend on :5173.
set -e
cd "$(dirname "$0")"
python3 -m uvicorn planner.server:app --port 8000 &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null' EXIT
cd frontend && npm run dev
