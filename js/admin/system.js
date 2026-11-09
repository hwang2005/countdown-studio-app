/**
 * @file js/admin/system.js
 * @module admin/system
 * System settings viewer: read-only safe configuration flags and SMTP test.
 * Secrets are never exposed; only boolean/derived flags are returned.
 */
import { adminRequest, esc } from './api.js';
import { showToast } from '../ui/toast.js';

const statusEl = () => document.getElementById('admin-system-status');
const errorEl = () => document.getElementById('admin-system-error');
const configGridEl = () => document.getElementById('admin-system-config-grid');

const CONFIG_LABELS = {
  adminRegistrationEnabled: 'Admin registration via bootstrap code',
  googleAuthEnabled: 'Google OAuth sign-in',
  googleClientIdConfigured: 'Google Client ID configured',
  mailConfigured: 'SMTP mail configured',
  cspMode: 'Content Security Policy mode',
  nodeEnv: 'Node environment',
  tokenTtlSeconds: 'Session token TTL (seconds)',
  resetLinkTtlMinutes: 'Password reset link TTL (minutes)',
  pinLockMaxAttempts: 'Host PIN lock max attempts',
  pinLockWindowMinutes: 'Host PIN lock window (minutes)',
};

function renderConfig(config) {
  const entries = Object.entries(config);
  if (!entries.length) {
    configGridEl().innerHTML = '<div class="admin-empty">No configuration data available.</div>';
    return;
  }
  configGridEl().innerHTML = entries.map(([key, value]) => `
    <div class="admin-detail-item">
      <div class="admin-detail-label">${esc(CONFIG_LABELS[key] || key)}</div>
      <div class="admin-detail-value font-mono">${esc(String(value))}</div>
    </div>`).join('');
}

async function loadConfig() {
  statusEl().textContent = 'Loading system configuration…';
  errorEl().textContent = '';
  configGridEl().innerHTML = '<div class="admin-empty">Loading…</div>';
  try {
    const { config } = await adminRequest('/api/admin/config');
    renderConfig(config);
    statusEl().textContent = `Configuration loaded at ${new Date().toLocaleTimeString()}.`;
  } catch (error) {
    statusEl().textContent = 'Configuration failed to load.';
    errorEl().textContent = error.message;
    configGridEl().innerHTML = `<div class="admin-empty">⚠ ${esc(error.message)}</div>`;
  }
}

async function testSmtp(event) {
  event.preventDefault();
  const errorEl = document.getElementById('admin-smtp-error');
  const successEl = document.getElementById('admin-smtp-success');
  errorEl.textContent = '';
  successEl.textContent = '';
  const to = document.getElementById('admin-smtp-to').value.trim();
  const submitButton = event.target.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    const data = await adminRequest('/api/admin/test-smtp', {
      method: 'POST',
      body: { to },
    });
    successEl.textContent = `Test email sent to ${esc(to)} (Message ID: ${esc(data.messageId || '—')}).`;
    showToast('SMTP test email sent.', 'success');
    event.target.reset();
  } catch (error) {
    errorEl.textContent = error.message;
    showToast(error.message, 'error');
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

export function initSystem() {
  document.getElementById('admin-btn-reload-config')?.addEventListener('click', loadConfig);
  document.getElementById('admin-form-smtp-test')?.addEventListener('submit', testSmtp);
  loadConfig();
}

export function refreshSystem() { loadConfig(); }
