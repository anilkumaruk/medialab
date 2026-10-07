import { api } from '../api.js';
import {
  CATEGORIES, esc, badge, requestBadge, logBadge, fmtRange, fmtRangeFull, fmtDateTime, fmtDate, dueText, toast, toastError,
  modal, confirmBox, withButton, showFieldError, toDateInput, debounce, loadingHtml, emptyHtml, ICONS,
} from '../ui.js';
import { code128Svg } from '../barcode.js';

const profLabel = (u) => (u.profession === 'faculty' ? 'Faculty' : 'Student');
const userLine = (u) => `${profLabel(u)}${u.department ? ', ' + esc(u.department) : ''}${u.batch ? ', ' + esc(u.batch) : ''}`;

function logsTable(logs, { showRequest = true } = {}) {
  if (!logs.length) return emptyHtml('No log entries', 'Try a wider date range or different filters.');
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Date</th><th>User</th>${showRequest ? '<th>Request</th>' : ''}<th>Equipment</th><th>Action</th><th>Approved by</th><th>Status</th></tr></thead>
    <tbody>${logs
      .map(
        (l) => `<tr>
          <td class="nowrap">${fmtDateTime(l.at)}</td>
          <td>${esc(l.user || l.actor || '—')}</td>
          ${showRequest ? `<td class="nowrap">${l.requestId ? `<a href="#/requests/${l.requestId}">${esc(l.requestCode)}</a>` : '—'}</td>` : ''}
          <td>${esc(l.equipment || '—')}</td>
          <td>${esc(l.action)}${l.details ? `<div class="muted xs">${esc(l.details)}</div>` : ''}</td>
          <td>${esc(l.approvedBy || '—')}</td>
          <td>${logBadge(l.status)}</td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

function miniRequests(list, emptyText) {
  if (!list.length) return `<div class="empty sm">${emptyText}</div>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Request</th><th>User</th><th>Equipment</th><th>Due</th></tr></thead>
    <tbody>${list
      .map(
        (r) => `<tr class="clickable" data-href="/admin/returns/${r.id}">
          <td class="strong">${esc(r.code)}</td><td>${esc(r.user.name)}<div class="muted xs">${esc(r.user.phone)}</div></td>
          <td>${esc(r.summary)}</td><td class="nowrap">${fmtDateTime(r.toAt)}<div class="xs" style="color:${r.overdue ? 'var(--red)' : 'var(--muted)'}">${dueText(r.toAt)}</div></td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

const rowNav = (root, ctx) => {
  root.onclick = (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a, button')) ctx.go(row.dataset.href);
  };
};

// ---------------- Dashboard ----------------

export async function dashboard(view, ctx) {
  ctx.setTitle('Dashboard');
  view.innerHTML = loadingHtml();
  const d = await api('/admin/dashboard');
  const c = d.counts;
  const lvl = ctx.user.approvalLevel;
  view.innerHTML = `
    ${lvl ? `<div class="notice blue" style="margin-bottom:20px">You are a Level ${lvl} approver. ${
      lvl === 1 ? `${c.pendingL1} request${c.pendingL1 === 1 ? '' : 's'} await your decision.` : `${c.pendingL2} request${c.pendingL2 === 1 ? '' : 's'} await final approval.`
    } <a href="#/admin/approvals">Open approvals →</a></div>` : ''}
    <div class="stats">
      <a class="stat c-amber" href="#/admin/approvals"><div class="label">Pending Level 1</div><div class="value">${c.pendingL1}</div></a>
      <a class="stat c-blue" href="#/admin/approvals?all=1"><div class="label">Pending Level 2</div><div class="value">${c.pendingL2}</div></a>
      <a class="stat c-teal" href="#/admin/issue"><div class="label">Ready to issue</div><div class="value">${c.toIssue}</div></a>
      <a class="stat c-navy" href="#/admin/returns"><div class="label">Currently issued</div><div class="value">${c.issued}</div></a>
      <a class="stat c-red" href="#/admin/returns"><div class="label">Overdue</div><div class="value">${c.overdue}</div></a>
    </div>
    <h3 class="section-title">Inventory</h3>
    <div class="stats">
      <a class="stat c-blue" href="#/admin/inventory"><div class="label">Total items</div><div class="value">${d.units.total}</div></a>
      <a class="stat c-teal" href="#/admin/inventory"><div class="label">Available</div><div class="value">${d.units.available}</div></a>
      <a class="stat c-amber" href="#/admin/inventory"><div class="label">In use</div><div class="value">${d.units.inUse}</div></a>
      <a class="stat c-red" href="#/admin/inventory"><div class="label">Maintenance</div><div class="value">${d.units.maintenance}</div></a>
    </div>
    <div class="grid-2" style="margin-top:24px;align-items:start">
      <div class="card"><div class="card-head"><h3>Overdue returns</h3>${c.overdue ? badge('overdue', `${c.overdue} overdue`) : ''}</div><div data-nav-table>${miniRequests(d.overdue, 'Nothing overdue.')}</div></div>
      <div class="card"><div class="card-head"><h3>Due in the next 24 hours</h3></div><div data-nav-table>${miniRequests(d.dueSoon, 'Nothing due in the next 24 hours.')}</div></div>
    </div>
    <div class="card" style="margin-top:20px">
      <div class="card-head"><h3>Recent activity</h3><a href="#/admin/logs">All logs →</a></div>
      ${logsTable(d.recent)}
    </div>`;
  view.querySelectorAll('[data-nav-table]').forEach((t) => rowNav(t, ctx));
}

// ---------------- Approvals ----------------

function levelBadge(r) {
  if (r.status === 'pending_l1') return '<span class="badge amber">Level 1</span>';
  if (r.status === 'pending_l2') return '<span class="badge blue">Level 2</span>';
  if (r.renewal?.status === 'pending') return '<span class="badge teal">Renewal</span>';
  return requestBadge(r);
}

function chainStep(level, names, state) {
  const [dot, text] = state;
  return `<div class="chain-step"><span class="dot ${dot}"></span><div><div class="strong sm">L${level} &nbsp;${esc(names || '—')}</div><div class="s" style="color:var(--${dot === 'gray' ? 'gray-500' : dot})">${esc(text)}</div></div></div>`;
}

export async function approvals(view, ctx, params) {
  ctx.setTitle('Accept / Reject');
  view.innerHTML = loadingHtml();
  const [data, approvers, eq] = await Promise.all([api('/admin/approvals'), api('/approvers'), api('/equipment')]);
  const avail = new Map(eq.equipment.map((e) => [e.id, e.available]));
  const lvl = ctx.user.approvalLevel;
  const showAll = ctx.query.get('all') === '1' || !lvl;
  const isMine = (r) => r.status === `pending_l${lvl}` || r.renewal?.status === 'pending';
  let list = data.requests.filter((r) => showAll || isMine(r));
  let selectedId = Number(params.id) || list[0]?.id || null;

  view.innerHTML = `<div class="split">
    <div class="card list-card">
      <div class="row" style="margin-bottom:14px">
        <div class="eyebrow spacer">Pending requests</div>
        ${lvl ? `<div class="pills"><a class="pill ${showAll ? '' : 'active'}" href="#/admin/approvals">My queue</a><a class="pill ${showAll ? 'active' : ''}" href="#/admin/approvals?all=1">All</a></div>` : ''}
      </div>
      ${lvl ? '' : '<div class="notice blue" style="margin-bottom:12px">You have no approval level, so you can view but not decide. A Level 2 admin can change this in Users.</div>'}
      <div id="list"></div>
    </div>
    <div class="card card-pad" id="detail"></div>
  </div>`;
  const listEl = view.querySelector('#list');
  const detail = view.querySelector('#detail');

  const drawList = () => {
    listEl.innerHTML = list.length
      ? list
          .map(
            (r) => `<button class="list-item ${r.id === selectedId ? 'active' : ''}" data-id="${r.id}">
              <div class="row"><div class="spacer"><div class="strong">${esc(r.user.name)}</div><div class="muted sm">${esc(r.summary)}</div><div class="muted xs">${fmtRange(r.fromAt, r.toAt)} · ${esc(r.code)}</div></div>${levelBadge(r)}</div>
            </button>`
          )
          .join('')
      : emptyHtml('All caught up', showAll ? 'No requests are waiting for approval.' : 'Nothing is waiting for you. Switch to “All” to see other levels.');
  };

  async function showDetail(id) {
    selectedId = id;
    drawList();
    if (!id) {
      detail.innerHTML = emptyHtml('No request selected', 'Choose a request from the list.');
      return;
    }
    history.replaceState(null, '', `#/admin/approvals/${id}${showAll && lvl ? '?all=1' : ''}`);
    detail.innerHTML = loadingHtml();
    let r;
    try {
      ({ request: r } = await api(`/requests/${id}`));
    } catch (err) {
      detail.innerHTML = emptyHtml('Could not load request', esc(err.message));
      return;
    }
    if (selectedId !== id) return;

    const canAct = (r.status === 'pending_l1' && lvl === 1) || (r.status === 'pending_l2' && lvl === 2);
    const l1State = r.l1 ? (r.l1.decision === 'accepted' ? ['green', `Accepted by ${r.l1.by}`] : ['red', `Rejected by ${r.l1.by}`]) : r.status === 'pending_l1' ? ['amber', 'Awaiting'] : ['gray', '—'];
    const l2State = r.l2
      ? r.l2.decision === 'accepted' ? ['green', `Approved by ${r.l2.by}`] : ['red', `Rejected by ${r.l2.by}`]
      : r.status === 'pending_l2' ? ['amber', 'Awaiting'] : r.status === 'pending_l1' ? ['gray', 'Locked'] : ['gray', '—'];

    const counts = new Map();
    r.items.forEach((i) => counts.set(i.equipmentId, (counts.get(i.equipmentId) || 0) + 1));
    const short = [...counts].filter(([id2, n]) => (avail.get(id2) ?? 0) < n).map(([id2]) => r.items.find((i) => i.equipmentId === id2).name);

    detail.innerHTML = `
      <div class="row"><div class="eyebrow spacer">Request details | ${esc(r.code)}</div>${requestBadge(r)}</div>
      <dl class="kv" style="margin:18px 0 22px">
        <dt>Requested by</dt><dd><span class="strong">${esc(r.user.name)}</span> | ${userLine(r.user)}<div class="muted sm">${esc(r.user.email)} · ${esc(r.user.phone)}</div></dd>
        <dt>Equipment</dt><dd>${esc(r.equipmentList.join(', '))}${short.length && ['pending_l1', 'pending_l2'].includes(r.status) ? `<div class="sm" style="color:var(--amber);margin-top:4px">⚠ Not enough stock right now: ${esc(short.join(', '))}</div>` : ''}</dd>
        <dt>Duration</dt><dd>${fmtRangeFull(r.fromAt, r.toAt)}</dd>
        <dt>Purpose</dt><dd>${esc(r.purpose)}</dd>
        <dt>Submitted</dt><dd>${fmtDateTime(r.submittedAt)}</dd>
      </dl>
      <div class="label" style="margin-bottom:8px">Approval chain</div>
      <div class="chain">${chainStep(1, approvers.l1.join(' / '), l1State)}${chainStep(2, approvers.l2.join(' / '), l2State)}</div>
      ${r.l1?.remarks ? `<div class="remark"><span class="strong">L1 remarks (${esc(r.l1.by)}):</span> ${esc(r.l1.remarks)}</div>` : ''}
      ${r.l2?.remarks ? `<div class="remark"><span class="strong">L2 remarks (${esc(r.l2.by)}):</span> ${esc(r.l2.remarks)}</div>` : ''}
      ${
        r.renewal?.status === 'pending'
          ? `<div class="alert-card warn" style="margin-top:20px">
          <div class="eyebrow">Renewal requested</div>
          <h3>Extend until ${fmtDateTime(r.renewal.to)}</h3>
          <p class="sm">Currently due ${fmtDateTime(r.toAt)}. Reason: ${esc(r.renewal.reason)}</p>
          <textarea class="input" id="renew-remarks" placeholder="Remarks (optional)" style="margin-top:12px;min-height:60px"></textarea>
          <div class="row"><button class="btn btn-danger btn-sm" data-renewal="reject">Reject renewal</button><button class="btn btn-success btn-sm" data-renewal="accept">Approve renewal</button></div>
        </div>`
          : ''
      }
      ${
        canAct
          ? `<form id="decide" novalidate>
          <div class="field" style="margin-top:22px"><label for="remarks">${lvl === 1 ? 'Remarks * (compulsory at Level 1)' : 'Remarks (optional at Level 2)'}</label>
            <textarea class="input" id="remarks" name="remarks" maxlength="500" placeholder="${lvl === 1 ? 'e.g. Approved. Return the kit by Wednesday evening.' : 'Optional note for the requester'}"></textarea>
            <div class="field-error"></div></div>
          <div class="grid-2" style="margin-top:16px">
            <button type="button" class="btn btn-danger btn-lg" data-decide="reject">Reject</button>
            <button type="button" class="btn btn-success btn-lg" data-decide="accept">${lvl === 2 ? 'Accept (final)' : 'Accept'}</button>
          </div></form>`
          : ['pending_l1', 'pending_l2'].includes(r.status)
            ? `<div class="notice blue" style="margin-top:20px">Waiting for the Level ${r.status === 'pending_l1' ? '1' : '2'} approver (${esc((r.status === 'pending_l1' ? approvers.l1 : approvers.l2).join(' / '))}).</div>`
            : ''
      }`;

    const after = (msg) => {
      toast(msg, 'success');
      ctx.refresh();
      data.requests = data.requests.filter((x) => x.id !== r.id);
      return api('/admin/approvals').then((fresh) => {
        data.requests = fresh.requests;
        list = data.requests.filter((x) => showAll || isMine(x));
        showDetail(list[0]?.id || null);
      });
    };

    detail.querySelectorAll('[data-decide]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const form = detail.querySelector('#decide');
        const remarks = form.remarks.value.trim();
        const decision = btn.dataset.decide;
        if (lvl === 1 && remarks.length < 2) return showFieldError(form, 'remarks', 'Remarks are compulsory at Level 1');
        if (decision === 'reject' && !(await confirmBox({ title: `Reject ${esc(r.code)}?`, message: `${esc(r.user.name)} will be notified by email.`, confirmText: 'Reject', danger: true }))) return;
        await withButton(btn, async () => {
          try {
            await api(`/admin/requests/${r.id}/decision`, { body: { decision, remarks } });
            await after(decision === 'accept' ? (lvl === 1 ? `${esc(r.code)} accepted – sent to Level 2` : `${esc(r.code)} approved – ready to issue`) : `${esc(r.code)} rejected`);
          } catch (err) {
            showFieldError(form, err.data?.field, err.message);
            toastError(err);
          }
        });
      })
    );
    detail.querySelectorAll('[data-renewal]').forEach((btn) =>
      btn.addEventListener('click', () =>
        withButton(btn, async () => {
          try {
            await api(`/admin/requests/${r.id}/renewal`, { body: { decision: btn.dataset.renewal, remarks: detail.querySelector('#renew-remarks').value } });
            await after(`Renewal ${btn.dataset.renewal === 'accept' ? 'approved' : 'rejected'}`);
          } catch (err) {
            toastError(err);
          }
        })
      )
    );
  }

  listEl.onclick = (e) => {
    const item = e.target.closest('[data-id]');
    if (item) showDetail(Number(item.dataset.id));
  };
  await showDetail(selectedId);
}

// ---------------- Issue (barcode scan) ----------------

export async function issue(view, ctx) {
  ctx.setTitle('Issue Equipment');
  view.innerHTML = loadingHtml();
  const data = await api('/admin/issue-queue');
  if (!data.requests.length) {
    view.innerHTML = `<div class="card">${emptyHtml('Nothing to issue', 'Requests appear here once both Level 1 and Level 2 have approved them.')}</div>`;
    return;
  }
  view.innerHTML = `<p class="muted" style="margin-bottom:16px">Scan each item's barcode label (USB/handheld scanners type the code and press Enter), or click a suggested code.</p>
    ${data.requests
      .map(
        (r) => `<div class="card" style="margin-bottom:18px" data-req="${r.id}">
        <div class="card-head">
          <div class="spacer"><h3>${esc(r.code)} · ${esc(r.user.name)}</h3>
            <div class="muted sm">${userLine(r.user)} · ${esc(r.user.phone)} · ${fmtRangeFull(r.fromAt, r.toAt)}</div>
            <div class="muted xs">Approved by ${esc([r.l1?.by, r.l2?.by].filter(Boolean).join(' / '))} · Purpose: ${esc(r.purpose)}</div></div>
          ${new Date(r.fromAt) > Date.now() ? `<span class="badge blue">Pickup ${fmtDateTime(r.fromAt)}</span>` : '<span class="badge teal">Ready</span>'}
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Item</th><th style="width:240px">Scan barcode</th><th>Available units</th></tr></thead>
          <tbody>${r.items
            .map((it) => {
              const units = data.availableUnits[it.equipmentId] || [];
              return `<tr>
                <td><div class="strong">${esc(it.name)}</div><div class="muted xs">${esc(it.code)}</div></td>
                <td><input class="input mono" data-item="${it.id}" placeholder="${esc(it.code)}-.." autocomplete="off" spellcheck="false"></td>
                <td><div class="unit-chips">${units.length ? units.slice(0, 10).map((b) => `<button type="button" class="chip" data-fill="${esc(b)}">${esc(b)}</button>`).join('') : badge('rejected', 'None on shelf')}</div></td>
              </tr>`;
            })
            .join('')}</tbody></table></div>
        <div class="row wrap" style="padding:16px 20px">
          <button class="btn btn-ghost" data-cancel="${r.id}">Cancel – not collected</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" data-issue="${r.id}">Issue ${r.items.length} item${r.items.length === 1 ? '' : 's'}</button>
        </div>
      </div>`
      )
      .join('')}`;

  view.querySelector('[data-item]')?.focus();

  view.onclick = async (e) => {
    const chip = e.target.closest('[data-fill]');
    if (chip) {
      const input = chip.closest('tr').querySelector('[data-item]');
      const card = chip.closest('[data-req]');
      const taken = [...card.querySelectorAll('[data-item]')].filter((i) => i !== input).map((i) => i.value.trim().toUpperCase());
      if (taken.includes(chip.dataset.fill)) return toast('That unit is already assigned to another row', 'error');
      input.value = chip.dataset.fill;
      return;
    }
    const issueBtn = e.target.closest('[data-issue]');
    if (issueBtn) {
      const card = issueBtn.closest('[data-req]');
      const assignments = [...card.querySelectorAll('[data-item]')].map((i) => ({ itemId: Number(i.dataset.item), barcode: i.value.trim() }));
      const missing = card.querySelector('[data-item]:placeholder-shown');
      if (assignments.some((a) => !a.barcode)) {
        missing?.focus();
        return toast('Scan a barcode for every item', 'error');
      }
      await withButton(issueBtn, async () => {
        try {
          const { request } = await api(`/admin/requests/${issueBtn.dataset.issue}/issue`, { body: { assignments } });
          toast(`${esc(request.code)} issued to ${esc(request.user.name)}`, 'success');
          ctx.refresh();
          issue(view, ctx);
        } catch (err) {
          const bad = err.data?.itemId && card.querySelector(`[data-item="${err.data.itemId}"]`);
          if (bad) {
            bad.focus();
            bad.select();
          }
          toastError(err);
        }
      });
    }
    const cancelBtn = e.target.closest('[data-cancel]');
    if (cancelBtn) adminCancel(Number(cancelBtn.dataset.cancel), () => issue(view, ctx));
  };
  view.onkeydown = (e) => {
    if (e.key !== 'Enter' || !e.target.matches('[data-item]')) return;
    e.preventDefault();
    const inputs = [...e.target.closest('[data-req]').querySelectorAll('[data-item]')];
    const next = inputs[inputs.indexOf(e.target) + 1];
    if (next) next.focus();
    else e.target.closest('[data-req]').querySelector('[data-issue]').focus();
  };
}

function adminCancel(id, onDone) {
  const m = modal({
    title: 'Cancel request',
    body: `<div class="field"><label>Reason (sent to the requester)</label><textarea class="input" name="remarks" placeholder="e.g. Not collected within the pickup window"></textarea><div class="field-error"></div></div>`,
    footer: '<button class="btn btn-ghost" data-close>Back</button><button class="btn btn-danger" data-ok>Cancel request</button>',
  });
  m.el.querySelector('[data-ok]').addEventListener('click', (e) =>
    withButton(e.currentTarget, async () => {
      try {
        await api(`/admin/requests/${id}/cancel`, { body: { remarks: m.el.querySelector('[name=remarks]').value } });
        m.close();
        toast('Request cancelled', 'success');
        onDone();
      } catch (err) {
        showFieldError(m.el, err.data?.field, err.message);
        toastError(err);
      }
    })
  );
}

// ---------------- Returns (checklist) ----------------

export async function returns(view, ctx, params) {
  ctx.setTitle('Returns');
  view.innerHTML = loadingHtml();
  const data = await api('/admin/returns');
  const list = data.requests;
  let selected = list.find((r) => r.id === Number(params.id)) || list[0] || null;

  view.innerHTML = `<div class="split">
    <div class="card list-card">
      <div class="search" style="margin-bottom:14px">${ICONS.search}<input class="input" id="scan" placeholder="Scan a barcode to find its request" autocomplete="off" spellcheck="false"></div>
      <div class="eyebrow" style="margin-bottom:10px">Currently issued (${list.length})</div>
      <div id="list"></div>
    </div>
    <div class="card card-pad" id="detail"></div>
  </div>`;
  const listEl = view.querySelector('#list');
  const detail = view.querySelector('#detail');

  const drawList = () => {
    listEl.innerHTML = list.length
      ? list
          .map(
            (r) => `<button class="list-item ${r.id === selected?.id ? 'active' : ''}" data-id="${r.id}">
              <div class="row"><div class="spacer"><div class="strong">${esc(r.user.name)}</div><div class="muted sm">${esc(r.summary)}</div>
              <div class="xs" style="color:${r.overdue ? 'var(--red)' : 'var(--muted)'}">${esc(r.code)} · ${dueText(r.toAt)}</div></div>${r.overdue ? badge('overdue') : badge('issued')}</div>
            </button>`
          )
          .join('')
      : emptyHtml('Nothing out right now', 'Issued equipment will appear here until its return is verified.');
  };

  const drawDetail = () => {
    drawList();
    if (!selected) {
      detail.innerHTML = emptyHtml('No return selected', 'Pick a request or scan a returned item.');
      return;
    }
    const r = selected;
    history.replaceState(null, '', `#/admin/returns/${r.id}`);
    detail.innerHTML = `
      <div class="eyebrow">Return checklist | ${esc(r.code)}</div>
      <h3 style="font-size:18px;margin:6px 0 2px">${esc(r.user.name)} &nbsp;|&nbsp; ${esc(r.summary)}</h3>
      <div class="sm" style="color:${r.overdue ? 'var(--red)' : 'var(--muted)'};margin-bottom:18px">Due ${fmtDateTime(r.toAt)} · ${dueText(r.toAt)} · ${esc(r.user.phone)}</div>
      <div id="checks">
        ${r.items
          .map(
            (it) => `<label class="check-item" data-barcode="${esc(it.barcode || '')}"><input type="checkbox" data-ok="${it.id}"><span class="box"></span>
              <span class="spacer">${esc(it.name)}${it.category === 'Cameras' ? ' – body has no damage' : ' returned'}</span><span class="mono muted">${esc(it.barcode || '')}</span></label>`
          )
          .join('')}
        <label class="check-item"><input type="checkbox" data-extras><span class="box"></span><span>Lens caps, straps and cables present</span></label>
      </div>
      <form id="ret" novalidate>
        <div class="field" style="margin-top:18px"><label for="notes">Condition notes</label>
          <textarea class="input" id="notes" name="notes" maxlength="1000" placeholder="Optional notes on damage or missing items" style="min-height:70px"></textarea><div class="field-error"></div></div>
      </form>
      <div class="grid-2" style="margin-top:16px">
        <button class="btn btn-danger btn-lg" data-damage>Report Damage</button>
        <button class="btn btn-success btn-lg" data-confirm>OK - Confirm Return</button>
      </div>`;
  };

  const tick = (barcode) => {
    const el = detail.querySelector(`.check-item[data-barcode="${CSS.escape(barcode)}"]`);
    if (!el) return false;
    el.querySelector('input').checked = true;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    return true;
  };

  async function submit(damage, btn) {
    const r = selected;
    const okItemIds = [...detail.querySelectorAll('[data-ok]:checked')].map((i) => Number(i.dataset.ok));
    const extrasOk = detail.querySelector('[data-extras]').checked;
    const form = detail.querySelector('#ret');
    const notes = form.notes.value.trim();
    if (!damage && (okItemIds.length < r.items.length || !extrasOk)) {
      return toast('Tick every checklist item to confirm. Use Report Damage for damaged or missing items.', 'error');
    }
    if (damage) {
      if (notes.length < 3) return showFieldError(form, 'notes', 'Describe the damage or missing items');
      const bad = r.items.filter((i) => !okItemIds.includes(i.id));
      const msg = bad.length
        ? `These unticked items will be marked damaged/missing and moved to maintenance:<br><strong>${bad.map((i) => `${esc(i.name)} (${esc(i.barcode)})`).join('<br>')}</strong>`
        : 'All items are ticked, so they return to stock. The damage note will be recorded against this request.';
      if (!(await confirmBox({ title: 'Report damage?', message: msg, confirmText: 'Record return with damage', danger: true }))) return;
    }
    await withButton(btn, async () => {
      try {
        await api(`/admin/requests/${r.id}/return`, { body: { okItemIds, extrasOk, notes, damage } });
        toast(damage ? `${esc(r.code)} returned – damage recorded` : `${esc(r.code)} return verified`, 'success');
        ctx.refresh();
        returns(view, ctx, {});
      } catch (err) {
        showFieldError(form, err.data?.field, err.message);
        toastError(err);
      }
    });
  }

  listEl.onclick = (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    selected = list.find((r) => r.id === Number(item.dataset.id));
    drawDetail();
  };
  detail.onclick = (e) => {
    const d = e.target.closest('[data-damage]');
    const c = e.target.closest('[data-confirm]');
    if (d) submit(true, d);
    if (c) submit(false, c);
  };
  view.querySelector('#scan').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = e.target.value.trim().toUpperCase();
    e.target.value = '';
    if (!code) return;
    if (selected && tick(code)) return;
    const owner = list.find((r) => r.items.some((i) => (i.barcode || '').toUpperCase() === code));
    if (!owner) return toast(`${esc(code)} is not part of any issued request`, 'error');
    selected = owner;
    drawDetail();
    tick(code);
  });

  drawDetail();
  view.querySelector('#scan').focus();
}

// ---------------- Inventory ----------------

function inventoryStatus(e) {
  if (!e.active) return badge('retired', 'Hidden');
  if (e.onShelf > 0) return badge('available');
  if (e.inUse > 0) return badge('in_use');
  if (e.maintenance > 0) return badge('maintenance');
  return badge('retired', 'No units');
}

function equipmentForm(e, all) {
  const accessories = all.filter((a) => a.isAccessory && a.id !== e?.id);
  const linked = new Set(e?.accessoryIds || []);
  return `<form id="eq-form" class="form-grid" novalidate>
    <div class="span-3 field"><label>Name *</label><input class="input" name="name" value="${esc(e?.name || '')}" maxlength="80" placeholder="Canon EOS R6"><div class="field-error"></div></div>
    <div class="span-3 field"><label>Model code ${e ? '' : '*'}</label><input class="input mono" name="code" value="${esc(e?.code || '')}" ${e ? 'disabled' : ''} placeholder="CAM-014" maxlength="20"><div class="field-error"></div>
      ${e ? '' : '<div class="help">Unit barcodes become CODE-01, CODE-02 …</div>'}</div>
    <div class="span-2 field"><label>Category *</label><select class="input" name="category">${CATEGORIES.map((c) => `<option ${c === e?.category ? 'selected' : ''}>${c}</option>`).join('')}</select><div class="field-error"></div></div>
    <div class="span-2 field"><label>Type</label><input class="input" name="subtype" value="${esc(e?.subtype || '')}" placeholder="Mirrorless" maxlength="60"></div>
    ${e ? `<div class="span-2 field"><label>Visibility</label><select class="input" name="active"><option value="1" ${e.active ? 'selected' : ''}>Shown to users</option><option value="0" ${e.active ? '' : 'selected'}>Hidden</option></select></div>`
        : `<div class="span-2 field"><label>Quantity *</label><input class="input" type="number" name="quantity" min="0" max="200" value="1"><div class="field-error"></div></div>`}
    <div class="span-6 field"><label>Description</label><input class="input" name="description" value="${esc(e?.description || '')}" maxlength="500" placeholder="Optional notes shown to admins"></div>
    <div class="span-6"><label class="check"><input type="checkbox" name="isAccessory" ${e?.isAccessory ? 'checked' : ''}> <span>This is an accessory (battery, charger, memory card …)</span></label></div>
    ${accessories.length ? `<div class="span-6 field"><span class="label">Prompt these accessories when this item is selected</span>
      <div class="grid-2" style="gap:8px;max-height:180px;overflow:auto;padding:4px">${accessories
        .map((a) => `<label class="check sm"><input type="checkbox" name="acc" value="${a.id}" ${linked.has(a.id) ? 'checked' : ''}> <span>${esc(a.name)} <span class="muted mono">${esc(a.code)}</span></span></label>`)
        .join('')}</div></div>` : ''}
  </form>`;
}

function readEquipmentForm(form) {
  const f = form.elements;
  return {
    name: f.name.value,
    category: f.category.value,
    subtype: f.subtype.value,
    description: f.description.value,
    isAccessory: f.isAccessory.checked,
    accessoryIds: [...form.querySelectorAll('[name=acc]:checked')].map((i) => Number(i.value)),
    ...(f.code && !f.code.disabled ? { code: f.code.value } : {}),
    ...(f.quantity ? { quantity: Number(f.quantity.value) } : {}),
    ...(f.active ? { active: f.active.value === '1' } : {}),
  };
}

export async function inventory(view, ctx) {
  ctx.setTitle('Inventory List');
  view.innerHTML = loadingHtml();
  let all = (await api('/admin/inventory')).equipment;
  let cat = '';
  let q = '';

  view.innerHTML = `
    <div class="stats" id="stats"></div>
    <div class="toolbar" style="margin-top:20px">
      <button class="btn btn-teal" id="add">+ Add Equipment</button>
      <div class="search" style="width:230px">${ICONS.search}<input class="input" id="scan" placeholder="Scan Barcode" autocomplete="off" spellcheck="false"></div>
      <select class="input" id="cat" style="width:170px"><option value="">All categories</option>${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
      <div class="search spacer" style="min-width:200px">${ICONS.search}<input class="input" id="q" placeholder="Search name or code"></div>
    </div>
    <div class="card"><div id="table"></div></div>`;

  const draw = () => {
    const items = all.filter((e) => (!cat || e.category === cat) && (!q || `${e.name} ${e.code} ${e.subtype}`.toLowerCase().includes(q)));
    const sum = (k) => items.reduce((n, e) => n + e[k], 0);
    view.querySelector('#stats').innerHTML = `
      <div class="stat c-blue"><div class="label">Total items</div><div class="value">${sum('total')}</div></div>
      <div class="stat c-teal"><div class="label">Available</div><div class="value">${sum('onShelf')}</div></div>
      <div class="stat c-amber"><div class="label">In use</div><div class="value">${sum('inUse')}</div></div>
      <div class="stat c-red"><div class="label">Maintenance</div><div class="value">${sum('maintenance')}</div></div>`;
    view.querySelector('#table').innerHTML = items.length
      ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Item</th><th>Code</th><th>Category</th><th>Status</th><th>Qty</th><th></th></tr></thead>
        <tbody>${items
          .map(
            (e) => `<tr class="clickable" data-id="${e.id}">
              <td><div class="strong">${esc(e.name)}</div><div class="muted xs">${esc(e.subtype)}${e.isAccessory ? ' · accessory' : ''}${e.accessoryIds.length ? ` · prompts ${e.accessoryIds.length} accessories` : ''}</div></td>
              <td class="mono">${esc(e.code)}</td><td>${esc(e.category)}</td><td>${inventoryStatus(e)}</td>
              <td class="strong nowrap">${e.onShelf}/${e.total}${e.reserved ? `<div class="muted xs">${e.reserved} reserved</div>` : ''}</td>
              <td class="actions"><button class="link-btn" data-manage="${e.id}">Manage</button><a href="#/admin/labels/${e.id}">Labels</a></td>
            </tr>`
          )
          .join('')}</tbody></table></div>`
      : emptyHtml('No equipment found', 'Try another search or add equipment.');
  };
  const reload = async () => {
    all = (await api('/admin/inventory')).equipment;
    draw();
  };

  view.querySelector('#cat').addEventListener('change', (e) => {
    cat = e.target.value;
    draw();
  });
  view.querySelector('#q').addEventListener('input', debounce((e) => {
    q = e.target.value.trim().toLowerCase();
    draw();
  }, 150));
  view.querySelector('#table').onclick = (e) => {
    if (e.target.closest('a')) return;
    const row = e.target.closest('[data-id]');
    if (row) manageModal(all.find((x) => x.id === Number(row.dataset.id)), all, reload);
  };
  view.querySelector('#add').addEventListener('click', () => {
    const m = modal({
      title: 'Add equipment',
      wide: true,
      body: equipmentForm(null, all),
      footer: '<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-save>Add equipment</button>',
    });
    m.el.querySelector('[data-save]').addEventListener('click', (e) =>
      withButton(e.currentTarget, async () => {
        const form = m.el.querySelector('#eq-form');
        try {
          const { equipment } = await api('/admin/equipment', { body: readEquipmentForm(form) });
          m.close();
          toast(`${esc(equipment.name)} added with ${equipment.units.length} units`, 'success');
          await reload();
        } catch (err) {
          showFieldError(form, err.data?.field, err.message);
          toastError(err);
        }
      })
    );
  });
  view.querySelector('#scan').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = e.target.value.trim();
    e.target.value = '';
    if (code) unitLookup(code, reload);
  });

  draw();
}

async function unitLookup(code, onChange) {
  let data;
  try {
    data = await api(`/admin/units/lookup?barcode=${encodeURIComponent(code)}`);
  } catch (err) {
    return toastError(err);
  }
  const { unit, equipment: e, request: r } = data;
  const m = modal({
    title: unit.barcode,
    body: `<div class="label-card" style="border-style:solid;margin-bottom:16px">${code128Svg(unit.barcode)}<div class="c">${esc(unit.barcode)}</div></div>
      <dl class="kv">
        <dt>Equipment</dt><dd class="strong">${esc(e.name)} <span class="muted mono">${esc(e.code)}</span></dd>
        <dt>Status</dt><dd>${badge(unit.status)}</dd>
        ${unit.notes ? `<dt>Notes</dt><dd>${esc(unit.notes)}</dd>` : ''}
        ${r ? `<dt>With</dt><dd><span class="strong">${esc(r.user.name)}</span> · ${esc(r.user.phone)}<div class="sm"><a href="#/requests/${r.id}" data-close>${esc(r.code)}</a> · ${dueText(r.toAt)}</div></dd>` : ''}
      </dl>`,
    footer: r
      ? `<button class="btn btn-ghost" data-close>Close</button><a class="btn btn-primary" href="#/admin/returns/${r.id}" data-close>Verify return</a>`
      : `<button class="btn btn-ghost" data-close>Close</button>${unit.status !== 'available' ? '<button class="btn btn-success" data-set="available">Mark available</button>' : '<button class="btn btn-danger" data-set="maintenance">Send to maintenance</button>'}`,
  });
  m.el.querySelector('[data-set]')?.addEventListener('click', (ev) =>
    withButton(ev.currentTarget, async () => {
      try {
        await api(`/admin/units/${unit.id}`, { method: 'PATCH', body: { status: ev.currentTarget.dataset.set } });
        m.close();
        toast(`${esc(unit.barcode)} updated`, 'success');
        onChange();
      } catch (err) {
        toastError(err);
      }
    })
  );
}

function manageModal(e, all, onChange) {
  const unitRows = (units) =>
    units
      .map(
        (u) => `<tr data-unit="${u.id}">
          <td class="mono strong">${esc(u.barcode)}</td>
          <td>${u.status === 'in_use' ? badge('in_use') : `<select class="input" data-status style="height:34px;width:150px">${['available', 'maintenance', 'retired'].map((s) => `<option value="${s}" ${s === u.status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>`}</td>
          <td><input class="input" data-notes value="${esc(u.notes)}" placeholder="Notes" style="height:34px" maxlength="500"></td>
          <td><button class="btn btn-ghost btn-sm" data-save-unit>Save</button></td>
        </tr>`
      )
      .join('');
  const m = modal({
    title: e.name,
    wide: true,
    body: `${equipmentForm(e, all)}
      <div class="row" style="margin:24px 0 10px"><h3 class="spacer">Units (${e.units.length})</h3><a class="btn btn-ghost btn-sm" href="#/admin/labels/${e.id}" data-close>Print labels</a></div>
      <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Barcode</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody id="units">${unitRows(e.units)}</tbody></table></div></div>
      <div class="row" style="margin-top:12px"><input class="input" type="number" id="add-n" min="1" max="100" value="1" style="width:90px"><button class="btn btn-secondary btn-sm" id="add-units">Add units</button></div>`,
    footer: '<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-save>Save details</button>',
  });
  m.el.querySelector('[data-save]').addEventListener('click', (ev) =>
    withButton(ev.currentTarget, async () => {
      const form = m.el.querySelector('#eq-form');
      try {
        await api(`/admin/equipment/${e.id}`, { method: 'PATCH', body: readEquipmentForm(form) });
        m.close();
        toast('Saved', 'success');
        onChange();
      } catch (err) {
        showFieldError(form, err.data?.field, err.message);
        toastError(err);
      }
    })
  );
  m.el.querySelector('#units').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-save-unit]');
    if (!btn) return;
    const row = btn.closest('[data-unit]');
    const status = row.querySelector('[data-status]')?.value;
    withButton(btn, async () => {
      try {
        await api(`/admin/units/${row.dataset.unit}`, { method: 'PATCH', body: { ...(status ? { status } : {}), notes: row.querySelector('[data-notes]').value } });
        toast('Unit updated', 'success');
        onChange();
      } catch (err) {
        toastError(err);
      }
    });
  });
  m.el.querySelector('#add-units').addEventListener('click', (ev) =>
    withButton(ev.currentTarget, async () => {
      try {
        const { equipment, created } = await api(`/admin/equipment/${e.id}/units`, { body: { count: Number(m.el.querySelector('#add-n').value) } });
        m.el.querySelector('#units').innerHTML = unitRows(equipment.units);
        toast(`Added ${created.join(', ')}`, 'success');
        onChange();
      } catch (err) {
        toastError(err);
      }
    })
  );
}

// ---------------- Barcode labels ----------------

export async function labels(view, ctx, params) {
  const { equipment: e } = await api(`/admin/inventory/${params.id}`);
  ctx.setTitle(`Labels · ${e.name}`);
  const units = e.units.filter((u) => u.status !== 'retired');
  view.innerHTML = `
    <div class="page-actions no-print">
      <a class="btn btn-ghost btn-sm" href="#/admin/inventory">← Inventory</a>
      <span class="spacer muted">${units.length} labels · Code 128 · print on sticker sheets and attach to each item</span>
      <button class="btn btn-primary" id="print">Print labels</button>
    </div>
    <div class="labels">${units
      .map((u) => `<div class="label-card"><div class="n">${esc(e.name)}</div>${code128Svg(u.barcode)}<div class="c">${esc(u.barcode)}</div><div class="xs muted">MediaLab · Handle with care</div></div>`)
      .join('')}</div>`;
  view.querySelector('#print').addEventListener('click', () => window.print());
}

// ---------------- Logs ----------------

const LIFECYCLE = [
  ['Request', 'var(--blue)'], ['Approve L1', 'var(--teal)'], ['Approve L2', 'var(--amber)'], ['Barcode Issue', 'var(--red)'],
  ['Alert', 'var(--gray-500)'], ['Verify Return', 'var(--green)'], ['Log', 'var(--navy)'],
];

export async function logs(view, ctx) {
  ctx.setTitle('Logs');
  view.innerHTML = loadingHtml();
  const { users } = await api('/admin/users');
  const people = users.filter((u) => u.role === 'user');
  const today = new Date();
  const monthAgo = new Date(Date.now() - 30 * 864e5);

  view.innerHTML = `
    <div class="card card-pad no-print">
      <div class="eyebrow" style="margin-bottom:12px">Filter by</div>
      <form class="filters" id="filters">
        <div class="field"><label>Type</label><select class="input" name="type"><option value="">All activity</option><option value="student">By student</option><option value="staff">By staff</option></select></div>
        <div class="field"><label>Student / Staff</label><select class="input" name="userId"></select></div>
        <div class="field"><label>From</label><input class="input" type="date" name="from" value="${toDateInput(monthAgo)}"></div>
        <div class="field"><label>To</label><input class="input" type="date" name="to" value="${toDateInput(today)}"></div>
        <div class="field"><label>Search</label><input class="input" name="q" placeholder="Equipment, action, REQ-…"></div>
        <button class="btn btn-primary" type="submit">Generate</button>
        <button class="btn btn-secondary" type="button" id="csv">Export CSV</button>
        <button class="btn btn-secondary" type="button" id="pdf">Export PDF</button>
      </form>
    </div>
    <div class="print-only" id="print-head" style="margin-bottom:16px"></div>
    <div class="card" style="margin-top:20px"><div class="card-head"><h3>Log entries</h3><span class="muted sm" id="count"></span></div><div id="table">${loadingHtml()}</div></div>
    <div class="card card-pad no-print" style="margin-top:20px">
      <div class="eyebrow" style="margin-bottom:12px">Lifecycle</div>
      <div class="lifecycle">${LIFECYCLE.map(([l, c], i) => `<span class="step" style="--c:${c}"><span class="num">${i + 1}</span>${l}</span>${i < LIFECYCLE.length - 1 ? '<span class="arrow">›</span>' : ''}`).join('')}</div>
    </div>`;

  const form = view.querySelector('#filters');
  const fillUsers = () => {
    const type = form.type.value;
    const list = people.filter((u) => !type || (type === 'student' ? u.profession === 'student' : u.profession !== 'student'));
    const current = form.userId.value;
    form.userId.innerHTML = `<option value="">Everyone</option>${list.map((u) => `<option value="${u.id}">${esc(u.name)} · ${esc(u.email)}</option>`).join('')}`;
    if (list.some((u) => String(u.id) === current)) form.userId.value = current;
  };
  const params = () => {
    const p = new URLSearchParams();
    const f = form.elements;
    if (f.type.value) p.set('type', f.type.value);
    if (f.userId.value) p.set('userId', f.userId.value);
    if (f.from.value) p.set('from', new Date(f.from.value + 'T00:00:00').toISOString());
    if (f.to.value) p.set('to', new Date(f.to.value + 'T23:59:59.999').toISOString());
    if (f.q.value.trim()) p.set('q', f.q.value.trim());
    return p;
  };
  const generate = async () => {
    view.querySelector('#table').innerHTML = loadingHtml();
    const { logs: rows } = await api(`/admin/logs?${params()}`);
    view.querySelector('#table').innerHTML = logsTable(rows);
    view.querySelector('#count').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
    const f = form.elements;
    view.querySelector('#print-head').innerHTML = `<h2>MediaLab – Equipment logs</h2><p class="muted">${
      f.userId.value ? esc(f.userId.selectedOptions[0].textContent) : f.type.value ? `All ${f.type.value === 'student' ? 'students' : 'staff'}` : 'All activity'
    } · ${f.from.value ? fmtDate(f.from.value + 'T00:00') : 'start'} to ${f.to.value ? fmtDate(f.to.value + 'T00:00') : 'today'} · generated ${fmtDateTime(new Date().toISOString())} by ${esc(ctx.user.name)}</p>`;
  };

  form.type.addEventListener('change', fillUsers);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    generate().catch(toastError);
  });
  view.querySelector('#csv').addEventListener('click', () => {
    const p = params();
    p.set('format', 'csv');
    window.location.href = `/api/admin/logs?${p}`;
  });
  view.querySelector('#pdf').addEventListener('click', () => window.print());
  fillUsers();
  await generate();
}

// ---------------- Users ----------------

const ACCESS = [
  ['user', 'Student / Staff'],
  ['admin', 'Admin (no approval)'],
  ['l1', 'Admin – Level 1'],
  ['l2', 'Admin – Level 2'],
];
const accessOf = (u) => (u.role !== 'admin' ? 'user' : u.approvalLevel === 1 ? 'l1' : u.approvalLevel === 2 ? 'l2' : 'admin');

export async function users(view, ctx) {
  ctx.setTitle('Users');
  view.innerHTML = loadingHtml();
  const canEdit = ctx.user.approvalLevel === 2;
  let list = (await api('/admin/users')).users;
  let q = '';
  view.innerHTML = `
    ${canEdit ? '' : '<div class="notice blue" style="margin-bottom:16px">Only Level 2 admins can change roles and approval levels.</div>'}
    <div class="toolbar"><div class="search spacer">${ICONS.search}<input class="input" id="q" placeholder="Search name, email or department"></div></div>
    <div class="card"><div id="table"></div></div>`;
  const draw = () => {
    const items = list.filter((u) => !q || `${u.name} ${u.email} ${u.department}`.toLowerCase().includes(q));
    view.querySelector('#table').innerHTML = items.length
      ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Phone</th><th>Details</th><th>Requests</th><th>Access</th><th>Status</th><th>Joined</th></tr></thead>
        <tbody>${items
          .map((u) => {
            const editable = canEdit && u.id !== ctx.user.id;
            return `<tr data-user="${u.id}">
              <td><div class="strong">${esc(u.name)}</div><div class="muted xs">${esc(u.email)}</div></td>
              <td class="nowrap">${esc(u.phone)}</td>
              <td class="sm">${userLine(u)}${u.school ? `<div class="muted xs">${esc(u.school)}</div>` : ''}</td>
              <td>${u.requestCount}</td>
              <td>${editable ? `<select class="input" data-access style="height:34px;width:190px">${ACCESS.map(([v, l]) => `<option value="${v}" ${v === accessOf(u) ? 'selected' : ''}>${l}</option>`).join('')}</select>` : esc(ACCESS.find((a) => a[0] === accessOf(u))[1])}</td>
              <td>${editable ? `<button class="link-btn ${u.active ? 'danger' : ''}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : ''} ${u.active ? badge('available', 'Active') : badge('rejected', 'Disabled')}</td>
              <td class="nowrap">${fmtDate(u.createdAt)}</td>
            </tr>`;
          })
          .join('')}</tbody></table></div>`
      : emptyHtml('No users found');
  };
  const save = async (id, body) => {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body });
      toast('Access updated', 'success');
    } catch (err) {
      toastError(err);
    }
    list = (await api('/admin/users')).users;
    draw();
  };
  view.querySelector('#q').addEventListener('input', debounce((e) => {
    q = e.target.value.trim().toLowerCase();
    draw();
  }, 150));
  view.querySelector('#table').addEventListener('change', (e) => {
    if (e.target.matches('[data-access]')) save(Number(e.target.closest('[data-user]').dataset.user), { access: e.target.value });
  });
  view.querySelector('#table').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-active]');
    if (!b) return;
    const id = Number(b.closest('[data-user]').dataset.user);
    const enable = b.dataset.active === '1';
    if (!enable && !(await confirmBox({ title: 'Disable account?', message: 'The user will be logged out and cannot log in until re-enabled.', confirmText: 'Disable', danger: true }))) return;
    save(id, { active: enable });
  });
  draw();
}
