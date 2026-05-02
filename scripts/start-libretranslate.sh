#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VENV_DIR="${LIBRETRANSLATE_VENV_DIR:-.venv-libretranslate}"
HOST="${LIBRETRANSLATE_HOST:-127.0.0.1}"
PORT="${LIBRETRANSLATE_PORT:-5000}"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "[libretranslate] Creating Python virtual environment at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

echo "[libretranslate] Installing/updating LibreTranslate inside $VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install --upgrade libretranslate

echo "[libretranslate] Starting on http://$HOST:$PORT"
exec "$VENV_DIR/bin/libretranslate" --host "$HOST" --port "$PORT"
