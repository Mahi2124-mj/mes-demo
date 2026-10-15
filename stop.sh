#!/usr/bin/env bash
# Stop the MES demo clone (only the process started by start.sh).
cd "$(dirname "$0")"
if [ -f logs/server.pid ] && kill -0 "$(cat logs/server.pid)" 2>/dev/null; then
  kill "$(cat logs/server.pid)" && rm -f logs/server.pid && echo "Stopped."
else
  echo "Not running."
fi
