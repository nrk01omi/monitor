// Shared top-navigation strip injected at runtime so both /index.html and
// /topology.html show the same menu without copy-pasting markup.
(function () {
  'use strict';

  const links = [
    { href: '/',         label: 'Requests' },
    { href: '/topology', label: 'Topology' },
    { href: '/archives', label: 'Archives' },
  ];

  function build() {
    const host = document.getElementById('top-nav');
    if (!host) return;

    const here = location.pathname.replace(/\/+$/, '') || '/';
    const html = links.map(l => {
      const active = (l.href === '/' ? here === '/' : here === l.href);
      return `<a class="topnav-link${active ? ' active' : ''}" href="${l.href}">${l.label}</a>`;
    }).join('');

    host.innerHTML = `<nav class="topnav">${html}</nav>`;

    if (!document.getElementById('topnav-styles')) {
      const style = document.createElement('style');
      style.id = 'topnav-styles';
      style.textContent = `
        .topnav {
          display: flex;
          gap: 4px;
          padding: 4px 20px;
          background: var(--surface, #161b22);
          border-bottom: 1px solid var(--border, #30363d);
          flex-shrink: 0;
        }
        .topnav-link {
          padding: 8px 14px;
          font-size: 13px;
          color: var(--text2, #8b949e);
          text-decoration: none;
          border-bottom: 2px solid transparent;
          transition: color .15s, border-color .15s;
        }
        .topnav-link:hover { color: var(--text, #e6edf3); }
        .topnav-link.active {
          color: var(--accent, #58a6ff);
          border-bottom-color: var(--accent, #58a6ff);
        }
      `;
      document.head.appendChild(style);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
