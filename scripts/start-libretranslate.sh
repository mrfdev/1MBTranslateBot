#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

LIBRE_VENV_DIR="${LIBRETRANSLATE_VENV_DIR:-.venv-libretranslate}"
LIBRE_BIND_HOST="${LIBRETRANSLATE_HOST:-127.0.0.1}"
LIBRE_BIND_PORT="${LIBRETRANSLATE_PORT:-5000}"

case "$LIBRE_BIND_HOST" in
  127.0.0.1|::1) ;;
  *)
    echo "[libretranslate] Refusing a non-loopback bind address."
    exit 2
    ;;
esac

if [ ! -x "$LIBRE_VENV_DIR/bin/libretranslate" ]; then
  echo "[libretranslate] No pre-provisioned legacy translator was found at $LIBRE_VENV_DIR/bin/libretranslate." >&2
  echo "[libretranslate] Provision a reviewed, fully locked environment separately; startup never installs packages." >&2
  exit 2
fi

echo "[libretranslate] Starting on loopback."
exec "$LIBRE_VENV_DIR/bin/libretranslate" --host "$LIBRE_BIND_HOST" --port "$LIBRE_BIND_PORT"
