/**
 * @file js/admin/users.js
 * @module admin/users
 * User management module: searchable/paginated account table, provisioning of
 * individual and organization accounts, status and role lifecycle changes,
 * password resets, and soft deletes. Self-modification is blocked server-side
 * and reflected in the UI by disabling actions on the signed-in account.
 */
import { adminRequest, esc, fmtDateTime, statusBadge, roleBadge, confirmDialog } from './api.js';
import { showToast } from '../ui/toast.js';
import { openModal, closeModal } from '../ui/modal.js';
import { currentUser } from '../auth.js';

const PAGE_SIZE = 25;

const state = {
  items: [],
  total: 0,
  offset: 0,
  filters: { q: '', role: '', status: '' },
  editingPublicId: null,
  editingUsername: '',
};

const tbody = () => document.getElementById('admin-users-tbody');
const statusEl = () => document.getElementById('admin-users-status');
const errorEl = () => document.getElementById('admin-users-error');

function isSelf(publicId) {
  return String(currentUser()?.id || '') === String(publicId);
}

async function loadUsers({ reset = false } = {}) {
  if (reset) state.offset = 0;
  const params = new URLSearchParams();
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.role) params.set('role', state.filters.role);
  if (state.filters.status) params.set('status', state.filters.status);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(state.offset));

  statusEl().textContent = 'Loading accounts…';
  errorEl().textContent = '';
  try {
    const data = await adminRequest(`/api/admin/users?${params.toString()}`);
    state.items = data.items || [];
    state.total = data.total ?? state.items.length;
    statusEl().textContent = `${state.total} account(s) match the current filters.`;
    renderTable();
  } catch (error) {
    state.items = [];
    statusEl().textContent = 'Account list failed to load.';
    errorEl().textContent = error.message;
    if (!tbody() || error.status === 404) return;
    tbody().innerHTML = `<tr><td colspan="6"><div class="admin-empty">⚠ ${esc(error.message)}</div></td></tr>`;
  }
}

function renderTable() {
  const body = tbody();
  if (!body) return;
  if (!state.items.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="admin-empty">No accounts match the current filters.</div></td></tr>';
    updatePagination();
    return;
  }
  body.innerHTML = state.items.map((item) => {
    const self = isSelf(item.public_id);
    return `
      <tr data-user-id="${esc(item.public_id)}" ${self ? 'title="This is your own account (self-management blocked)"' : ''}>
        <td>
          <div class="admin-cell-main">${esc(item.display_name || item.username)}</div>
          <div class="admin-cell-muted font-mono">@${esc(item.username)} · ${esc(item.email)}</div>
        </td>
        <td>${roleBadge(item.role)}</td>
        <td>${statusBadge(item.status)}${self ? ' <span class="admin-badge is-muted">you</span>' : ''}</td>
        <td><span class="admin-cell-muted">${esc(fmtDateTime(item.created_at))}</span></td>
        <td><span class="admin-cell-muted">${esc(fmtDateTime(item.last_login_at))}</span></td>
        <td>
          <div class="admin-actions-cell">
            <button type="button" class="btn btn--secondary btn--sm" data-user-action="edit" data-user-id="${esc(item.public_id)}"
              ${self ? 'disabled title="Administrators cannot modify their own account"' : ''}>Edit</button>
            <button type="button" class="btn btn--secondary btn--sm" data-user-action="reset" data-user-id="${esc(item.public_id)}" data-user-name="${esc(item.username)}"
              ${self ? 'disabled title="Sign out and use your own password change flow"' : ''}>Password</button>
          </div>
        </td>
      </tr>`;
  }).join('');
  updatePagination();
}

function updatePagination() {
  const prev = document.getElementById('admin-btn-users-prev');
  const next = document.getElementById('admin-btn-users-next');
  const range = document.getElementById('admin-users-range');
  if (range) {
    const shown = state.items.length;
    range.textContent = shown
      ? `Showing ${state.offset + 1}–${state.offset + shown} of ${state.total}`
      : 'No accounts to show';
  }
  if (prev) prev.disabled = state.offset <= 0;
  if (next) next.disabled = state.offset + state.items.length >= state.total;
}

/* ── Provisioning ─────────────────────────────────────────────────────────── */

function openProvisionModal() {
  document.getElementById('admin-provision-error').textContent = '';
  openModal('modal-provision-user');
  document.getElementById('admin-provision-username')?.focus();
}

async function submitProvision(event) {
  event.preventDefault();
  const errorEl = document.getElementById('admin-provision-error');
  errorEl.textContent = '';
  const payload = {
    role: document.getElementById('admin-provision-role').value,
    username: document.getElementById('admin-provision-username').value.trim(),
    email: document.getElementById('admin-provision-email').value.trim(),
    displayName: document.getElementById('admin-provision-display').value.trim(),
    password: document.getElementById('admin-provision-password').value,
  };
  const submitButton = event.target.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    const data = await adminRequest('/api/admin/users', { method: 'POST', body: payload });
    showToast(data.message || 'Account provisioned.', 'success');
    closeModal('modal-provision-user');
    event.target.reset();
    document.getElementById('admin-provision-role').value = 'organization';
    loadUsers({ reset: true });
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

/* ── Edit account ─────────────────────────────────────────────────────────── */

async function openEditModal(publicId) {
  state.editingPublicId = publicId;
  const errorEl = document.getElementById('admin-edit-error');
  const detail = document.getElementById('admin-edit-detail');
  errorEl.textContent = '';
  openModal('modal-edit-user');
  detail.innerHTML = '<div class="admin-empty">Loading account details…</div>';
  try {
    const { user } = await adminRequest(`/api/admin/users/${encodeURIComponent(publicId)}`);
    state.editingUsername = user.username;
    document.getElementById('admin-edit-status').value = ['active', 'suspended'].includes(user.status) ? user.status : 'active';
    document.getElementById('admin-edit-role').value = ['individual', 'organization', 'admin'].includes(user.role) ? user.role : 'individual';
    document.getElementById('admin-edit-display').value = user.display_name || '';
    detail.innerHTML = [
      ['Username', `@${user.username}`],
      ['Email', user.email],
      ['Current Role', user.role || '—'],
      ['Current Status', user.status || '—'],
      ['Created', fmtDateTime(user.created_at)],
      ['Last Login', fmtDateTime(user.last_login_at)],
      ['Locked Until', fmtDateTime(user.locked_until)],
      ['Failed Attempts', user.failed_attempts ?? 0],
    ].map(([label, value]) => `
      <div class="admin-detail-item">
        <div class="admin-detail-label">${esc(label)}</div>
        <div class="admin-detail-value">${esc(value)}</div>
      </div>`).join('');
  } catch (error) {
    detail.innerHTML = '';
    errorEl.textContent = error.message;
  }
}

async function submitEdit(event) {
  event.preventDefault();
  if (!state.editingPublicId) return;
  const errorEl = document.getElementById('admin-edit-error');
  errorEl.textContent = '';
  const target = isSelf(state.editingPublicId);
  const payload = {
    status: document.getElementById('admin-edit-status').value,
    displayName: document.getElementById('admin-edit-display').value.trim(),
    ...(target ? {} : { role: document.getElementById('admin-edit-role').value }),
  };
  const submitButton = event.target.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    await adminRequest(`/api/admin/users/${encodeURIComponent(state.editingPublicId)}`, { method: 'PATCH', body: payload });
    showToast('Account updated successfully.', 'success');
    closeModal('modal-edit-user');
    loadUsers();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function deleteEditingUser() {
  if (!state.editingPublicId || isSelf(state.editingPublicId)) return;
  const username = state.editingUsername.split('@')[0];
  const confirmed = await confirmDialog(
    `Suspend-and-delete account @${username}? The account is marked deleted and loses all access immediately. Archived matches are preserved.`,
    'Delete Account',
    true,
  );
  if (!confirmed) return;
  try {
    const data = await adminRequest(`/api/admin/users/${encodeURIComponent(state.editingPublicId)}`, { method: 'DELETE' });
    showToast(data.message || 'Account deleted.', 'success');
    closeModal('modal-edit-user');
    loadUsers();
  } catch (error) {
    document.getElementById('admin-edit-error').textContent = error.message;
  }
}

/* ── Reset password ───────────────────────────────────────────────────────── */

function openResetModalFromRow(publicId, username) {
  state.editingPublicId = publicId;
  state.editingUsername = username;
  document.getElementById('admin-reset-error').textContent = '';
  document.getElementById('admin-reset-target').textContent = `Account: @${username}`;
  document.getElementById('admin-reset-password').value = '';
  openModal('modal-reset-password');
  document.getElementById('admin-reset-password')?.focus();
}

function generateStrongPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function submitReset(event) {
  event.preventDefault();
  const password = document.getElementById('admin-reset-password').value;
  const errorEl = document.getElementById('admin-reset-error');
  errorEl.textContent = '';
  const submitButton = event.target.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    const data = await adminRequest(`/api/admin/users/${encodeURIComponent(state.editingPublicId)}/reset-password`, {
      method: 'POST',
      body: { password },
    });
    showToast(data.message || 'Password reset.', 'success');
    closeModal('modal-reset-password');
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */

export function initUsers() {
  document.getElementById('admin-btn-provision')?.addEventListener('click', openProvisionModal);
  document.getElementById('admin-form-provision')?.addEventListener('submit', submitProvision);
  document.getElementById('admin-form-edit')?.addEventListener('submit', submitEdit);
  document.getElementById('admin-form-reset')?.addEventListener('submit', submitReset);
  document.getElementById('admin-btn-apply-user-filters')?.addEventListener('click', () => {
    state.filters = {
      q: document.getElementById('admin-users-search').value.trim(),
      role: document.getElementById('admin-users-role-filter').value,
      status: document.getElementById('admin-users-status-filter').value,
    };
    loadUsers({ reset: true });
  });
  document.getElementById('admin-btn-clear-user-filters')?.addEventListener('click', () => {
    document.getElementById('admin-users-search').value = '';
    document.getElementById('admin-users-role-filter').value = '';
    document.getElementById('admin-users-status-filter').value = '';
    state.filters = { q: '', role: '', status: '' };
    loadUsers({ reset: true });
  });
  document.getElementById('admin-btn-users-prev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    loadUsers();
  });
  document.getElementById('admin-btn-users-next')?.addEventListener('click', () => {
    state.offset += PAGE_SIZE;
    loadUsers();
  });
  tbody()?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-user-action]');
    if (button) {
      const { userAction, userId, userName } = button.dataset;
      if (userAction === 'edit') openEditModal(userId);
      if (userAction === 'reset') openResetModalFromRow(userId, userName);
    }
  });
  document.getElementById('admin-btn-open-reset')?.addEventListener('click', () => {
    if (state.editingPublicId) {
      openResetModalFromRow(state.editingPublicId, state.editingUsername);
    }
  });
  document.getElementById('admin-btn-delete-user')?.addEventListener('click', deleteEditingUser);
  document.getElementById('admin-btn-generate-password')?.addEventListener('click', () => {
    document.getElementById('admin-reset-password').value = generateStrongPassword();
  });
  document.getElementById('admin-btn-reload-users')?.addEventListener('click', () => loadUsers({ reset: true }));
}

export { state as usersState, loadUsers };
export function refreshUsers() { loadUsers({ reset: true }); }
