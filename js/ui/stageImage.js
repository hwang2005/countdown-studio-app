/**
 * @file js/ui/stageImage.js
 * Client-side compression for custom Stage Display background images so they fit
 * cleanly inside WebSocket payload limits (MAX_STAGE_BACKGROUND_BYTES = 700 KB)
 * and browser localStorage quotas.
 */

const DEFAULT_MAX_BYTES = 550 * 1024;
const QUALITIES = [0.85, 0.72, 0.58, 0.45, 0.35];

function utf8ByteLength(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return str.length * 2;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected image file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Selected file could not be decoded as an image.'));
    img.src = src;
  });
}

function encodeScaled(img, maxWidth, maxHeight, mimeType, quality) {
  const srcW = img.naturalWidth || img.width || maxWidth;
  const srcH = img.naturalHeight || img.height || maxHeight;
  const scale = Math.min(1, maxWidth / Math.max(1, srcW), maxHeight / Math.max(1, srcH));
  const targetW = Math.max(1, Math.round(srcW * scale));
  const targetH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable for image compression.');
  }
  ctx.fillStyle = '#050D24';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return canvas.toDataURL(mimeType, quality);
}

function supportsWebpEncode() {
  try {
    const probe = document.createElement('canvas');
    probe.width = 2;
    probe.height = 2;
    return probe.toDataURL('image/webp', 0.8).startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/**
 * Compresses a user-selected background image file into a data URL under `maxBytes`.
 * @param {File} file
 * @param {{ maxWidth?: number, maxHeight?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ dataUrl: string, byteSize: number }>}
 */
export async function compressStageBackgroundFile(file, options = {}) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('Please select a valid image file.');
  }

  const maxWidth = options.maxWidth || 1920;
  const maxHeight = options.maxHeight || 1080;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;

  const rawDataUrl = await readFileAsDataUrl(file);
  const rawBytes = utf8ByteLength(rawDataUrl);

  if (file.type === 'image/svg+xml' && rawBytes <= maxBytes) {
    return { dataUrl: rawDataUrl, byteSize: rawBytes };
  }

  if (rawBytes <= maxBytes && file.type !== 'image/png') {
    // Still ensure oversized pixel dimensions don't hurt GPU memory, unless small enough already
    const img = await loadImage(rawDataUrl);
    if ((img.naturalWidth || 0) <= maxWidth && (img.naturalHeight || 0) <= maxHeight) {
      return { dataUrl: rawDataUrl, byteSize: rawBytes };
    }
  }

  const img = await loadImage(rawDataUrl);
  const mimeType = supportsWebpEncode() ? 'image/webp' : 'image/jpeg';

  const dimensionsToTry = [
    [maxWidth, maxHeight],
    [1280, 720],
  ];

  for (const [w, h] of dimensionsToTry) {
    for (const q of QUALITIES) {
      const candidate = encodeScaled(img, w, h, mimeType, q);
      const byteSize = utf8ByteLength(candidate);
      if (byteSize <= maxBytes) {
        return { dataUrl: candidate, byteSize };
      }
    }
  }

  throw new Error(
    `Image is too large even after compression (exceeds ${Math.round(maxBytes / 1024)} KB). Please choose a simpler image.`
  );
}
