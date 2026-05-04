#!/bin/bash
cd "$(dirname "$0")"

# nvm を読み込む
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# pm2 がなければインストール
if ! command -v pm2 &>/dev/null; then
  echo ">>> pm2 をインストールしています..."
  npm install -g pm2
fi

# すでに起動中なら再起動、なければ新規起動
if pm2 list | grep -q "ollama-proxy"; then
  echo ">>> 再起動します..."
  pm2 restart ollama-proxy
else
  echo ">>> 起動します..."
  pm2 start src/server.js \
    --name ollama-proxy \
    --node-args="--no-warnings=ExperimentalWarning"
fi

echo ""
pm2 status ollama-proxy
echo ""
echo ">>> Proxy:     http://localhost:11435"
echo ">>> Dashboard: http://localhost:3000"
echo ""
echo "ウィンドウを閉じてもサーバーはバックグラウンドで動き続けます。"
echo "停止するには stop.command を実行してください。"
