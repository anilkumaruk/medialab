import { api } from './api.js';
import { esc, ICONS, initials, shortName, relTime, toastError } from './ui.js';
import { cart } from './cart.js';
import * as auth from './pages/auth.js';
import * as user from './pages/user.js';
import * as admin from './pages/admin.js';

const app = document.getElementById('app');
const state = { user: undefined, config: { allowedDomains: [], devMode: false, maxRequestDays: 14 } };

const ROUTES = [
  ['/login', auth.login, { public: true }],
  ['/register', auth.register, { public: true }],
  ['/forgot', auth.forgot, { public: true }],
  ['/home', user.home],
  ['/inventory/:category', user.inventory],
  ['/request/new', user.newRequest],
  ['/request/:id/edit', user.newRequest],
  ['/requests', user.myRequests],
  ['/requests/:id', user.requestDetail, { shared: true }],
  ['/history', user.history],
  ['/admin', admin.dashboard, { admin: true }],
  ['/admin/approvals', admin.approvals, { admin: true }],
  ['/admin/approvals/:id', admin.approvals, { admin: true }],
  ['/admin/issue', admin.issue, { admin: true }],
  ['/admin/returns', admin.returns, { admin: true }],
  ['/admin/returns/:id', admin.returns, { admin: true }],
  ['/admin/inventory', admin.inventory, { admin: true }],
  ['/admin/logs', admin.logs, { admin: true }],
  ['/admin/users', admin.users, { admin: true }],
  ['/admin/labels/:id', admin.labels, { admin: true }],
].map(([pattern, handler, opts = {}]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  return { re, keys, handler, opts };
});

function match(path) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const homePath = () => (state.user?.role === 'admin' ? '/admin' : '/home');
const currentPath = () => location.hash.slice(1).split('?')[0] || '/';

function go(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

function setUser(u) {
  state.user = u;
  if (u) cart.setUser(u.id);
  shellKey = null;
}

async function logout() {
  try {
    await api('/auth/logout', { body: {} });
  } catch {
    /* already logged out */
  }
  setUser(null);
  go('/login');
}

// ---------------- Shell ----------------

let shellKey = null;

function roleLabel(u) {
  if (u.role === 'admin') return u.approvalLevel ? `Admin · Level ${u.approvalLevel}` : 'Admin';
  return u.profession === 'faculty' ? 'Faculty' : 'Student';
}

function navHtml() {
  const link = (href, icon, label, badge = '') =>
    `<a href="#${href}" data-nav="${href}">${ICONS[icon]}<span>${label}</span>${badge ? `<span class="count-pill hidden" data-badge="${badge}"></span>` : ''}</a>`;
  if (state.user.role === 'admin') {
    return `${link('/admin', 'grid', 'Dashboard')}
      <div class="nav-section">Workflow</div>
      ${link('/admin/approvals', 'check', 'Approvals', 'approvals')}
      ${link('/admin/issue', 'scan', 'Issue', 'issue')}
      ${link('/admin/returns', 'undo', 'Returns', 'returns')}
      <div class="nav-section">Manage</div>
      ${link('/admin/inventory', 'box', 'Inventory')}
      ${link('/admin/logs', 'file', 'Logs')}
      ${link('/admin/users', 'users', 'Users')}`;
  }
  return `${link('/home', 'home', 'Home')}
    <div class="nav-section">Equipment</div>
    ${link('/inventory/Cameras', 'camera', 'Cameras')}
    ${link('/inventory/Lenses', 'lens', 'Lenses')}
    ${link('/inventory/Lights', 'light', 'Lights')}
    ${link('/inventory/Audio', 'audio', 'Audio')}
    ${link('/inventory/Accessories', 'box', 'Accessories')}
    <div class="nav-section">My activity</div>
    ${link('/requests', 'list', 'My Requests')}
    ${link('/history', 'clock', 'History')}`;
}

function ensureShell() {
  const u = state.user;
  const key = `${u.id}:${u.role}:${u.approvalLevel}`;
  if (shellKey !== key || !app.querySelector('.layout')) {
    shellKey = key;
    app.innerHTML = `<div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">M</div><div><div class="brand-name">MediaLab</div><div class="brand-role">${esc(roleLabel(u))}</div></div></div>
        <nav class="nav">${navHtml()}</nav>
        <div class="sidebar-foot">Request › Approve › Issue › Return › Log</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" data-menu aria-label="Menu">${ICONS.menu}</button>
          <h1 id="page-title"></h1>
          ${u.role !== 'admin' ? `<a class="icon-btn" href="#/request/new" title="Current request" aria-label="Current request">${ICONS.cart}<span class="count-pill hidden" data-cart-pill></span></a>` : ''}
          <div class="dropdown" id="bell-dd"><button class="icon-btn" data-bell aria-label="Notifications">${ICONS.bell}<span class="count-pill hidden" id="bell-count"></span></button></div>
          <div class="dropdown" id="user-dd"><button class="user-chip" data-user-menu><span class="avatar">${esc(initials(u.name))}</span><span class="name">${esc(shortName(u.name))}</span></button></div>
        </header>
        <div id="view-host"></div>
      </div>
    </div>`;
    bindShell();
    updateCartCount();
  }
  const path = currentPath();
  app.querySelectorAll('[data-nav]').forEach((a) => {
    const href = a.dataset.nav;
    const active = path === href || (href !== '/admin' && path.startsWith(href + '/'));
    a.classList.toggle('active', active);
  });
  app.querySelector('.layout').classList.remove('nav-open');
  const view = document.createElement('div');
  view.className = 'view';
  app.querySelector('#view-host').replaceChildren(view);
  window.scrollTo(0, 0);
  return view;
}

function closeMenus() {
  app.querySelectorAll('.menu').forEach((m) => m.remove());
}

function bindShell() {
  const layout = app.querySelector('.layout');
  layout.addEventListener('click', async (e) => {
    if (e.target.closest('[data-menu]')) return layout.classList.toggle('nav-open');
    if (layout.classList.contains('nav-open') && !e.target.closest('.sidebar')) layout.classList.remove('nav-open');

    if (e.target.closest('[data-user-menu]')) {
      const open = app.querySelector('#user-dd .menu');
      closeMenus();
      if (open) return;
      const u = state.user;
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.innerHTML = `<div class="menu-head"><div class="strong">${esc(u.name)}</div><div class="muted sm">${esc(u.email)}</div>
          <div class="muted sm">${esc(roleLabel(u))}${u.department ? ' · ' + esc(u.department) : ''}${u.batch ? ' · ' + esc(u.batch) : ''}</div></div>
        <button class="menu-item" data-logout>Log out</button>`;
      app.querySelector('#user-dd').appendChild(menu);
      return;
    }
    if (e.target.closest('[data-logout]')) return logout();

    if (e.target.closest('[data-bell]')) {
      const open = app.querySelector('#bell-dd .menu');
      closeMenus();
      if (open) return;
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.style.width = 'min(360px, calc(100vw - 32px))';
      menu.innerHTML = '<div class="menu-head strong">Notifications</div><div class="notif-list"><div class="loading"><span class="spinner"></span></div></div>';
      app.querySelector('#bell-dd').appendChild(menu);
      try {
        const data = await api('/notifications');
        menu.querySelector('.notif-list').innerHTML = data.notifications.length
          ? data.notifications
              .map(
                (n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${n.link ? '#' + esc(n.link) : 'javascript:void 0'}">
                  <div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div><div class="xs muted">${relTime(n.createdAt)}</div></a>`
              )
              .join('')
          : '<div class="empty sm">No notifications yet</div>';
        if (data.unread) {
          await api('/notifications/read', { body: {} });
          setBellCount(0);
        }
      } catch (err) {
        toastError(err);
      }
      return;
    }
    if (!e.target.closest('.menu')) closeMenus();
    else if (e.target.closest('a')) closeMenus();
  });
}

function setBellCount(n) {
  const el = app.querySelector('#bell-count');
  if (!el) return;
  el.textContent = n > 9 ? '9+' : n;
  el.classList.toggle('hidden', !n);
}

function updateCartCount() {
  const n = cart.count();
  document.querySelectorAll('[data-cart-count]').forEach((el) => (el.textContent = n));
  const pill = app.querySelector('[data-cart-pill]');
  if (pill) {
    pill.textContent = n;
    pill.classList.toggle('hidden', !n);
  }
}

// ---------------- Live data (bell, admin badges, duration alerts) ----------------

let lastLive = 0;
async function refreshLive(force = false) {
  if (!state.user || (!force && Date.now() - lastLive < 10e3)) return;
  lastLive = Date.now();
  try {
    const n = await api('/notifications');
    setBellCount(n.unread);
    if (state.user.role === 'admin') {
      const d = await api('/admin/dashboard');
      const lvl = state.user.approvalLevel;
      const c = d.counts;
      const approvals = (lvl === 1 ? c.pendingL1 : lvl === 2 ? c.pendingL2 : c.pendingL1 + c.pendingL2) + c.renewals;
      const set = (k, v) => {
        const el = app.querySelector(`[data-badge="${k}"]`);
        if (el) {
          el.textContent = v;
          el.classList.toggle('hidden', !v);
        }
      };
      set('approvals', approvals);
      set('issue', c.toIssue);
      set('returns', c.overdue);
    } else {
      await user.refreshFloatingAlerts(ctxFor(new URLSearchParams()), currentPath());
    }
  } catch {
    /* transient - next poll will retry */
  }
}

// ---------------- Router ----------------

function ctxFor(query) {
  return {
    user: state.user,
    config: state.config,
    query,
    go,
    setUser,
    logout,
    refresh: () => refreshLive(true),
    setTitle: (t) => {
      const el = document.getElementById('page-title');
      if (el) el.textContent = t;
      document.title = `${t} · MediaLab`;
    },
  };
}

let seq = 0;
async function render() {
  const mySeq = ++seq;
  const [rawPath, qs = ''] = location.hash.slice(1).split('?');
  const path = rawPath || '/';
  const query = new URLSearchParams(qs);

  if (state.user === undefined) {
    try {
      const [me, cfg] = await Promise.all([api('/auth/me'), api('/auth/config')]);
      state.config = cfg;
      setUser(me.user);
    } catch {
      setUser(null);
    }
  }
  if (mySeq !== seq) return;

  const m = match(path);
  if (!m) return go(state.user ? homePath() : '/login');

  if (m.opts.public) {
    if (state.user) return go(homePath());
    shellKey = null;
    document.querySelector('.floating-alerts')?.remove();
    const view = document.createElement('div');
    app.replaceChildren(view);
    return run(m, view, ctxFor(query));
  }

  if (!state.user) return go('/login' + (path !== '/' ? `?next=${encodeURIComponent(path)}` : ''));
  const isAdmin = state.user.role === 'admin';
  if (m.opts.admin && !isAdmin) return go('/home');
  if (!m.opts.admin && !m.opts.shared && isAdmin) return go('/admin');

  const view = ensureShell();
  await run(m, view, ctxFor(query));
  refreshLive();
}

async function run(m, view, ctx) {
  try {
    await m.handler(view, ctx, m.params);
  } catch (e) {
    console.error(e);
    if (e.status === 401) return;
    if (view.isConnected) {
      view.innerHTML = `<div class="card"><div class="empty"><h3>${e.status === 404 ? 'Not found' : 'Could not load this page'}</h3><p>${esc(e.message)}</p>
        <button class="btn btn-primary" onclick="location.reload()">Try again</button></div></div>`;
    }
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('ml:cart', updateCartCount);
window.addEventListener('ml:unauthorized', () => {
  if (state.user) {
    setUser(null);
    go('/login');
  }
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshLive());
setInterval(() => refreshLive(true), 60e3);

render();
