/**
 * @file js/admin/api.js
 * Shared helpers for the Admin console modules: authenticated JSON requests,
 * HTML escaping, date formatting, and small render utilities.
 */
import { apiFetch, readApiJson } from '../net/api.js';
import { authHeaders } from '../auth.js';

/**
 * Performs an authenticated request against the admin REST API and returns the
 * parsed JSON body. Non-2xx responses are converted into Error objects that
 * carry `.status` and `.code` so modules can react (e.g. re-login on 401).
 */
export async function adminRequest(path, { method = 'GET', body } = {}) {
  const headers = { ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await apiFetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await readApiJson(response);
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Request failed (HTTP ${response.status}).`);
    error.status = response.status;
    error.code = data.error || '';
    throw error;
  }
  return data;
}

/** Escapes text for safe insertion into innerHTML templates. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/** Human-friendly local date-time, or an em dash when nothing is stored. */
export function fmtDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Relative "x hours ago" label used in dashboards and lists. */
export function fmtRelative(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STATUS_TONE = {
  active: 'is-valid',
  suspended: 'is-warn',
  deleted: 'is-invalid',
  pending: 'is-warn',
  banned: 'is-invalid',
};

/** Small colored badge for the user/account status columns. */
export function statusBadge(status) {
  const tone = STATUS_TONE[String(status || '').toLowerCase()] || 'is-warn';
  return `<span class="admin-badge admin-badge--status ${tone}">${esc(status || 'unknown')}</span>`;
}

const ROLE_TONE = {
  admin: 'is-admin',
  organization: 'is-host',
  individual: 'is-player',
};

/** Small colored badge for the role columns. */
export function roleBadge(role) {
  const tone = ROLE_TONE[String(role || '').toLowerCase()] || '';
  return `<span class="admin-badge admin-badge--role ${tone}">${esc(role || 'unknown')}</span>`;
}

/** Minimal custom confirm dialog using the shared modal styles. Returns a Promise<boolean>. */
export function confirmDialog(message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.style.zIndex = 'calc(var(--z-modal) + 2)';
    backdrop.innerHTML = `
      <div class="modal-card" style="max-width:420px">
        <h2 style="font-size:1.1rem; margin-bottom:var(--space-2)">Please Confirm</h2>
        <p class="admin-confirm-text">${esc(message)}</p>
        <div style="display:flex; gap:.6rem; justify-content:flex-end; margin-top:var(--space-3)">
          <button type="button" class="btn btn--secondary" data-admin-confirm="no">Cancel</button>
          <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-admin-confirm="yes">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const finish = (result) => { backdrop.remove(); resolve(result); };
    backdrop.querySelector('[data-admin-confirm="no"]').addEventListener('click', () => finish(false));
    backdrop.querySelector('[data-admin-confirm="yes"]').addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(false);
    });
    document.body.appendChild(backdrop);
  });
}
