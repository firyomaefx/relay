const $ = (id) => document.getElementById(id);
let customers = [];
let waitlistEntries = [];
const money = (n) => "$" + (Number(n) / 1000).toFixed(3);

async function ensureOwnerSession() {
  const session = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
  if (session.role !== 'operator') window.location.replace('/admin');
}

async function loadDeployHealth() {
  const el = $('deployHealth');
  if (!el) return;
  el.textContent = 'Loading…';
  const r = await fetch('/api/cloud/admin/deploy-health', { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    el.textContent = data.error || 'Could not load deploy health';
    return;
  }
  const tone = data.ok ? 'ok' : 'error';
  const pauseNote = data.vmRepairPaused
    ? '<div class="muted" style="margin-bottom:8px;font-size:13px">VM repair <strong>paused</strong> — no blind deploy until you clear RELAY_VM_REPAIR_PAUSED or use VM_REPAIR_RUN=1.</div>'
    : '';
  const lines = [
    pauseNote,
    `<div class="${tone}" style="margin-bottom:8px;font-weight:600">${data.ok ? 'Sleep mode stack looks healthy on this host' : `${data.issues?.length ?? 0} issue(s) — see deploy/operator-handoff.md`}</div>`,
    `<ul style="margin:0;padding-left:1.2rem;font-size:13px">`,
    `<li>Console: ${data.console?.reachable ? 'up' : 'down'} · gitSha ${esc(data.console?.gitSha?.slice(0, 7) || '—')} · pulse ${data.console?.tenantSchedulerPulseMs ?? '—'} ms</li>`,
    `<li>Cloud MCP: ${data.cloudMcp?.reachable ? esc(data.cloudMcp?.name || 'up') : 'down'} · gitSha ${esc(data.cloudMcp?.gitSha?.slice(0, 7) || '—')} · pulse ${data.cloudMcp?.tenantSchedulerPulseMs ?? '—'} ms</li>`,
    `</ul>`,
  ];
  if (data.issues?.length) {
    lines.push(`<ul style="margin:8px 0 0;padding-left:1.2rem;font-size:13px" class="error">${data.issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul>`);
  }
  el.innerHTML = lines.join('');
}

async function loadAutomationHealth() {
  const el = $('automationHealth');
  if (!el) return;
  el.textContent = 'Loading…';
  const r = await fetch('/api/cloud/admin/automation-health', { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    el.textContent = data.error || 'Could not load automation health';
    return;
  }
  const pulse = data.tenantSchedulerPulseMs ?? 0;
  const rows = data.customers || [];
  const issueCount = data.issueCount ?? rows.reduce((sum, row) => sum + (row.issues?.length ?? (row.error ? 1 : 0)), 0);
  if (!rows.length) {
    el.textContent = `Pulse interval ${pulse} ms · no active customers yet.`;
    return;
  }
  el.innerHTML = `<div class="muted" style="margin-bottom:8px">Host pulse every ${pulse} ms · <strong>${issueCount}</strong> issue(s)${issueCount ? ' — operator digest email when RELAY_OPERATOR_ALERT_EMAIL is set' : ''}</div>
    <table><thead><tr>
      <th>Customer</th><th>Scheduler</th><th>Brevo</th><th>DS</th><th>Webhook</th><th>Threads AR</th><th>Queue</th><th>Balance</th><th>Issues</th>
    </tr></thead><tbody>${rows.map((row) => {
      const issues = row.issues?.length ? row.issues : row.error ? [row.error] : [];
      if (row.error && !row.displayName) return `<tr><td colspan="9" class="error">${esc(row.error)}</td></tr>`;
      const sched = row.schedulerRunning
        ? (row.schedulerOwned ? 'running here' : 'running elsewhere')
        : 'off';
      const issueCell = issues.length
        ? `<span class="error" style="font-size:12px">${esc(issues.join('; '))}</span>`
        : '<span class="ok">ok</span>';
      return `<tr>
        <td>${esc(row.displayName)}</td>
        <td>${esc(sched)}</td>
        <td>${row.brevoConnected ? 'yes' : '—'}</td>
        <td>${row.deepSeek ? 'yes' : '—'}</td>
        <td>${row.webhookRegistered ? 'ok' : '—'}</td>
        <td>${row.threadsAutoreplyActive ? 'on' : row.threadsConnected ? 'idle' : '—'}</td>
        <td>${row.queuePending ?? 0}</td>
        <td>${money(row.balance ?? 0)}</td>
        <td>${issueCell}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

async function loadRevenueGoal() {
  const summary = $('revenueGoalSummary');
  const myr = $('revenueGoalMyr');
  const detail = $('revenueGoalDetail');
  if (!summary) return;
  const r = await fetch('/api/cloud/admin/revenue-summary', { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    summary.textContent = data.error || 'Could not load revenue summary';
    return;
  }
  const goal = data.goal?.amountMyr ?? 4000;
  const est = data.estimatedMyr;
  const pct = data.progressPercent;
  summary.textContent = `Customer payments since ${new Date(data.since).toLocaleDateString()} · goal RM ${goal.toLocaleString()} by ${data.goal?.deadline ?? '31 Dec 2026'}`;
  if (est != null) {
    myr.textContent = `RM ${est.toLocaleString(undefined, { maximumFractionDigits: 0 })} collected (${pct != null ? pct.toFixed(1) : '—'}%)`;
    detail.textContent = `${data.succeededCount} payments · $${(data.totalMilliUsd / 1000).toFixed(2)} USD at rate ${data.usdMyrRate ?? '—'}`;
  } else {
    myr.textContent = `$${(data.totalMilliUsd / 1000).toFixed(2)} USD`;
    detail.textContent = `${data.succeededCount} customer payments (set usd_myr_rate in cloud-prices for RM estimate)`;
  }
}

async function loadStatusChips() {
  const el = $('statusChips');
  if (!el) return;
  const [health, waitlist] = await Promise.all([
    fetch('/api/health', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({})),
    fetch('/api/waitlist', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({})),
  ]);
  const chips = [];
  chips.push(`<span class="chip ok">Signed in as admin</span>`);
  chips.push(`<span class="chip ${health.emailConfigured ? 'ok' : 'warn'}">Email ${health.emailConfigured ? 'on' : 'off'}</span>`);
  const pay = health.payments?.stripeConfigured || health.payments?.polarConfigured;
  chips.push(`<span class="chip ${pay ? 'ok' : 'warn'}">Payments ${pay ? 'on' : 'off'}</span>`);
  if (waitlist.accepted != null && waitlist.limit != null) {
    chips.push(`<span class="chip">Waitlist ${waitlist.accepted} / ${waitlist.limit} invited</span>`);
  }
  el.innerHTML = chips.join('');
}

$('ownerLogout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
  window.location.replace('/admin');
});
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

async function loadWaitlist() {
  const filter = $('waitlistFilter').value;
  const query = filter ? '?status=' + encodeURIComponent(filter) : '';
  const r = await fetch('/api/cloud/admin/waitlist' + query, { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('waitlist').textContent = data.error || 'Unable to load waitlist'; return; }
  waitlistEntries = data.entries || [];
  const counts = data.counts || {};
  $('waitlistCounts').textContent = `${data.accepted || 0} / ${data.limit || 100} invited · ${counts.pending || 0} pending · ${counts.rejected || 0} rejected`;
  $('waitlist').innerHTML = waitlistEntries.length
    ? `<table class="waitlist-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Platforms</th><th>Volume</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead><tbody>${waitlistEntries.map((entry) => `
        <tr>
          <td>${esc(entry.name)}</td>
          <td>${esc(entry.email)}</td>
          <td>${esc(entry.phone || '—')}</td>
          <td>${esc(entry.platforms || '—')}</td>
          <td>${esc(entry.volume || '—')}</td>
          <td><span class="pill status-${esc(entry.status)}">${esc(entry.status)}</span></td>
          <td>${new Date(entry.createdAt).toLocaleDateString()}</td>
          <td><div class="actions">
            ${entry.status === 'pending' ? `<button data-waitlist-action="approve" data-id="${esc(entry.id)}">Approve</button><button class="danger" data-waitlist-action="reject" data-id="${esc(entry.id)}">Reject</button>` : ''}
            ${entry.status === 'invited' || entry.status === 'active' ? `<button class="secondary" data-waitlist-action="invite" data-id="${esc(entry.id)}">New invite link</button>` : ''}
          </div></td>
        </tr>`).join('')}</tbody></table>`
    : `<p class="muted">No ${filter || ''} waitlist requests.</p>`;
}

async function waitlistAction(id, action) {
  const entry = waitlistEntries.find((item) => item.id === id);
  if (!entry) return;
  if (action === 'reject') {
    const note = prompt(`Reject ${entry.name}? Optional note:`, '');
    if (note === null) return;
    const r = await fetch(`/api/cloud/admin/waitlist/${encodeURIComponent(id)}/reject`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { alert(data.error || 'Could not reject this request'); return; }
    await loadWaitlist();
    return;
  }
  const r = await fetch(`/api/cloud/admin/waitlist/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { alert(data.error || 'Could not update this request'); return; }
  const inviteUrl = data.setupUrl || data.connectUrl || '';
  const subject = encodeURIComponent('Your Relay Cloud invite');
  const body = encodeURIComponent(`Hi ${entry.name},\n\nYour Relay Cloud account is ready. Set your password here:\n\n${inviteUrl}\n\nTreat this link like a password.\n\nRelay`);
  $('waitlistInvite').innerHTML = `<div class="invite-box">
    <strong>Invite ready for ${esc(entry.name)} <${esc(entry.email)}></strong>
    <div class="muted" style="margin-top:4px">${data.emailSent ? 'The invite email was sent automatically. You can resend the link below.' : 'Automatic email is not configured. Copy this private link or open an email draft.'} It acts as their account; do not post it publicly.</div>
    <input id="inviteUrl" readonly value="${esc(inviteUrl)}">
    <div style="display:flex;gap:12px;align-items:center;margin-top:8px">
      <a href="mailto:${encodeURIComponent(entry.email)}?subject=${subject}&body=${body}">Open email draft</a>
      <button id="copyInvite" class="secondary" type="button" style="margin:0;padding:5px 9px;font-size:12px">Copy link</button>
    </div>
  </div>`;
  $('copyInvite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteUrl); $('copyInvite').textContent = 'Copied'; }
    catch { $('inviteUrl').select(); document.execCommand('copy'); $('copyInvite').textContent = 'Copied'; }
  });
  await loadWaitlist();
  await loadCustomers();
}

async function loadCustomers() {
  const r = await fetch('/api/cloud/admin/customers', { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Unable to load customers');
  customers = data.customers || [];
  $('customer').innerHTML = customers.map(c =>
    `<option value="${c.id}">${c.displayName}, available ${money(c.available)}</option>`
  ).join('');
  renderSummary();
  if (customers[0]) { loadDetails(customers[0].id); loadPayments(customers[0].id); }
}

function renderSummary() {
  const c = customers.find(x => x.id === $('customer').value) || customers[0];
  if (!c) { $('summary').textContent = 'No customers.'; return; }
  $('summary').innerHTML = `<div class="balance">${money(c.available)}</div>
    <div class="muted">available · held ${money(c.held)} · balance ${money(c.balance)}</div>
    <div style="margin-top:8px" class="pill">${c.status}</div>`;
}

let selectedHasPassword = false;

async function loadDetails(id) {
  const r = await fetch('/api/cloud/admin/customers/' + encodeURIComponent(id), { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('details').textContent = data.error || 'Unable to load customer details'; return; }
  selectedHasPassword = Boolean(data.hasPassword);
  const resetBtn = $('passwordReset');
  if (resetBtn) {
    resetBtn.disabled = !selectedHasPassword;
    resetBtn.title = selectedHasPassword ? '' : 'Customer must finish setup before a reset link can be sent.';
  }
  $('details').innerHTML = data.accounts.length
    ? `<table><thead><tr><th>Platform</th><th>Status</th><th>Account</th></tr></thead><tbody>${data.accounts.map(a =>
        `<tr><td>${a.platform}</td><td>${a.status}</td><td>${a.accountRef || '—'}</td></tr>`
      ).join('')}</tbody></table>`
    : 'No customer accounts yet.';
}

async function loadPayments(id) {
  const r = await fetch('/api/cloud/admin/payments?customer=' + encodeURIComponent(id), { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('payments').textContent = data.error || 'Unable to load payments'; return; }
  $('payments').innerHTML = data.payments.length
    ? `<table><thead><tr><th>When</th><th>Amount</th><th>Reference</th></tr></thead><tbody>${data.payments.map(p =>
        `<tr><td>${new Date(p.createdAt).toLocaleString()}</td><td>${money(p.amount)}</td><td>${p.providerPaymentId}</td></tr>`
      ).join('')}</tbody></table>`
    : 'No payments yet.';
}

$('customer').addEventListener('change', () => { renderSummary(); loadDetails($('customer').value); loadPayments($('customer').value); });

$('topup').addEventListener('click', async () => {
  const button = $('topup');
  $('message').textContent = '';
  $('message').className = 'muted';
  const body = {
    customerId: $('customer').value,
    amount: Number($('amount').value),
    reference: $('reference').value.trim(),
    note: $('note').value.trim(),
  };
  if (!body.customerId || !Number.isInteger(body.amount) || body.amount <= 0 || !body.reference) {
    $('message').textContent = 'Customer, a positive whole amount and a reference are required.';
    $('message').className = 'error';
    return;
  }
  button.disabled = true;
  try {
    const r = await fetch('/api/cloud/admin/topup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Top-up failed');
    $('message').textContent = data.paymentReplayed
      ? 'This reference was already recorded; no duplicate credit was added.'
      : `Recorded ${money(data.event.amount)}. New available balance: ${money(data.balance.available)}.`;
    $('message').className = 'ok';
    await loadCustomers();
    await loadPayments($('customer').value);
  } catch (error) {
    $('message').textContent = error.message;
    $('message').className = 'error';
  } finally {
    button.disabled = false;
  }
});

$('polarCheckout').addEventListener('click', async () => {
  const customerId = $('customer').value;
  try {
    const r = await fetch('/api/cloud/admin/polar-checkout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Polar checkout is not available');
    window.open(data.url, '_blank', 'noopener');
    $('message').textContent = 'Polar checkout opened in a new tab.';
    $('message').className = 'ok';
  } catch (error) { $('message').textContent = error.message; $('message').className = 'error'; }
});
$('checkout').addEventListener('click', async () => {
  const customerId = $('customer').value;
  const amount = Number($('amount').value);
  $('message').textContent = '';
  if (!customerId || !Number.isInteger(amount) || amount <= 0) { $('message').textContent = 'Choose a customer and enter an amount.'; $('message').className = 'error'; return; }
  try {
    const r = await fetch('/api/cloud/admin/checkout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId, amount }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Stripe checkout is not available');
    window.open(data.url, '_blank', 'noopener');
    $('message').textContent = 'Stripe checkout opened in a new tab.';
    $('message').className = 'ok';
  } catch (error) { $('message').textContent = error.message; $('message').className = 'error'; }
});

$('passwordReset')?.addEventListener('click', async () => {
  const customerId = $('customer').value;
  if (!customerId) return;
  if (!selectedHasPassword) {
    $('message').textContent = 'This customer has not set a password yet. Use a setup invite from the waitlist instead.';
    $('message').className = 'error';
    return;
  }
  const customer = customers.find((item) => item.id === customerId);
  if (!confirm(`Send a password reset link${customer?.displayName ? ` to ${customer.displayName}` : ''}? The customer chooses the new password; Relay does not email a generated password.`)) return;
  $('message').textContent = '';
  $('passwordReset').disabled = true;
  try {
    const r = await fetch(`/api/cloud/admin/customers/${encodeURIComponent(customerId)}/password-reset`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not create reset link');
    const resetUrl = data.resetUrl || data.setupUrl || '';
    $('message').innerHTML = `${data.emailSent ? 'Reset email sent.' : 'Email not sent; copy the reset link below.'}${resetUrl ? `<div class="invite-box" style="margin-top:10px"><input readonly value="${esc(resetUrl)}"></div>` : ''}`;
    $('message').className = 'ok';
  } catch (error) {
    $('message').textContent = error.message;
    $('message').className = 'error';
  } finally {
    $('passwordReset').disabled = !selectedHasPassword;
  }
});

$('connect').addEventListener('click', async () => {
  const customerId = $('customer').value;
  if (!customerId) return;
  $('connectLink').textContent = 'Creating…';
  try {
    const r = await fetch('/api/cloud/admin/connect-token', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not create a connect link');
    const mcpUrl = data.url || '';
    $('connectLink').innerHTML = `<div class="muted">Share this connect page with the customer. It contains a private URL that acts as this customer.</div><input readonly style="width:100%;margin-top:8px;padding:9px;border:1px solid var(--line);border-radius:8px;background:#fff;font:12px monospace" value="${data.connectUrl.replace(/"/g, '&quot;')}">
      <div class="muted" style="margin-top:12px">MCP URL for Grokbot or another MCP client (Streamable HTTP):</div>
      <input readonly style="width:100%;margin-top:6px;padding:9px;border:1px solid var(--line);border-radius:8px;background:#fff;font:12px monospace" value="${mcpUrl.replace(/"/g, '&quot;')}">
      <div class="muted" style="margin-top:6px">Keep this URL private. It can act as this customer.</div>`;
  } catch (error) { $('connectLink').textContent = error.message; }
});

$('refreshDeployHealth')?.addEventListener('click', () => { void loadDeployHealth(); });
$('refreshAutomation')?.addEventListener('click', () => { void loadAutomationHealth(); });
$('waitlistFilter').addEventListener('change', () => { void loadWaitlist(); });
$('waitlist').addEventListener('click', (event) => {
  const button = event.target.closest('[data-waitlist-action]');
  if (!button) return;
  void waitlistAction(button.dataset.id, button.dataset.waitlistAction);
});

void ensureOwnerSession().then(() => {
  void loadStatusChips();
  void loadRevenueGoal();
  void loadDeployHealth();
  void loadAutomationHealth();
  loadCustomers().catch(error => {
    $('summary').textContent = error.message;
    $('summary').className = 'error';
  });
  loadWaitlist().catch(error => {
    $('waitlist').textContent = error.message;
    $('waitlist').className = 'error';
  });
});
