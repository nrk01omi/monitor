// Archives view — lists per-table per-day NDJSON.gz files and offers
// download + on-demand "Archive now" trigger.
(function () {
  'use strict';

  const body = document.getElementById('body');
  const btnRun = document.getElementById('btnRun');
  const btnRefresh = document.getElementById('btnRefresh');

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MiB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
  }

  function fmtMtime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('ja-JP', { hour12: false });
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function load() {
    body.innerHTML = '<div class="empty">読み込み中…</div>';
    try {
      const data = await fetch('/api/archives').then(r => r.json());
      render(data);
    } catch (e) {
      body.innerHTML = `<div class="empty">読み込み失敗: ${escapeHtml(e.message)}</div>`;
    }
  }

  function render(data) {
    const tables = Object.keys(data).sort();
    if (tables.length === 0) {
      body.innerHTML = '<div class="empty">アーカイブはまだありません。「Archive now」を押すか、03:00 JSTの自動実行をお待ちください。</div>';
      return;
    }
    body.innerHTML = tables.map(table => {
      const files = data[table];
      const rows = files.length === 0
        ? '<tr><td colspan="3"><span class="empty">なし</span></td></tr>'
        : files.map(f => `
          <tr>
            <td class="date">${escapeHtml(f.date)}</td>
            <td class="size">${fmtBytes(f.size_bytes)}</td>
            <td class="mtime">${fmtMtime(f.mtime)}</td>
            <td><a href="/api/archives/${encodeURIComponent(table)}/${encodeURIComponent(f.date)}.ndjson.gz">download</a></td>
          </tr>
        `).join('');
      return `
        <section class="table-section">
          <h2>${escapeHtml(table)} (${files.length} file${files.length === 1 ? '' : 's'})</h2>
          <table>
            <thead><tr><th>Date (JST)</th><th>Size</th><th>Modified</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
      `;
    }).join('');
  }

  btnRefresh.addEventListener('click', load);

  btnRun.addEventListener('click', async () => {
    if (!confirm('30日より古い行を NDJSON.gz に書き出して DB から削除します。実行しますか?')) return;
    btnRun.disabled = true;
    const orig = btnRun.textContent;
    btnRun.textContent = '実行中…';
    try {
      const res = await fetch('/api/archives/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast(`エラー: ${data.error || res.status}`, 'error');
      } else {
        const summary = (data.summary || []).map(s =>
          s.error ? `${s.table}: ERROR ${s.error}`
                  : `${s.table}: archived=${s.archived} files=${s.files} deleted=${s.deleted}` + (s.skipped_days ? ` skipped_days=${s.skipped_days}` : '')
        ).join(' / ');
        toast(`完了 (${data.elapsed_ms}ms) — ${summary}`, 'ok');
        load();
      }
    } catch (e) {
      toast('実行失敗: ' + e.message, 'error');
    } finally {
      btnRun.disabled = false;
      btnRun.textContent = orig;
    }
  });

  load();
})();
