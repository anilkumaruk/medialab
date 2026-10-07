import { api } from '../api.js';
import {
  CATEGORIES, catAbbr, esc, badge, requestBadge, fmtRange, fmtRangeFull, fmtDateTime, fmtShort, dueText, toast, toastError,
  modal, confirmBox, withButton, showFieldError, toLocalInput, debounce, loadingHtml, emptyHtml, ICONS,
} from '../ui.js';
import { cart } from '../cart.js';

// ---------------- Shared pieces ----------------

function statCards(c) {
  return `<div class="stats">
    <a class="stat c-blue" href="#/requests?f=active"><div class="label">Active</div><div class="value">${c.active}</div></a>
    <a class="stat c-amber" href="#/requests?f=pending"><div class="label">Pending</div><div class="value">${c.pending}</div></a>
    <a class="stat c-red" href="#/requests?f=rejected"><div class="label">Rejected</div><div class="value">${c.rejected}</div></a>
    <a class="stat c-green" href="#/requests?f=returned"><div class="label">Returned</div><div class="value">${c.returned}</div></a>
  </div>`;
}

function rowActions(r) {
  const view = `<a href="#/requests/${r.id}">View</a>`;
  switch (r.status) {
    case 'issued':
      return r.renewal?.status === 'pending'
        ? `<span class="muted sm">Renewal pending</span>`
        : `<button class="link-btn" data-act="renew" data-id="${r.id}">Renew</button>`;
    case 'rejected':
      return `<a href="#/requests/${r.id}">View remarks</a>`;
    case 'draft':
      return `<a href="#/request/${r.id}/edit">Edit</a><button class="link-btn danger" data-act="delete" data-id="${r.id}">Delete</button>`;
    case 'pending_l1':
    case 'pending_l2':
      return `${view}<button class="link-btn danger" data-act="cancel" data-id="${r.id}">Cancel</button>`;
    default:
      return view;
  }
}

function requestsTable(list) {
  if (!list.length) return emptyHtml('No requests here', 'Requests you make will appear in this list.', '<a class="btn btn-primary" href="#/inventory/Cameras">Browse equipment</a>');
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Request</th><th>Equipment</th><th>Duration</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${list
      .map(
        (r) => `<tr class="clickable" data-href="${r.status === 'draft' ? `/request/${r.id}/edit` : `/requests/${r.id}`}">
          <td class="strong nowrap">${esc(r.code)}</td>
          <td>${esc(r.summary)}</td>
          <td class="nowrap">${r.fromAt ? fmtRange(r.fromAt, r.toAt) : '<span class="muted">Not set</span>'}</td>
          <td>${requestBadge(r)}</td>
          <td class="actions">${rowActions(r)}</td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

// Handles clicks on request tables (row navigation + inline actions).
function bindRequestTable(root, ctx, list, onChange) {
  root.onclick = async (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const r = list.find((x) => x.id === Number(act.dataset.id));
      if (act.dataset.act === 'renew') return renewModal(r, onChange);
      if (act.dataset.act === 'delete') {
        if (!(await confirmBox({ title: 'Delete draft?', message: `${esc(r.code)} will be removed.`, confirmText: 'Delete', danger: true }))) return;
        try {
          await api(`/requests/${r.id}`, { method: 'DELETE' });
          if (cart.get().draftId === r.id) cart.clear();
          toast('Draft deleted', 'success');
          onChange();
        } catch (err) {
          toastError(err);
        }
      }
      if (act.dataset.act === 'cancel') {
        if (!(await confirmBox({ title: 'Cancel request?', message: `${esc(r.code)} will be withdrawn from approval.`, confirmText: 'Cancel request', danger: true }))) return;
        try {
          await api(`/requests/${r.id}/cancel`, { body: {} });
          toast(`${esc(r.code)} cancelled`, 'success');
          onChange();
        } catch (err) {
          toastError(err);
        }
      }
      return;
    }
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a, button')) ctx.go(row.dataset.href);
  };
}

export function renewModal(r, onDone) {
  const min = new Date(Math.max(new Date(r.toAt), Date.now()) + 3600e3);
  const m = modal({
    title: `Renew ${r.code}`,
    body: `<p class="muted" style="margin-bottom:16px">${esc(r.summary)} is currently due <strong>${fmtDateTime(r.toAt)}</strong>. Your renewal goes to the approvers.</p>
      <form class="stack" id="renew" novalidate>
        <div class="field"><label>New return date &amp; time</label><input class="input" type="datetime-local" name="renewTo" value="${toLocalInput(new Date(new Date(r.toAt).getTime() + 864e5))}" min="${toLocalInput(min)}"><div class="field-error"></div></div>
        <div class="field"><label>Reason</label><textarea class="input" name="reason" maxlength="300" placeholder="e.g. Extra shoot day needed for Media Fest"></textarea><div class="field-error"></div></div>
      </form>`,
    footer: '<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-submit>Request renewal</button>',
  });
  const form = m.el.querySelector('#renew');
  m.el.querySelector('[data-submit]').addEventListener('click', (e) =>
    withButton(e.currentTarget, async () => {
      try {
        const v = form.renewTo.value;
        await api(`/requests/${r.id}/renew`, { body: { renewTo: v ? new Date(v).toISOString() : '', reason: form.reason.value } });
        m.close();
        toast('Renewal requested. You will be notified once it is reviewed.', 'success');
        onDone?.();
      } catch (err) {
        showFieldError(form, err.data?.field, err.message);
        toastError(err);
      }
    })
  );
}

function alertCards(due, returned) {
  return [
    ...due.map(
      (r) => `<div class="alert-card danger">
        <div class="eyebrow">${r.overdue ? 'Overdue' : 'Duration alert'}</div>
        <h3>${esc(r.items[0]?.name || r.summary)} is ${dueText(r.toAt)}</h3>
        <p class="sm">Return to Media Lab by ${fmtDateTime(r.toAt)}${r.renewal?.status === 'pending' ? '. Your renewal request is awaiting approval.' : ' or apply to renew.'}</p>
        <div class="row">
          ${r.renewal?.status === 'pending' ? '' : `<button class="btn btn-danger" data-alert-renew="${r.id}">Renew</button>`}
          <button class="btn btn-ghost" data-alert-dismiss="${r.id}">Dismiss</button>
        </div>
      </div>`
    ),
    ...returned.map(
      (r) => `<div class="alert-card ${r.damageReported ? 'warn' : 'success'}">
        <div class="eyebrow">${r.damageReported ? 'Return recorded · damage reported' : 'Return verified'}</div>
        <h3>${esc(r.summary)} removed from active list</h3>
        <p class="sm">${r.damageReported ? `Condition notes: ${esc(r.returnNotes || '')}` : `${esc(r.verifiedBy || 'Admin')} confirmed the return checklist and pressed OK.`}</p>
        <div class="row"><button class="btn btn-ghost btn-sm" data-alert-dismiss="${r.id}">Dismiss</button></div>
      </div>`
    ),
  ].join('');
}

// Loads duration/return alerts into a container and wires its buttons.
async function mountAlerts(container, { includeReturned = true } = {}) {
  const data = await api('/alerts');
  const due = data.due;
  const returned = includeReturned ? data.returned : [];
  const reload = () => mountAlerts(container, { includeReturned });
  container.innerHTML = alertCards(due, returned);
  container.onclick = async (e) => {
    const renew = e.target.closest('[data-alert-renew]');
    const dismiss = e.target.closest('[data-alert-dismiss]');
    if (renew) renewModal(due.find((r) => r.id === Number(renew.dataset.alertRenew)), reload);
    if (dismiss) {
      try {
        await api(`/requests/${dismiss.dataset.alertDismiss}/dismiss`, { body: {} });
        reload();
      } catch (err) {
        toastError(err);
      }
    }
  };
  return due.length + returned.length;
}

// Popup alerts shown on every student page except those that already list them.
export async function refreshFloatingAlerts(ctx, path) {
  let box = document.querySelector('.floating-alerts');
  if (!ctx.user || ctx.user.role === 'admin' || ['/home', '/requests'].includes(path)) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = 'floating-alerts';
    document.body.appendChild(box);
  }
  await mountAlerts(box, { includeReturned: false });
}

// ---------------- Home ----------------

export async function home(view, ctx) {
  ctx.setTitle('Home');
  view.innerHTML = loadingHtml();
  const [mine, eq] = await Promise.all([api('/requests/mine'), api('/equipment')]);
  const cats = CATEGORIES.map((c) => {
    const list = eq.equipment.filter((e) => e.category === c);
    return { c, models: list.length, available: list.reduce((n, e) => n + e.available, 0), total: list.reduce((n, e) => n + e.total, 0) };
  });
  const first = esc(ctx.user.name.split(' ')[0]);
  view.innerHTML = `
    <div class="card hero">
      <div class="spacer"><h2>Hi ${first}</h2><p>Browse live inventory, request equipment and track every approval.</p></div>
      <a class="btn btn-primary btn-lg" href="#/inventory/Cameras">Browse equipment</a>
    </div>
    <div id="alerts" class="alert-grid" style="margin-top:20px"></div>
    <div style="margin-top:20px">${statCards(mine.counts)}</div>
    <h3 class="section-title">Browse by category</h3>
    <div class="cat-grid">${cats
      .map(
        (x) => `<a class="cat-tile" href="#/inventory/${x.c}">
          <div class="eq-thumb">${catAbbr(x.c)}</div>
          <h4>${x.c}</h4>
          <div class="sm muted">${x.models} models</div>
          <div class="avail ${x.available ? '' : 'none'}">Available ${x.available} / ${x.total}</div>
        </a>`
      )
      .join('')}</div>
    <div class="card" style="margin-top:28px">
      <div class="card-head"><h3>Recent requests</h3><a href="#/requests">View all</a></div>
      <div id="recent">${requestsTable(mine.requests.filter((r) => r.status !== 'cancelled').slice(0, 5))}</div>
    </div>`;
  bindRequestTable(view.querySelector('#recent'), ctx, mine.requests, () => home(view, ctx));
  await mountAlerts(view.querySelector('#alerts'));
}

// ---------------- Inventory ----------------

function equipmentCard(e) {
  const inCart = cart.has(e.id);
  let status;
  if (e.available > 0) status = badge('available');
  else if (!e.total) status = badge('retired', 'Unavailable');
  else if (e.inUse + e.reserved > 0) status = badge('in_use', 'All in use');
  else status = badge('maintenance', 'Maintenance');

  let action;
  if (e.available > 0) {
    action = inCart
      ? `<a class="btn btn-secondary btn-block" href="#/request/new">In your request (${inCart.qty}) · Review</a>`
      : `<button class="btn btn-primary btn-block" data-act="select" data-id="${e.id}">Select Equipment</button>`;
  } else {
    action = e.notifying
      ? `<button class="btn btn-ghost btn-block" data-act="unnotify" data-id="${e.id}">✓ We'll notify you · Cancel</button>`
      : `<button class="btn btn-muted btn-block" data-act="notify" data-id="${e.id}">Notify when available</button>`;
  }
  return `<div class="eq-card">
    <div class="eq-top">
      <div class="eq-thumb">${catAbbr(e.category)}</div>
      <div class="eq-info">
        <h4 title="${esc(e.name)}">${esc(e.name)}</h4>
        <div class="sm muted">${esc(e.category.replace(/s$/, ''))}${e.subtype ? ` | ${esc(e.subtype)}` : ''}</div>
        <div class="avail ${e.available ? '' : 'none'}">Available ${e.available} / ${e.total}</div>
        <div>${status}</div>
      </div>
    </div>
    ${action}
  </div>`;
}

async function selectEquipment(e, ctx) {
  let accessories = [];
  try {
    ({ accessories } = await api(`/equipment/${e.id}`));
  } catch (err) {
    return toastError(err);
  }
  if (!accessories.length) {
    cart.add(e);
    toast(`${esc(e.name)} added to your request`, 'success');
    return ctx.go('/request/new');
  }
  const selected = new Set(accessories.filter((a) => a.available > 0).map((a) => a.id));
  const m = modal({
    title: 'Add matching accessories',
    body: `<p class="muted" style="margin-bottom:16px">${esc(e.name)} selected. Choose the required items to continue.</p>
      ${accessories
        .map(
          (a) => `<div class="opt-row">
            <div class="eq-thumb sm">${esc(a.name[0])}</div>
            <div class="grow"><div class="strong">${esc(a.name)}</div>
              <div class="xs avail ${a.available ? '' : 'none'}">${a.available ? `${a.available} available` : 'None available right now'}${cart.has(a.id) ? ' · already in your request' : ''}</div></div>
            <button class="switch ${selected.has(a.id) ? 'on' : ''}" data-acc="${a.id}" ${a.available ? '' : 'disabled'} aria-pressed="${selected.has(a.id)}">${selected.has(a.id) ? 'ON' : 'OFF'}</button>
          </div>`
        )
        .join('')}`,
    footer: '<button class="btn btn-secondary" data-skip>Skip for now</button><button class="btn btn-primary" data-continue>Continue to dates</button>',
  });
  m.el.addEventListener('click', (ev) => {
    const sw = ev.target.closest('[data-acc]');
    if (sw) {
      const id = Number(sw.dataset.acc);
      selected.has(id) ? selected.delete(id) : selected.add(id);
      sw.classList.toggle('on', selected.has(id));
      sw.textContent = selected.has(id) ? 'ON' : 'OFF';
      sw.setAttribute('aria-pressed', selected.has(id));
    }
    const skip = ev.target.closest('[data-skip]');
    const cont = ev.target.closest('[data-continue]');
    if (skip || cont) {
      cart.add(e);
      if (cont) accessories.filter((a) => selected.has(a.id)).forEach((a) => cart.add(a));
      m.close();
      ctx.go('/request/new');
    }
  });
}

export async function inventory(view, ctx, params) {
  const category = CATEGORIES.includes(params.category) ? params.category : 'Cameras';
  ctx.setTitle('Equipment Inventory');
  let q = '';
  let items = [];
  view.innerHTML = `
    <div class="toolbar">
      <div class="pills" id="pills">${CATEGORIES.map((c) => `<a class="pill ${c === category ? 'active' : ''}" href="#/inventory/${c}">${c}</a>`).join('')}</div>
      <div class="search spacer" style="min-width:220px">${ICONS.search}<input class="input" id="q" placeholder="Search camera, lens, audio..." aria-label="Search equipment"></div>
      <a class="btn btn-teal" href="#/request/new">Review request (<span data-cart-count>${cart.count()}</span>)</a>
    </div>
    <div id="grid">${loadingHtml()}</div>`;
  const grid = view.querySelector('#grid');

  const draw = () => {
    grid.innerHTML = items.length
      ? `<div class="eq-grid">${items.map(equipmentCard).join('')}</div>`
      : `<div class="card">${emptyHtml(q ? 'No matches' : 'Nothing here yet', q ? 'Try a different search.' : 'No equipment in this category yet.')}</div>`;
  };
  const load = async () => {
    const data = await api(q ? `/equipment?q=${encodeURIComponent(q)}` : `/equipment?category=${encodeURIComponent(category)}`);
    items = data.equipment;
    draw();
  };

  view.querySelector('#q').addEventListener(
    'input',
    debounce((e) => {
      q = e.target.value.trim();
      view.querySelectorAll('#pills .pill').forEach((p) => p.classList.toggle('active', !q && p.textContent === category));
      load().catch(toastError);
    }, 250)
  );
  grid.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const eq = items.find((i) => i.id === Number(btn.dataset.id));
    try {
      if (btn.dataset.act === 'select') await selectEquipment(eq, ctx);
      if (btn.dataset.act === 'notify') {
        await withButton(btn, () => api(`/equipment/${eq.id}/notify`, { body: {} }));
        eq.notifying = true;
        toast("We'll notify you when it's available", 'success');
        draw();
      }
      if (btn.dataset.act === 'unnotify') {
        await withButton(btn, () => api(`/equipment/${eq.id}/notify`, { method: 'DELETE' }));
        eq.notifying = false;
        draw();
      }
    } catch (err) {
      toastError(err);
    }
  };
  await load();
}

// ---------------- New request (SOP: select > accessories > duration > purpose > submit) ----------------

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const withTime = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);

export async function newRequest(view, ctx, params) {
  ctx.setTitle(params.id ? 'Edit Draft' : 'New Request');
  view.innerHTML = loadingHtml();

  if (params.id) {
    const { request } = await api(`/requests/${params.id}`);
    if (request.status !== 'draft') return ctx.go(`/requests/${request.id}`);
    const grouped = new Map();
    for (const it of request.items) {
      const g = grouped.get(it.equipmentId);
      if (g) g.qty += 1;
      else grouped.set(it.equipmentId, { equipmentId: it.equipmentId, name: it.name, category: it.category, code: it.code, qty: 1, available: 0 });
    }
    cart.save({ items: [...grouped.values()], draftId: request.id, fromAt: request.fromAt || '', toAt: request.toAt || '', purpose: request.purpose || '' });
  }

  let c = cart.get();
  if (!c.items.length) {
    view.innerHTML = `<div class="card">${emptyHtml('No equipment selected', 'Browse the inventory and select the equipment you need.', '<a class="btn btn-primary" href="#/inventory/Cameras">Browse equipment</a>')}</div>`;
    return;
  }

  const [{ equipment }, approvers] = await Promise.all([api('/equipment'), api('/approvers')]);
  const live = new Map(equipment.map((e) => [e.id, e]));
  c.items = c.items.filter((i) => live.has(i.equipmentId)).map((i) => ({ ...i, available: live.get(i.equipmentId).available }));
  if (!c.fromAt) {
    const tomorrow = new Date(Date.now() + 864e5);
    c.fromAt = withTime(tomorrow, 10).toISOString();
    c.toAt = withTime(new Date(Date.now() + 2 * 864e5), 17).toISOString();
  }
  cart.save(c);

  view.innerHTML = `
    <div class="req-layout">
      <form class="card card-pad stack" id="req" novalidate>
        <div class="req-summary">
          <div class="spacer"><div class="strong" id="title"></div><div class="muted sm">Barcode assigned at issue${c.draftId ? ' · editing saved draft' : ''}</div></div>
          <span class="badge blue" id="n-items"></span>
        </div>
        <div id="items"></div>
        <div><a class="btn btn-secondary btn-sm" href="#/inventory/Cameras">+ Add more equipment</a></div>
        <div class="grid-2">
          <div class="field"><label for="from">From (date &amp; time)</label><input class="input" type="datetime-local" id="from" name="fromAt"></div>
          <div class="field"><label for="to">To (date &amp; time)</label><input class="input" type="datetime-local" id="to" name="toAt"></div>
        </div>
        <div>
          <div class="week-head"><span class="label spacer" id="week-label"></span>
            <button type="button" class="btn btn-ghost btn-sm" data-week="-1" aria-label="Previous week">‹</button>
            <button type="button" class="btn btn-ghost btn-sm" data-week="1" aria-label="Next week">›</button></div>
          <div class="week" id="week"></div>
          <div class="help" style="margin-top:6px">Tap a day to set the pickup date, then tap another to set the return date.</div>
        </div>
        <div class="field"><label for="purpose">Purpose / Remarks *</label>
          <textarea class="input" id="purpose" name="purpose" maxlength="500" placeholder="e.g. Short film shoot for Media Fest - 2 days on campus"></textarea>
          <div class="field-error"></div></div>
        <div class="notice amber">Damage to equipment may result in a fine.</div>
        <div class="grid-2">
          <button type="button" class="btn btn-secondary btn-lg" id="save-draft">Save Draft</button>
          <button type="submit" class="btn btn-primary btn-lg">Submit Approval Request</button>
        </div>
      </form>
      <aside class="card card-pad">
        <h3 style="margin-bottom:10px">What happens next</h3>
        <ol class="steps">
          <li>Your request arrives in the portal and by email to the approvers.</li>
          <li>Level 1 – ${esc(approvers.l1.join(' / ') || 'Level 1 approver')} accept or reject with remarks.</li>
          <li>Level 2 – ${esc(approvers.l2.join(' / ') || 'Level 2 approver')} gives the final decision.</li>
          <li>Collect from the Media Lab – each item's barcode is scanned at issue.</li>
          <li>Return on time – the admin verifies the checklist and closes the request.</li>
        </ol>
        <p class="muted sm" style="margin-top:12px">Maximum ${ctx.config.maxRequestDays} days per request. Take equipment only after approval.</p>
      </aside>
    </div>`;

  const form = view.querySelector('#req');
  const fromIn = form.fromAt;
  const toIn = form.toAt;
  fromIn.value = toLocalInput(c.fromAt);
  toIn.value = toLocalInput(c.toAt);
  fromIn.min = toLocalInput(new Date());
  form.purpose.value = c.purpose || '';
  let weekOffset = 0;
  let pickingEnd = false;

  const persist = () => {
    c.fromAt = fromIn.value ? new Date(fromIn.value).toISOString() : '';
    c.toAt = toIn.value ? new Date(toIn.value).toISOString() : '';
    c.purpose = form.purpose.value;
    cart.save(c);
  };

  function drawItems() {
    const names = c.items.map((i) => i.name);
    view.querySelector('#title').textContent = names.slice(0, 4).join(' + ') + (names.length > 4 ? ` + ${names.length - 4} more` : '');
    const n = c.items.reduce((a, i) => a + i.qty, 0);
    view.querySelector('#n-items').textContent = `${n} item${n === 1 ? '' : 's'}`;
    view.querySelector('#items').innerHTML = c.items
      .map(
        (i) => `<div class="item-row">
          <div class="eq-thumb sm">${catAbbr(i.category)}</div>
          <div class="grow"><div class="strong">${esc(i.name)}</div>
            <div class="xs ${i.available >= i.qty ? 'avail' : 'avail none'}">${i.available >= i.qty ? `${i.available} available` : i.available ? `Only ${i.available} available` : 'Not available right now'}</div></div>
          <div class="qty"><button type="button" data-q="-1" data-id="${i.equipmentId}" ${i.qty <= 1 ? 'disabled' : ''} aria-label="Decrease">−</button><span>${i.qty}</span><button type="button" data-q="1" data-id="${i.equipmentId}" ${i.qty >= Math.min(10, i.available) ? 'disabled' : ''} aria-label="Increase">+</button></div>
          <button type="button" class="icon-btn" data-remove="${i.equipmentId}" aria-label="Remove ${esc(i.name)}">✕</button>
        </div>`
      )
      .join('');
  }

  function drawWeek() {
    const from = fromIn.value ? new Date(fromIn.value) : new Date();
    const to = toIn.value ? new Date(toIn.value) : null;
    const base = startOfDay(from);
    base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + weekOffset * 7); // Monday
    const today = startOfDay(new Date());
    const days = Array.from({ length: 7 }, (_, i) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + i));
    view.querySelector('#week-label').textContent = `${fmtShort(days[0])} – ${fmtShort(days[6])}`;
    view.querySelector('#week').innerHTML = days
      .map((d) => {
        const inRange = fromIn.value && d >= startOfDay(from) && (to ? d <= startOfDay(to) : +d === +startOfDay(from));
        return `<div class="day"><span class="dow">${'SMTWTFS'[d.getDay()]}</span>
          <button type="button" class="${inRange ? 'in' : ''}" data-day="${d.getTime()}" ${d < today ? 'disabled' : ''}>${d.getDate()}</button>
          <span class="mon">${d.getDate() === 1 || d === days[0] ? d.toLocaleString('en-IN', { month: 'short' }) : ''}</span></div>`;
      })
      .join('');
  }

  view.querySelector('#items').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    const rm = e.target.closest('[data-remove]');
    if (q) {
      const it = c.items.find((i) => i.equipmentId === Number(q.dataset.id));
      it.qty = Math.max(1, Math.min(10, it.qty + Number(q.dataset.q)));
    }
    if (rm) {
      c.items = c.items.filter((i) => i.equipmentId !== Number(rm.dataset.remove));
      if (!c.items.length) {
        cart.save(c);
        return newRequest(view, ctx, {});
      }
    }
    if (q || rm) {
      cart.save(c);
      drawItems();
    }
  });

  view.querySelector('#week').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const day = new Date(Number(b.dataset.day));
    const from = fromIn.value ? new Date(fromIn.value) : null;
    const to = toIn.value ? new Date(toIn.value) : null;
    if (!pickingEnd || !from || day < startOfDay(from)) {
      const nf = withTime(day, from ? from.getHours() : 10, from ? from.getMinutes() : 0);
      fromIn.value = toLocalInput(nf);
      if (!to || to <= nf) toIn.value = toLocalInput(withTime(day, 17));
      pickingEnd = true;
    } else {
      toIn.value = toLocalInput(withTime(day, to ? to.getHours() : 17, to ? to.getMinutes() : 0));
      pickingEnd = false;
    }
    persist();
    drawWeek();
  });
  view.querySelectorAll('[data-week]').forEach((b) =>
    b.addEventListener('click', () => {
      weekOffset += Number(b.dataset.week);
      drawWeek();
    })
  );
  fromIn.addEventListener('change', () => {
    if (fromIn.value && toIn.value && new Date(toIn.value) <= new Date(fromIn.value)) toIn.value = toLocalInput(withTime(new Date(fromIn.value), 17));
    weekOffset = 0;
    persist();
    drawWeek();
  });
  toIn.addEventListener('change', () => {
    persist();
    drawWeek();
  });
  form.purpose.addEventListener('input', debounce(persist, 300));

  async function save(submit, btn) {
    persist();
    await withButton(btn, async () => {
      try {
        const { request } = await api('/requests', {
          body: {
            id: c.draftId || undefined,
            items: c.items.map((i) => ({ equipmentId: i.equipmentId, qty: i.qty })),
            fromAt: c.fromAt || null,
            toAt: c.toAt || null,
            purpose: c.purpose,
            submit,
          },
        });
        if (submit) {
          cart.clear();
          toast(`${esc(request.code)} submitted for approval`, 'success');
          ctx.go(`/requests/${request.id}`);
        } else {
          c.draftId = request.id;
          cart.save(c);
          toast(`Draft ${esc(request.code)} saved`, 'success');
        }
      } catch (err) {
        showFieldError(form, err.data?.field, err.message);
        toastError(err);
      }
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(true, form.querySelector('[type=submit]'));
  });
  view.querySelector('#save-draft').addEventListener('click', (e) => save(false, e.currentTarget));

  drawItems();
  drawWeek();
}

// ---------------- My requests ----------------

const FILTERS = [
  ['all', 'All', (r) => r.status !== 'cancelled'],
  ['active', 'Active', (r) => ['approved', 'issued'].includes(r.status)],
  ['pending', 'Pending', (r) => r.status.startsWith('pending')],
  ['draft', 'Drafts', (r) => r.status === 'draft'],
  ['rejected', 'Rejected', (r) => r.status === 'rejected'],
  ['returned', 'Returned', (r) => r.status === 'returned'],
];

export async function myRequests(view, ctx) {
  ctx.setTitle('My Requests');
  const f = FILTERS.find((x) => x[0] === ctx.query.get('f')) || FILTERS[0];
  const data = await api('/requests/mine');
  const list = data.requests.filter(f[2]);
  view.innerHTML = `
    ${statCards(data.counts)}
    <div class="card" style="margin-top:20px">
      <div class="card-head"><div class="pills">${FILTERS.map(
        ([k, label, fn]) => `<a class="pill ${k === f[0] ? 'active' : ''}" href="#/requests${k === 'all' ? '' : '?f=' + k}">${label} <span class="n">${data.requests.filter(fn).length}</span></a>`
      ).join('')}</div></div>
      <div id="table">${requestsTable(list)}</div>
    </div>
    <div id="alerts" class="alert-grid" style="margin-top:20px"></div>`;
  const reload = () => myRequests(view, ctx);
  bindRequestTable(view.querySelector('#table'), ctx, data.requests, reload);
  await mountAlerts(view.querySelector('#alerts'));
}

// ---------------- History ----------------

export async function history(view, ctx) {
  ctx.setTitle('History');
  const data = await api('/requests/mine');
  const past = data.requests.filter((r) => ['returned', 'rejected', 'cancelled'].includes(r.status));
  view.innerHTML = `<div class="card">
    <div class="card-head"><h3>Past requests</h3><span class="muted sm">${past.length} total</span></div>
    ${
      past.length
        ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Request</th><th>Equipment</th><th>Duration</th><th>Approved by</th><th>Closed</th><th>Status</th></tr></thead>
      <tbody>${past
        .map(
          (r) => `<tr class="clickable" data-href="/requests/${r.id}">
            <td class="strong">${esc(r.code)}</td><td>${esc(r.equipmentList.join(', '))}</td>
            <td class="nowrap">${fmtRange(r.fromAt, r.toAt)}</td>
            <td>${esc([r.l1?.by, r.l2?.by].filter(Boolean).join(' / ') || '—')}</td>
            <td class="nowrap">${fmtDateTime(r.returnedAt || r.l2?.at || r.l1?.at || r.cancelledAt)}</td>
            <td>${requestBadge(r)}</td></tr>`
        )
        .join('')}</tbody></table></div>`
        : emptyHtml('No history yet', 'Returned, rejected and cancelled requests appear here.')
    }</div>`;
  view.onclick = (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row) ctx.go(row.dataset.href);
  };
}

// ---------------- Request detail ----------------

function timeline(r, approvers) {
  const steps = [];
  const step = (cls, title, sub = '', remark = '') =>
    steps.push(`<div class="tl ${cls}"><div class="t">${title}</div>${sub ? `<div class="muted sm">${sub}</div>` : ''}${remark ? `<div class="remark">${esc(remark)}</div>` : ''}</div>`);

  step(r.submittedAt ? 'done' : 'current', r.submittedAt ? 'Request submitted' : 'Draft – not submitted', r.submittedAt ? fmtDateTime(r.submittedAt) : '');

  if (r.l1) step(r.l1.decision === 'accepted' ? 'done' : 'bad', `Level 1 ${r.l1.decision} by ${esc(r.l1.by)}`, fmtDateTime(r.l1.at), r.l1.remarks);
  else step(r.status === 'pending_l1' ? 'current' : '', 'Level 1 approval', r.status === 'pending_l1' ? `Awaiting ${esc(approvers.l1.join(' / '))}` : '');

  if (r.l2) step(r.l2.decision === 'accepted' ? 'done' : 'bad', `Level 2 ${r.l2.decision === 'accepted' ? 'approved' : 'rejected'} by ${esc(r.l2.by)}`, fmtDateTime(r.l2.at), r.l2.remarks || '');
  else step(r.status === 'pending_l2' ? 'current' : '', 'Level 2 approval', r.status === 'pending_l2' ? `Awaiting ${esc(approvers.l2.join(' / '))}` : r.status === 'pending_l1' ? 'Locked until Level 1 accepts' : '');

  if (r.issuedAt) step('done', `Issued by ${esc(r.issuedBy)}`, `${fmtDateTime(r.issuedAt)} · barcodes scanned`);
  else step(r.status === 'approved' ? 'current' : '', 'Collect & barcode issue', r.status === 'approved' ? `Ready – collect from the Media Lab from ${fmtDateTime(r.fromAt)}` : '');

  if (r.returnedAt) step(r.damageReported ? 'bad' : 'done', r.damageReported ? `Returned – damage reported` : `Return verified by ${esc(r.verifiedBy)}`, fmtDateTime(r.returnedAt), r.returnNotes || '');
  else step(r.status === 'issued' ? 'current' : '', 'Return & checklist', r.status === 'issued' ? `Return by ${fmtDateTime(r.toAt)} (${dueText(r.toAt)})` : '');

  if (r.status === 'cancelled') step('bad', 'Cancelled', fmtDateTime(r.cancelledAt));
  return steps.join('');
}

export async function requestDetail(view, ctx, params) {
  view.innerHTML = loadingHtml();
  const [{ request: r }, approvers] = await Promise.all([api(`/requests/${params.id}`), api('/approvers')]);
  ctx.setTitle(`Request ${r.code}`);
  const own = r.user.id === ctx.user.id;
  const isAdmin = ctx.user.role === 'admin';
  const back = isAdmin ? '#/admin/approvals' : '#/requests';

  const actions = [];
  if (own && r.status === 'draft') actions.push(`<a class="btn btn-primary" href="#/request/${r.id}/edit">Edit draft</a>`);
  if (own && ['pending_l1', 'pending_l2', 'approved'].includes(r.status)) actions.push('<button class="btn btn-ghost" data-cancel>Cancel request</button>');
  if (own && r.status === 'issued' && r.renewal?.status !== 'pending') actions.push('<button class="btn btn-primary" data-renew>Renew</button>');
  if (isAdmin && ['pending_l1', 'pending_l2'].includes(r.status)) actions.push(`<a class="btn btn-primary" href="#/admin/approvals/${r.id}">Open in approvals</a>`);
  if (isAdmin && r.status === 'approved') actions.push('<a class="btn btn-primary" href="#/admin/issue">Issue</a>');
  if (isAdmin && r.status === 'issued') actions.push(`<a class="btn btn-primary" href="#/admin/returns/${r.id}">Verify return</a>`);

  const u = r.user;
  view.innerHTML = `
    <div class="page-actions">
      <a href="${back}" class="btn btn-ghost btn-sm">← Back</a>
      <h2 class="spacer">${esc(r.code)} <span style="vertical-align:middle">${requestBadge(r)}</span></h2>
      ${actions.join('')}
    </div>
    <div class="req-layout">
      <div class="stack">
        <div class="card card-pad">
          <div class="eyebrow">Request details</div>
          <dl class="kv" style="margin-top:14px">
            <dt>Requested by</dt><dd><span class="strong">${esc(u.name)}</span> | ${esc(u.profession === 'faculty' ? 'Faculty' : 'Student')}${u.department ? ', ' + esc(u.department) : ''}${u.batch ? ', ' + esc(u.batch) : ''}
              ${isAdmin ? `<div class="muted sm">${esc(u.email)} · ${esc(u.phone)}</div>` : ''}</dd>
            <dt>Duration</dt><dd>${fmtRangeFull(r.fromAt, r.toAt)}${r.status === 'issued' ? `<div class="sm" style="color:${r.overdue ? 'var(--red)' : 'var(--muted)'}">${dueText(r.toAt)}</div>` : ''}</dd>
            <dt>Purpose</dt><dd>${esc(r.purpose) || '<span class="muted">—</span>'}</dd>
            <dt>Created</dt><dd>${fmtDateTime(r.createdAt)}</dd>
          </dl>
        </div>
        ${
          r.renewal
            ? `<div class="alert-card ${r.renewal.status === 'approved' ? 'success' : r.renewal.status === 'rejected' ? 'danger' : 'warn'}">
            <div class="eyebrow">Renewal ${esc(r.renewal.status)}</div>
            <h3>Extend until ${fmtDateTime(r.renewal.to)}</h3>
            <p class="sm">Reason: ${esc(r.renewal.reason)}${r.renewal.by ? ` · Reviewed by ${esc(r.renewal.by)}` : ''}${r.renewal.remarks ? ` – “${esc(r.renewal.remarks)}”` : ''}</p>
          </div>`
            : ''
        }
        <div class="card">
          <div class="card-head"><h3>Equipment</h3><span class="badge blue">${r.items.length} item${r.items.length === 1 ? '' : 's'}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Item</th><th>Category</th><th>Barcode</th>${r.returnedAt ? '<th>Return</th>' : ''}</tr></thead>
            <tbody>${r.items
              .map(
                (i) => `<tr><td class="strong">${esc(i.name)}</td><td>${esc(i.category)}</td>
                  <td class="mono">${i.barcode ? esc(i.barcode) : '<span class="muted">Assigned at issue</span>'}</td>
                  ${r.returnedAt ? `<td>${i.damaged ? badge('rejected', 'Damaged / missing') : badge('returned', 'OK')}</td>` : ''}</tr>`
              )
              .join('')}</tbody></table></div>
        </div>
        <div class="notice amber">Take equipment only after approval and handle with care – damage may result in a fine.</div>
      </div>
      <aside class="card card-pad">
        <h3 style="margin-bottom:18px">Approval &amp; status</h3>
        <div class="timeline">${timeline(r, approvers)}</div>
      </aside>
    </div>`;

  const reload = () => requestDetail(view, ctx, params);
  view.querySelector('[data-renew]')?.addEventListener('click', () => renewModal(r, reload));
  view.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    if (!(await confirmBox({ title: 'Cancel request?', message: `${esc(r.code)} will be withdrawn.`, confirmText: 'Cancel request', danger: true }))) return;
    try {
      await api(`/requests/${r.id}/cancel`, { body: {} });
      toast(`${esc(r.code)} cancelled`, 'success');
      reload();
    } catch (err) {
      toastError(err);
    }
  });
}
