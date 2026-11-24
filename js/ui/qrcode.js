/**
 * @file js/ui/qrcode.js
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, Error Correction Level M, Versions 1-12)
 * and HTML5 <canvas> renderer for remote Stage Display links.
 */

// GF(256) log/exp tables with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = val;
    GF_LOG[val] = i;
    val <<= 1;
    if (val & 0x100) val ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(ecCount) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEc(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// EC Level M specifications for Versions 1..12:
// [totalCodewords, ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
const VERSION_SPECS_M = [
  null,
  [26, 10, 1, 16, 0, 0],   // V1 (21x21)
  [44, 16, 1, 28, 0, 0],   // V2 (25x25)
  [70, 26, 1, 44, 0, 0],   // V3 (29x29)
  [100, 18, 2, 32, 0, 0],  // V4 (33x33)
  [134, 24, 2, 43, 0, 0],  // V5 (37x37)
  [172, 16, 4, 27, 0, 0],  // V6 (41x41)
  [196, 18, 4, 31, 0, 0],  // V7 (45x45)
  [242, 22, 2, 38, 2, 39], // V8 (49x49)
  [292, 22, 3, 36, 2, 37], // V9 (53x53)
  [346, 26, 4, 43, 1, 44], // V10 (57x57)
  [404, 30, 1, 50, 4, 51], // V11 (61x61)
  [466, 22, 6, 36, 2, 37], // V12 (65x65)
];

const ALIGNMENT_CENTERS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
];

function bchDigitCount(value) {
  let d = 0;
  while (value !== 0) {
    d += 1;
    value >>>= 1;
  }
  return d;
}

function encodeFormatInfoM(maskId) {
  // Format data = (EC_M=00 << 3) | maskId
  const data = maskId & 0x7;
  let d = data << 10;
  const g = 0x537;
  while (bchDigitCount(d) - bchDigitCount(g) >= 0) {
    d ^= g << (bchDigitCount(d) - bchDigitCount(g));
  }
  return ((data << 10) | d) ^ 0x5412;
}

function encodeVersionInfo(version) {
  let d = version << 12;
  const g = 0x1f25;
  while (bchDigitCount(d) - bchDigitCount(g) >= 0) {
    d ^= g << (bchDigitCount(d) - bchDigitCount(g));
  }
  return (version << 12) | d;
}

function selectVersionForBytes(byteLength) {
  for (let v = 1; v < VERSION_SPECS_M.length; v++) {
    const [, , g1b, g1d, g2b, g2d] = VERSION_SPECS_M[v];
    const totalDataBytes = g1b * g1d + g2b * g2d;
    const countBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= totalDataBytes * 8) {
      return v;
    }
  }
  throw new Error(`QR payload (${byteLength} bytes) exceeds Version 12 capacity.`);
}

function buildCodewords(bytes, version) {
  const [, ecPerBlock, g1b, g1d, g2b, g2d] = VERSION_SPECS_M[version];
  const totalDataBytes = g1b * g1d + g2b * g2d;
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, countBits);
  for (const b of bytes) {
    pushBits(b, 8);
  }

  const maxBits = totalDataBytes * 8;
  const terminatorLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(totalDataBytes);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | bits[i + b];
    }
    dataBytes[byteIdx++] = val;
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (byteIdx < totalDataBytes) {
    dataBytes[byteIdx++] = padBytes[padIdx];
    padIdx ^= 1;
  }

  // Split into RS blocks and interleave
  const blocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < g1b; i++) {
    const slice = dataBytes.slice(offset, offset + g1d);
    offset += g1d;
    blocks.push(slice);
    ecBlocks.push(rsComputeEc(slice, ecPerBlock));
  }
  for (let i = 0; i < g2b; i++) {
    const slice = dataBytes.slice(offset, offset + g2d);
    offset += g2d;
    blocks.push(slice);
    ecBlocks.push(rsComputeEc(slice, ecPerBlock));
  }

  const result = [];
  const maxDataLen = Math.max(g1d, g2d);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      result.push(ec[i]);
    }
  }
  return Uint8Array.from(result);
}

function createBaseMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    reserved[r][c] = 1;
  };

  const placeFinder = (row, col) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inCenter));
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (!reserved[6][i]) setFunctionModule(6, i, dark);
    if (!reserved[i][6]) setFunctionModule(i, 6, dark);
  }

  // Dark module
  setFunctionModule(4 * version + 9, 8, true);

  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version] || [];
  for (const rCenter of centers) {
    for (const cCenter of centers) {
      if (reserved[rCenter][cCenter]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setFunctionModule(rCenter + dr, cCenter + dc, dark);
        }
      }
    }
  }

  // Reserve format info slots
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = 1;
  }
  for (let i = size - 7; i < size; i++) {
    reserved[i][8] = 1;
  }

  // Version info for v7+
  if (version >= 7) {
    const verBits = encodeVersionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = (verBits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunctionModule(a, b, bit === 1);
      setFunctionModule(b, a, bit === 1);
    }
  }

  return { size, modules, reserved };
}

function maskCondition(maskId, r, c) {
  switch (maskId) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function applyDataAndMask(size, baseModules, reserved, codewords, maskId) {
  const modules = baseModules.map((row) => new Uint8Array(row));

  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        modules[r][c] = maskCondition(maskId, r, c) ? (bit ^ 1) : bit;
      }
    }
    upward = !upward;
  }

  const fmt = encodeFormatInfoM(maskId);
  for (let i = 0; i <= 5; i++) {
    const bit = (fmt >>> i) & 1;
    modules[8][i] = bit;
    modules[size - 1 - i][8] = bit;
  }
  modules[8][7] = (fmt >>> 6) & 1;
  modules[size - 7][8] = (fmt >>> 6) & 1;
  modules[8][8] = (fmt >>> 7) & 1;
  modules[8][size - 8] = (fmt >>> 7) & 1;
  modules[7][8] = (fmt >>> 8) & 1;
  modules[8][size - 7] = (fmt >>> 8) & 1;
  for (let i = 9; i < 15; i++) {
    const bit = (fmt >>> i) & 1;
    modules[14 - i][8] = bit;
    modules[8][size - 15 + i] = bit;
  }

  return modules;
}

function computePenaltyScore(modules, size) {
  let score = 0;

  // Rule 1: 5+ consecutive same-color modules in row/column
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns
  const matchPattern = (arr, start, pat) => {
    for (let i = 0; i < pat.length; i++) {
      if (arr[start + i] !== pat[i]) return false;
    }
    return true;
  };
  const pA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matchPattern(modules[r], c, pA) || matchPattern(modules[r], c, pB)) score += 40;
    }
  }
  const colArr = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) colArr[r] = modules[r][c];
    for (let r = 0; r <= size - 11; r++) {
      if (matchPattern(colArr, r, pA) || matchPattern(colArr, r, pB)) score += 40;
    }
  }

  // Rule 4: Balance of dark modules
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      darkCount += modules[r][c];
    }
  }
  const percent = (darkCount * 100) / (size * size);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  score += k * 10;

  return score;
}

/**
 * Encodes UTF-8 text into a scannable QR code matrix (Error Correction Level M).
 * @param {string} text
 * @returns {{ size: number, version: number, modules: boolean[][] }}
 */
export function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const version = selectVersionForBytes(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const { size, modules: baseModules, reserved } = createBaseMatrix(version);

  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = null;

  for (let maskId = 0; maskId < 8; maskId++) {
    const candidate = applyDataAndMask(size, baseModules, reserved, codewords, maskId);
    const penalty = computePenaltyScore(candidate, size);
    if (penalty < bestScore) {
      bestScore = penalty;
      bestMask = maskId;
      bestModules = candidate;
    }
  }

  return {
    size,
    version,
    maskId: bestMask,
    modules: bestModules.map((row) => Array.from(row, (v) => v === 1)),
  };
}

/**
 * Draws a QR code onto an HTML5 <canvas> element with crisp integer module alignment.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {{ width?: number, margin?: number, dark?: string, light?: string }} [options]
 */
export function drawQrCodeToCanvas(canvas, text, options = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;

  const {
    width = 200,
    margin = 2,
    dark = '#030712',
    light = '#FFFFFF',
  } = options;

  try {
    const { size, modules } = encodeQrMatrix(text);
    const totalModules = size + margin * 2;
    const scale = Math.max(1, Math.floor(width / totalModules));
    const renderSize = totalModules * scale;

    canvas.width = width;
    canvas.height = width;
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, width, width);

    const offset = Math.floor((width - renderSize) / 2);
    ctx.fillStyle = dark;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) {
          ctx.fillRect(offset + (c + margin) * scale, offset + (r + margin) * scale, scale, scale);
        }
      }
    }
  } catch (err) {
    console.warn('[QRCode] Failed to render QR matrix:', err);
    canvas.width = width;
    canvas.height = width;
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, width, width);
    ctx.fillStyle = dark;
    ctx.font = '600 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('URL too long for QR', width / 2, width / 2);
  }
}
