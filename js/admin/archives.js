/**
 * @file js/admin/archives.js
 * @module admin/archives
 * Archived match inspector for administrators. Reuses the /api/versus/history
 * endpoints which grant admins cross-organization visibility (the server
 * applies the host organizing filter only for non-admin roles).
 *
 * Privacy note: snapshots contain round secrets (e.g. the conundrum answer),
 * so the detail view and download keep the restriction message visible.
 */
import { adminRequest, esc, fmtDateTime } from './api.js';
import { showToast } from '../ui/toast.js';

const PAGE_SIZE = 25;

const state = {
  offset: 0,
  total: 0,
  filters: { room: '', from: '', to: '' },
  selectedId: null,
  items: [],
};

const listEl = () => document.getElementById('admin-archives-list');
const statusEl = () => document.getElementById('admin-archives-status');
const detailEl = () => document.getElementById('admin-archives-detail');
const errorEl = () => document.getElementById('admin-archives-error');

async function loadArchives({ reset = false } = {}) {
  if (reset) {
    state.offset = 0;
    state.selectedId = null;
    detailEl().textContent = 'Select an archived match to inspect its full snapshot (includes round secrets — do not share).';
  }
  const params = new URLSearchParams();
  if (state.filters.room) params.set('room', state.filters.room);
  if (state.filters.from) params.set('from', state.filters.from);
  if (state.filters.to) params.set('to', state.filters.to);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(state.offset));

  statusEl().textContent = 'Loading archived matches…';
  errorEl().textContent = '';
  try {
    const data = await adminRequest(`/api/versus/history?${params.toString()}`);
    const fresh = data.items || [];
    state.items = reset ? fresh : [...state.items, ...fresh];
    state.total = data.total ?? 0;
    statusEl().textContent = `${state.total} archived match(es) match the current filters (all organizations visible to admins).`;
    renderList(state.offset === 0);
  } catch (error) {
    statusEl().textContent = 'Archives failed to load.';
    errorEl().textContent = error.message;
    listEl().innerHTML = `<div class="admin-empty">⚠ ${esc(error.message)}</div>`;
  }
}

function renderList(replace) {
  const list = listEl();
  if (!list) return;
  if (!state.items.length) {
    list.innerHTML = '<div class="admin-empty">No archived matches found for these filters.</div>';
    document.getElementById('admin-btn-more-archives').hidden = true;
    return;
  }
  const rows = state.items.map((item) => `
    <button type="button" class="admin-archive-item ${state.selectedId === item.id ? 'is-selected' : ''}"
      data-archive-id="${esc(item.id)}" aria-pressed="${state.selectedId === item.id}">
      <div>
        <div><strong class="font-mono">${esc(item.room_code)}</strong> · ${esc(item.schema_version ? `v${item.schema_version}` : '')} ${esc(fmtDateTime(item.closed_at))}</div>
        <div class="admin-archive-meta">
          Host: ${esc(item.host_name || item.host_user_id || '—')}
          · Reason: ${esc(item.close_reason || 'closed')}
          ${item.final_scores ? ` · <span class="font-mono">${esc(JSON.stringify(item.final_scores))}</span>` : ''}
        </div>
      </div>
      <span class="admin-badge">Inspect →</span>
    </button>`).join('');
  if (replace) list.innerHTML = rows;
  else list.insertAdjacentHTML('beforeend', rows);
  document.getElementById('admin-btn-more-archives').hidden = state.items.length >= (state.total ?? state.items.length);
}

async function inspectArchive(archiveId, itemButton) {
  state.selectedId = archiveId;
  listEl().querySelectorAll('.admin-archive-item').forEach((el) => {
    el.classList.toggle('is-selected', Number(el.dataset.archiveId) === Number(archiveId));
    el.setAttribute('aria-pressed', String(Number(el.dataset.archiveId) === Number(archiveId)));
  });
  detailEl().textContent = 'Loading snapshot…';
  try {
    const { item } = await adminRequest(`/api/versus/history/${encodeURIComponent(archiveId)}`);
    detailEl().textContent = JSON.stringify(item, null, 2);
    window.__adminSelectedArchive = item;
  } catch (error) {
    detailEl().textContent = `Failed to load snapshot: ${error.message}`;
  }
  itemButton?.classList.add('is-selected');
}

function downloadSelected() {
  const item = window.__adminSelectedArchive;
  if (!item) {
    showToast('Select an archived match first.', 'error');
    return;
  }
  const blob = new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `countdown-archive-${item.room_code || item.id}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function initArchives() {
  document.getElementById('admin-btn-reload-archives')?.addEventListener('click', () => loadArchives({ reset: true }));
  document.getElementById('admin-btn-apply-archive-filters')?.addEventListener('click', () => {
    const room = document.getElementById('admin-archives-room').value.toUpperCase().trim();
    state.filters = {
      room,
      from: document.getElementById('admin-archives-from').value,
      to: document.getElementById('admin-archives-to').value,
    };
    loadArchives({ reset: true });
  });
  document.getElementById('admin-btn-clear-archive-filters')?.addEventListener('click', () => {
    document.getElementById('admin-archives-room').value = '';
    document.getElementById('admin-archives-from').value = '';
    document.getElementById('admin-archives-to').value = '';
    state.filters = { room: '', from: '', to: '' };
    loadArchives({ reset: true });
  });
  document.getElementById('admin-btn-more-archives')?.addEventListener('click', () => {
    state.offset += PAGE_SIZE;
    loadArchives();
  });
  document.getElementById('admin-archives-list')?.addEventListener('click', (event) => {
    const itemButton = event.target.closest('button[data-archive-id]');
    if (itemButton) inspectArchive(itemButton.dataset.archiveId, itemButton);
  });
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.id = 'admin-btn-download-archive';
  downloadButton.className = 'btn btn--secondary btn--sm';
  downloadButton.textContent = '⬇ Download selected snapshot JSON';
  downloadButton.addEventListener('click', downloadSelected);
  document.getElementById('admin-archives-detail')?.insertAdjacentElement('beforebegin', downloadButton);
}

export function refreshArchives() { loadArchives({ reset: true }); }
