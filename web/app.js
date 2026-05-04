// app.js - トポロジー描画 + ノード詳細 + 応答時間グラフ

const API = ''; // nginx 経由なので相対パス

const STATUS_COLOR = {
  up: '#3fb950',
  degraded: '#d29922',
  down: '#f85149',
  unknown: '#6e7681',
};

const GROUP_LABEL = {
  'nas-docker': 'NAS Docker',
  'vm': 'VM',
  'llm-proxy': 'LLM Proxy',
  'llm-backend': 'Ollama Backend',
  'peripheral': '周辺機器',
};

let cy = null;
let chart = null;
let selectedId = null;
let lastNodes = [];

function initCy() {
  cy = cytoscape({
    container: document.getElementById('cy'),
    style: [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          'label': 'data(label)',
          'color': '#e6edf3',
          'font-size': '11px',
          'text-valign': 'bottom',
          'text-margin-y': 6,
          'text-outline-color': '#0e1116',
          'text-outline-width': 2,
          'border-width': 2,
          'border-color': 'data(borderColor)',
          'width': 50,
          'height': 50,
          'shape': 'data(shape)',
          'transition-property': 'background-color, border-color',
          'transition-duration': '0.3s',
        }
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 4,
          'border-color': '#58a6ff',
        }
      },
      {
        selector: 'node[group = "llm-proxy"]',
        style: { 'width': 70, 'height': 70 }
      },
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': '#3a414c',
          'curve-style': 'bezier',
          'target-arrow-color': '#3a414c',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.8,
          'opacity': 0.7,
        }
      },
      {
        selector: 'edge[label]',
        style: {
          'label': 'data(label)',
          'color': '#8b949e',
          'font-size': '10px',
          'text-rotation': 'autorotate',
          'text-margin-y': -8,
        }
      }
    ],
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
  });

  cy.on('tap', 'node', (e) => {
    selectedId = e.target.id();
    renderSide();
  });

  cy.on('tap', (e) => {
    if (e.target === cy) {
      selectedId = null;
      renderSide();
    }
  });
}

// 階層的レイアウト座標を計算 (グループごとに行を分ける)
function computeLayout(nodes) {
  const groups = {
    'nas-docker':   { y: 100, label: 'NAS Docker' },
    'vm':           { y: 100, label: 'VM' },
    'llm-proxy':    { y: 280, label: 'LLM Proxy' },
    'llm-backend':  { y: 440, label: 'Ollama Backend' },
    'peripheral':   { y: 600, label: '周辺機器' },
    'default':      { y: 600, label: 'その他' },
  };

  // 上段は nas-docker と vm を横に並べる
  const topGroups = ['nas-docker', 'vm'];
  const bottomGroups = ['llm-proxy', 'llm-backend', 'peripheral', 'default'];

  const positions = {};
  const containerWidth = document.getElementById('cy').clientWidth;

  // 上段: nas-docker と vm を分けて並べる
  let xCursor = 80;
  for (const g of topGroups) {
    const items = nodes.filter(n => n.group === g);
    items.forEach((n, i) => {
      positions[n.id] = { x: xCursor + i * 130, y: groups[g].y };
    });
    xCursor += items.length * 130 + 60;
  }

  // 下段: それぞれを中央寄せで横一列に
  for (const g of bottomGroups) {
    const items = nodes.filter(n => n.group === g);
    if (items.length === 0) continue;
    const totalW = (items.length - 1) * 140;
    const startX = Math.max(80, containerWidth / 2 - totalW / 2);
    items.forEach((n, i) => {
      positions[n.id] = { x: startX + i * 140, y: groups[g].y };
    });
  }

  return positions;
}

async function fetchAndRender() {
  try {
    const [statusRes, topoRes] = await Promise.all([
      fetch(`${API}/api/status`).then(r => r.json()),
      fetch(`${API}/api/topology`).then(r => r.json()),
    ]);

    const nodes = statusRes.nodes;
    lastNodes = nodes;
    const edges = topoRes.edges;
    const positions = computeLayout(nodes);

    // ノードとエッジを cy に反映
    const cyNodes = nodes.map(n => ({
      group: 'nodes',
      data: {
        id: n.id,
        label: n.name,
        color: STATUS_COLOR[n.status] || STATUS_COLOR.unknown,
        borderColor: STATUS_COLOR[n.status] || STATUS_COLOR.unknown,
        group: n.group,
        shape: n.type === 'ollama_proxy' ? 'round-rectangle' : 'ellipse',
      },
      position: positions[n.id] || { x: 100, y: 100 },
    }));

    const cyEdges = edges
      .filter(e => positions[e.from] && positions[e.to])
      .map((e, i) => ({
        group: 'edges',
        data: {
          id: `e-${i}`,
          source: e.from,
          target: e.to,
          label: e.label || '',
        }
      }));

    cy.elements().remove();
    cy.add([...cyNodes, ...cyEdges]);

    if (selectedId) {
      cy.$id(selectedId).select();
    }

    renderStats(nodes);
    renderSide();

    document.getElementById('last-update').textContent =
      `最終更新: ${new Date().toLocaleTimeString('ja-JP')}`;
  } catch (e) {
    console.error('fetchAndRender failed', e);
    document.getElementById('last-update').textContent =
      `更新失敗: ${e.message}`;
  }
}

function renderStats(nodes) {
  const counts = { up: 0, degraded: 0, down: 0 };
  for (const n of nodes) {
    if (counts[n.status] !== undefined) counts[n.status]++;
  }
  document.getElementById('stats').innerHTML = `
    <span class="stat-pill"><span class="dot up"></span>UP ${counts.up}</span>
    <span class="stat-pill"><span class="dot degraded"></span>不安定 ${counts.degraded}</span>
    <span class="stat-pill"><span class="dot down"></span>DOWN ${counts.down}</span>
  `;
}

function renderSide() {
  const side = document.getElementById('side');
  if (!selectedId) {
    side.innerHTML = '<div class="empty">ノードをクリックすると詳細が表示されます</div>';
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  const node = lastNodes.find(n => n.id === selectedId);
  if (!node) {
    side.innerHTML = '<div class="empty">ノード情報なし</div>';
    return;
  }

  const lat = node.latency_ms != null ? `${node.latency_ms} ms` : '—';
  const lastChecked = node.last_checked
    ? new Date(node.last_checked * 1000).toLocaleTimeString('ja-JP')
    : '—';

  let detailHtml = '';
  if (node.type === 'ollama_backend' && node.detail.models) {
    const tags = node.detail.models.map(m =>
      `<span class="model-tag">${escapeHtml(m)}</span>`).join('');
    detailHtml = `<h2 style="margin-top:20px">ロード済みモデル</h2><div class="models-list">${tags || '<span class="empty">なし</span>'}</div>`;
  }
  if (node.type === 'docker' && node.detail.docker_status) {
    detailHtml += `
      <div class="field"><span class="field-key">Docker status</span><span class="field-val">${escapeHtml(node.detail.docker_status)}</span></div>
      <div class="field"><span class="field-key">Restart count</span><span class="field-val">${node.detail.restart_count ?? 0}</span></div>
    `;
  }

  side.innerHTML = `
    <div class="selected-name">${escapeHtml(node.name)}</div>
    <div class="selected-meta">${escapeHtml(GROUP_LABEL[node.group] || node.group)} · ${escapeHtml(node.type)}</div>

    <div class="field"><span class="field-key">Status</span><span class="field-val"><span class="dot ${node.status}"></span> ${node.status}</span></div>
    <div class="field"><span class="field-key">応答時間</span><span class="field-val">${lat}</span></div>
    <div class="field"><span class="field-key">最終チェック</span><span class="field-val">${lastChecked}</span></div>
    ${detailHtml}
    ${node.error ? `<div class="err">${escapeHtml(node.error)}</div>` : ''}

    <h2 style="margin-top:24px">応答時間 (過去1時間)</h2>
    <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
  `;

  loadHistory(selectedId);
}

async function loadHistory(targetId) {
  try {
    // ollama-backend-* は履歴を持たないので Proxy 側を見る
    const queryId = targetId.startsWith('ollama-backend-') ? 'ollama-proxy' : targetId;
    const res = await fetch(`${API}/api/history/${encodeURIComponent(queryId)}?hours=1`);
    const data = await res.json();
    drawChart(data.points);
  } catch (e) {
    console.error('history load failed', e);
  }
}

function drawChart(points) {
  const ctx = document.getElementById('trend-chart');
  if (!ctx) return;
  if (chart) chart.destroy();

  const labels = points.map(p => new Date(p.ts * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  const data = points.map(p => p.latency_ms);

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '応答時間 (ms)',
        data,
        borderColor: '#58a6ff',
        backgroundColor: 'rgba(88, 166, 255, 0.1)',
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 1.5,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 6, font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          ticks: { color: '#8b949e', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
          beginAtZero: true,
        }
      }
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
  );
}

// 起動
initCy();
fetchAndRender();
setInterval(fetchAndRender, 10000);
