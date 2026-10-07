export const CATEGORIES = ['Cameras', 'Lenses', 'Lights', 'Audio', 'Accessories'];
const ABBR = { Cameras: 'CAM', Lenses: 'LNS', Lights: 'LGT', Audio: 'AUD', Accessories: 'ACC' };
export const catAbbr = (c) => ABBR[c] || 'EQ';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const initials = (name) =>
  String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export const shortName = (name) => {
  const p = String(name || '').split(/\s+/).filter(Boolean);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || '';
};

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtShort = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '');
export const fmtDateTime = (iso) => (iso ? `${fmtShort(iso)}, ${fmtTime(iso)}` : '—');
export const fmtRange = (a, b) => (a && b ? `${fmtShort(a)} – ${fmtShort(b)}` : '—');
export const fmtRangeFull = (a, b) => (a && b ? `${fmtDateTime(a)} → ${fmtDateTime(b)}` : '—');

export function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtShort(iso);
}

export function duration(ms) {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600e3);
  const m = Math.max(1, Math.round((abs % 3600e3) / 60e3));
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m} min`;
}

export function dueText(iso) {
  const ms = new Date(iso) - Date.now();
  return ms >= 0 ? `due in ${duration(ms)}` : `overdue by ${duration(ms)}`;
}

const STATUS = {
  draft: ['Draft', 'gray'],
  pending_l1: ['Pending L1', 'blue'],
  pending_l2: ['Pending L2', 'blue'],
  approved: ['Approved', 'teal'],
  rejected: ['Rejected', 'red'],
  issued: ['In use', 'amber'],
  returned: ['Returned', 'green'],
  cancelled: ['Cancelled', 'gray'],
  overdue: ['Overdue', 'red'],
  available: ['Available', 'teal'],
  in_use: ['In use', 'amber'],
  maintenance: ['Maint.', 'red'],
  retired: ['Retired', 'gray'],
};

export function badge(status, label) {
  const [l, c] = STATUS[status] || [status, 'gray'];
  return `<span class="badge ${c}">${esc(label || l)}</span>`;
}

export const requestBadge = (r) => (r.overdue ? badge('overdue') : r.status === 'returned' && r.damageReported ? badge('rejected', 'Damaged') : badge(r.status));

// Log statuses are free text such as "IN USE" or "CLOSED".
export function logBadge(status) {
  const s = String(status || '').toUpperCase();
  if (!s) return '';
  const c = /REJECT|DAMAGE|OVERDUE|MAINT/.test(s) ? 'red' : /CLOSED|RETURN|ACTIVE|AVAILABLE/.test(s) ? 'green' : /IN USE/.test(s) ? 'amber' : /APPROVED/.test(s) ? 'teal' : /PENDING/.test(s) ? 'blue' : 'gray';
  return `<span class="badge ${c}">${esc(s)}</span>`;
}

export function toast(msg, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
export const toastError = (e) => toast(esc(e?.message || 'Something went wrong'), 'error', 5000);

export function modal({ title = '', body = '', footer = '', wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    ${title ? `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>` : ''}
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
  </div>`;
  root.appendChild(wrap);
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    if (!wrap.isConnected) return;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  const el = wrap.querySelector('.modal');
  setTimeout(() => el.querySelector('[autofocus], input:not([type=hidden]), textarea')?.focus(), 30);
  return { el, close };
}

export function confirmBox({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title,
      body: `<p class="muted">${message}</p>`,
      footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
      onClose: () => resolve(result),
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => {
      result = true;
      m.close();
    });
  });
}

// Runs an async action while showing a spinner on the button.
export async function withButton(btn, fn) {
  if (!btn || btn.disabled) return;
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${html}`;
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.innerHTML = html;
    }
  }
}

// Marks a form field invalid using the `field` key the API returns.
export function showFieldError(form, field, message) {
  form.querySelectorAll('.field.error').forEach((f) => f.classList.remove('error'));
  form.querySelectorAll('.field-error').forEach((f) => (f.textContent = ''));
  if (!field) return false;
  const input = form.querySelector(`[name="${field}"]`);
  const wrap = input?.closest('.field');
  if (!wrap) return false;
  wrap.classList.add('error');
  const err = wrap.querySelector('.field-error');
  if (err) err.textContent = message;
  input.focus();
  return true;
}

export const toLocalInput = (d) => {
  if (!d) return '';
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
};
export const toDateInput = (d) => toLocalInput(d).slice(0, 10);

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export const loadingHtml = () => '<div class="loading"><span class="spinner"></span></div>';
export const emptyHtml = (title, text = '', action = '') => `<div class="empty"><h3>${esc(title)}</h3><p>${text}</p>${action}</div>`;

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/></svg>',
  lens: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8M18 8v8"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h8"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  cart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};
