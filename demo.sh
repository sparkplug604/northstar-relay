#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
case "${1:-start}" in
  install|launch) exec node demo/install.mjs "$@" ;;
  *) exec node demo/supervisor.mjs "${1:-start}" ;;
esac
