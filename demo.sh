#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "${1:-start}" = install ]; then
  (cd relay && npm ci --no-audit --no-fund && npm run build:all)
  (cd agent && pnpm install --frozen-lockfile)
else
  exec node demo/supervisor.mjs "${1:-start}"
fi
