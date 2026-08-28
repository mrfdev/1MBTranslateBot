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

if [ ! -x "$LIBRE_VENV_DIR/bin/python" ]; then
  echo "[libretranslate] Creating the local Python environment."
  python3 -m venv "$LIBRE_VENV_DIR"
fi

echo "[libretranslate] Installing/updating the local legacy translator."
"$LIBRE_VENV_DIR/bin/python" -m pip install --upgrade pip
"$LIBRE_VENV_DIR/bin/python" -m pip install --upgrade libretranslate

echo "[libretranslate] Starting on loopback."
exec "$LIBRE_VENV_DIR/bin/libretranslate" --host "$LIBRE_BIND_HOST" --port "$LIBRE_BIND_PORT"
