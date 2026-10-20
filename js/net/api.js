/**
 * Resolve the HTTP API independently from the page origin.
 *
 * Static deployments (for example GitHub Pages) cannot serve /api. They can
 * set window.__COUNTDOWN_API_URL__ or pass ?api=https://api.example.com.
 * Full-stack deployments keep the default and use the current origin.
 */
export function isTrustedApiEndpoint(urlString, pageUrl) {
  if (!urlString) return false;
  try {
    const target = new URL(urlString, pageUrl.href);
    if (target.origin === pageUrl.origin) return true;
    const hostname = target.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    if (hostname === 'countdown-studio.id.vn' || hostname === 'www.countdown-studio.id.vn') return true;
    if (hostname === 'countdown-studio-app.onrender.com') return true;
    return false;
  } catch {
    return false;
  }
}

export function getApiBaseUrl(pageLocation = window.location) {
  const API_BASE_STORAGE_KEY = 'countdown_studio_api_base_url_v1';
  const pageUrl = new URL(pageLocation.href || pageLocation.toString(), pageLocation.origin);
  const rawQueryEndpoint = new URLSearchParams(pageUrl.search).get('api');
  const buildEndpoint = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL;
  const globalEndpoint = typeof window !== 'undefined' && window.__COUNTDOWN_API_URL__;
  const storedEndpoint = typeof localStorage !== 'undefined' && localStorage.getItem(API_BASE_STORAGE_KEY);

  // Validate query parameter to prevent phishing credential theft (CWE-20 / open endpoint injection)
  const queryEndpoint = rawQueryEndpoint && isTrustedApiEndpoint(rawQueryEndpoint, pageUrl) ? rawQueryEndpoint : '';

  // Validate stored endpoint; clear if suspicious
  let validStoredEndpoint = '';
  if (storedEndpoint) {
    if (isTrustedApiEndpoint(storedEndpoint, pageUrl)) {
      validStoredEndpoint = storedEndpoint;
    } else if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(API_BASE_STORAGE_KEY);
    }
  }

  const configuredEndpoint = queryEndpoint
    || (globalEndpoint && isTrustedApiEndpoint(globalEndpoint, pageUrl) ? globalEndpoint : '')
    || (buildEndpoint && isTrustedApiEndpoint(buildEndpoint, pageUrl) ? buildEndpoint : '')
    || validStoredEndpoint
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
      'API did not return JSON. Please check the backend URL (?api= parameter or __COUNTDOWN_API_URL__).',
    );
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error('Invalid response from API. Please check the backend server.');
  }
}
