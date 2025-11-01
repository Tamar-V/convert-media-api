#!/usr/bin/env bash
set -euo pipefail

OWN=${1:-"$(id -u):$(id -g)"}

UPLOADS_DIR="./data/uploads"
LOGS_DIR="./data/logs"

echo ">> Creating folders"
mkdir -p "$UPLOADS_DIR" "$LOGS_DIR"

echo ">> Setting ownership to $OWN"
sudo chown -R "$OWN" "$UPLOADS_DIR" "$LOGS_DIR" || true

echo ">> Setting permissions (770) and setgid"
chmod -R 770 "$UPLOADS_DIR" "$LOGS_DIR"
find "$UPLOADS_DIR" "$LOGS_DIR" -type d -exec chmod g+s {} \;

echo ">> Done."
