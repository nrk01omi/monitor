#!/bin/bash
cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if ! command -v pm2 &>/dev/null; then
  echo ">>> pm2 が見つかりません。すでに停止しています。"
  exit 0
fi

if pm2 list | grep -q "ollama-proxy"; then
  pm2 stop ollama-proxy
  echo ">>> 停止しました。"
else
  echo ">>> すでに停止しています。"
fi
