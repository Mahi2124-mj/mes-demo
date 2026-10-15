#!/usr/bin/env bash
# Start the MES demo clone on port 5000 (standalone; never touches the live MES).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-5000}"
if [ -f logs/server.pid ] && kill -0 "$(cat logs/server.pid)" 2>/dev/null; then
  echo "Already running (pid $(cat logs/server.pid)) on port $PORT"; exit 0
fi
if ss -ltn | grep -q ":$PORT "; then
  echo "Port $PORT is in use by another program — not starting."; exit 1
fi
mkdir -p logs
[ -f dist/index.html ] || npx vite build
setsid nohup python3 server.py "$PORT" >> logs/server.log 2>&1 < /dev/null &
echo $! > logs/server.pid
sleep 1
echo "MES demo running: http://$(hostname -I | awk '{print $1}'):$PORT/YCA-SS/SUPERVISOR  (pid $(cat logs/server.pid))"
