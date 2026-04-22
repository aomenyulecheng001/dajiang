#!/bin/bash
# Auto-restart Bot Runner Service
cd "$(dirname "$0")"
while true; do
  tsx index.ts 2>&1
  sleep 2
done
