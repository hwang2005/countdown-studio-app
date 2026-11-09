/**
 * @file js/admin/audit-logs.js
 * @module admin/audit-logs
 * Audit log viewer: read-only inspection of auth_events (logins, password
 * resets, role changes, suspensions, etc.) with pagination and filtering.
 */
import { adminRequest, esc, fmtDateTime } from './api.js';
import { showToast } from '../ui/toast.js';

const PAGE_SIZE = 50;

const state = {
  offset: 0,
  total: 0,
  filters: { event: '', user: '', from: '', to: '' },
  items: [],
};

const listEl = () => document.getElementById('admin-audit-logs-list');
const statusEl = () => document.getElementById('admin-audit-logs-status');
const errorEl = () => document.getElementById('admin-audit-logs-error');

const EVENT_TONE = {
  login_success: 'is-valid',
  login_failed: 'is-warn',
  password_changed: 'is-valid',
  password_reset_requested: 'is-warn',
  password_reset_completed: 'is-valid',
  account_locked: 'is-invalid',
  role_granted: 'is-admin',
  role_revoked: 'is-admin',
  email_verified: 'is-valid',
  logout: '',
  register: 'is-valid',
  token_reuse_detected: 'is-invalid',
};

function eventBadge(code) {
  const tone = EVENT_TONE[String(code || '').toLowerCase()] || '';
  return `<span class="admin-badge admin-badge--event ${tone}">${esc(String(code || 'unknown'))}</span>`;
}

async function loadAuditLogs({ reset = false } = {}) {
  if (reset) {
    state.offset = 0;
    state.items = [];
  }
  const params = new URLSearchParams();
  if (state.filters.event) params.set('event', state.filters.event);
  if (state.filters.user) params.set('user', state.filters.user);
  if (state.filters.from) params.set('from', state.filters.from);
  if (state.filters.to) params.set('to', state.filters.to);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(state.offset));

  statusEl().textContent = 'Loading audit log…';
  errorEl().textContent = '';
  listEl()?.classList.add('admin-loading');

  try {
    const data = await adminRequest(`/api/admin/audit-logs?${params.toString()}`);
    state.items = reset ? (data.items || []) : [...state.items, ...(data.items || [])];
    state.total = data.total ?? 0;
    statusEl().textContent = `${state.total} event(s) match the current filters.`;
    renderList(reset);
  } catch (error) {
    statusEl().textContent = 'Audit log failed to load.';
    errorEl().textContent = error.message;
    listEl().innerHTML = `<div class="admin-empty">⚠ ${esc(error.message)}</div>`;
  } finally {
    listEl()?.classList.remove('admin-loading');
  }
}

function renderList(replace) {
  const list = listEl();
  if (!list) return;
  if (!state.items.length) {
    list.innerHTML = '<div class="admin-empty">No audit events found for these filters.</div>';
    document.getElementById('admin-btn-more-audit').hidden = true;
    return;
  }
  const rows = state.items.map((item) => {
    const details = item.details && typeof item.details === 'object' ? Object.entries(item.details)
      .map(([k, v]) => `<strong>${esc(k)}:</strong> ${esc(String(v))}`)
      .join(' · ') : '';
    return `
      <button type="button" class="admin-archive-item"
        data-audit-id="${esc(item.id)}">
        <div>
          <div>${eventBadge(item.event_type)} · ${esc(fmtDateTime(item.created_at))}</div>
          <div class="admin-archive-meta">
            User: ${esc(item.username)} (${esc(item.email)})
            ${item.ip_address ? ` · IP: ${esc(item.ip_address)}` : ''}
          </div>
          ${details ? `<div style="font-size:.75rem; color:var(--text-muted); margin-top:.15rem">${details}</div>` : ''}
        </div>
      </button>`;
  }).join('');
  if (replace) list.innerHTML = rows;
  else list.insertAdjacentHTML('beforeend', rows);
  document.getElementById('admin-btn-more-audit').hidden = state.items.length >= (state.total ?? state.items.length);
}

export function initAuditLogs() {
  document.getElementById('admin-btn-reload-audit')?.addEventListener('click', () => loadAuditLogs({ reset: true }));
  document.getElementById('admin-btn-apply-audit-filters')?.addEventListener('click', () => {
    state.filters = {
      event: document.getElementById('admin-audit-event-filter').value,
      user: document.getElementById('admin-audit-user-filter').value.trim(),
      from: document.getElementById('admin-audit-from').value,
      to: document.getElementById('admin-audit-to').value,
    };
    loadAuditLogs({ reset: true });
  });
  document.getElementById('admin-btn-clear-audit-filters')?.addEventListener('click', () => {
    document.getElementById('admin-audit-event-filter').value = '';
    document.getElementById('admin-audit-user-filter').value = '';
    document.getElementById('admin-audit-from').value = '';
    document.getElementById('admin-audit-to').value = '';
    state.filters = { event: '', user: '', from: '', to: '' };
    loadAuditLogs({ reset: true });
  });
  document.getElementById('admin-btn-more-audit')?.addEventListener('click', () => {
    state.offset += PAGE_SIZE;
    loadAuditLogs();
  });
}

export function refreshAuditLogs() { loadAuditLogs({ reset: true }); }
