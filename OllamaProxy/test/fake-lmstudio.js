'use strict';
// Mock OpenAI-compatible (LM Studio shape) server for testing protocol-aware health.

const http = require('http');

const PORT = parseInt(process.env.PORT || '11444', 10);
const MODELS = (process.env.MODELS || 'qwen3-coder-plus-mlx,phi-4-mini-mlx').split(',');

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map(id => ({ id, object: 'model' })),
    }));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake-lmstudio listening on 127.0.0.1:${PORT}, models: ${MODELS.join(', ')}`);
});
