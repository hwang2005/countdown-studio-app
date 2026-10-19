/**
 * Resolve the HTTP API independently from the page origin.
 *
 * Static deployments (for example GitHub Pages) cannot serve /api. They can
 * set window.__COUNTDOWN_API_URL__ or pass ?api=https://api.example.com.
 * Full-stack deployments keep the default and use the current origin.
 */
export function getApiBaseUrl(pageLocation = window.location) {
  const API_BASE_STORAGE_KEY = 'countdown_studio_api_base_url_v1';
  const pageUrl = new URL(pageLocation.href || pageLocation.toString(), pageLocation.origin);
  const queryEndpoint = new URLSearchParams(pageUrl.search).get('api');
  const buildEndpoint = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL;
  const configuredEndpoint = queryEndpoint
    || (typeof window !== 'undefined' && window.__COUNTDOWN_API_URL__)
    || buildEndpoint
    || (typeof localStorage !== 'undefined' && localStorage.getItem(API_BASE_STORAGE_KEY))
    || '';

  if (!String(configuredEndpoint).trim()) return '';

  const endpoint = new URL(String(configuredEndpoint).trim(), pageUrl.href);
  const baseUrl = endpoint.toString().replace(/\/$/, '');
  if (queryEndpoint && typeof localStorage !== 'undefined') {
    localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl);
  }
  return baseUrl;
}

export function apiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}

export function apiFetch(path, options) {
  return fetch(apiUrl(path), options);
}

/** Parse JSON while producing a useful error when a host returns an HTML page. */
export async function readApiJson(response) {
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      'API không trả về JSON. Hãy kiểm tra URL backend (tham số ?api= hoặc __COUNTDOWN_API_URL__).',
    );
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error('Phản hồi từ API không hợp lệ. Vui lòng kiểm tra máy chủ backend.');
  }
}
