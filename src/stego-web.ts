/**
 * DWT (Haar 2D) steganography in TypeScript for browser.
 * Same format as Rust: magic "STEGSTR" + 4-byte big-endian length + payload.
 * Embeds in LSB of LH coefficients. Tile-based (256x256) for crop survival.
 */

import { decodePngToRGBA } from "./png-decode";
import { encodeRGBAtoPNG } from "./png-encode";

const MAGIC = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x53, 0x54, 0x52]); // "STEGSTR"
const MAGIC_LEN = 7;
const LENGTH_BYTES = 4;
const TILE_SIZE = 256;
const DECODE_STEP = 128;

function bitsToBytes(bits: boolean[]): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8 && i + j < bits.length; j++) if (bits[i + j]) byte |= 1 << (7 - j);
    out.push(byte);
  }
  return new Uint8Array(out);
}

function ensureEvenDimensions(
  data: Uint8ClampedArray,
  w: number,
  h: number
): { data: Uint8ClampedArray; w: number; h: number } {
  const wEven = w % 2 === 0 ? w : Math.max(2, w - 1);
  const hEven = h % 2 === 0 ? h : Math.max(2, h - 1);
  if (wEven === w && hEven === h) return { data, w, h };
  const out = new Uint8ClampedArray(wEven * hEven * 4);
  for (let y = 0; y < hEven; y++)
    for (let x = 0; x < wEven; x++)
      for (let c = 0; c < 4; c++) out[(y * wEven + x) * 4 + c] = data[(y * w + x) * 4 + c];
  return { data: out, w: wEven, h: hEven };
}

function haar2dForward(
  img: Uint8ClampedArray,
  w: number,
  h: number,
  ch: number,
  stride: number
): { ll: Int32Array; lh: Int32Array; hl: Int32Array; hh: Int32Array } {
  const halfW = (w / 2) | 0;
  const halfH = (h / 2) | 0;
  const ll = new Int32Array(halfW * halfH);
  const lh = new Int32Array(halfW * halfH);
  const hl = new Int32Array(halfW * halfH);
  const hh = new Int32Array(halfW * halfH);
  for (let i = 0; i < halfH; i++) {
    for (let j = 0; j < halfW; j++) {
      const a = img[(i * 2 + 0) * stride + (j * 2 + 0) * 4 + ch];
      const b = img[(i * 2 + 0) * stride + (j * 2 + 1) * 4 + ch];
      const c = img[(i * 2 + 1) * stride + (j * 2 + 0) * 4 + ch];
      const d = img[(i * 2 + 1) * stride + (j * 2 + 1) * 4 + ch];
      const idx = i * halfW + j;
      ll[idx] = (a + b + c + d) / 4;
      lh[idx] = (b + d - a - c) / 4;
      hl[idx] = (c + d - a - b) / 4;
      hh[idx] = (b + c - a - d) / 4;
    }
  }
  return { ll, lh, hl, hh };
}

function haar2dInverse(
  out: Uint8ClampedArray,
  w: number,
  h: number,
  ch: number,
  stride: number,
  ll: Int32Array,
  lh: Int32Array,
  hl: Int32Array,
  hh: Int32Array
): void {
  const halfW = (w / 2) | 0;
  const halfH = (h / 2) | 0;
  for (let i = 0; i < halfH; i++) {
    for (let j = 0; j < halfW; j++) {
      const idx = i * halfW + j;
      const a = Math.max(0, Math.min(255, ll[idx] - lh[idx] - hl[idx] - hh[idx]));
      const b = Math.max(0, Math.min(255, ll[idx] + lh[idx] - hl[idx] + hh[idx]));
      const c = Math.max(0, Math.min(255, ll[idx] - lh[idx] + hl[idx] + hh[idx]));
      const d = Math.max(0, Math.min(255, ll[idx] + lh[idx] + hl[idx] - hh[idx]));
      out[(i * 2 + 0) * stride + (j * 2 + 0) * 4 + ch] = a;
      out[(i * 2 + 0) * stride + (j * 2 + 1) * 4 + ch] = b;
      out[(i * 2 + 1) * stride + (j * 2 + 0) * 4 + ch] = c;
      out[(i * 2 + 1) * stride + (j * 2 + 1) * 4 + ch] = d;
    }
  }
}

function embedInTile(
  raw: Uint8ClampedArray,
  tw: number,
  th: number,
  toEmbed: Uint8Array,
  stride: number
): void {
  const bitsNeeded = toEmbed.length * 8;
  const halfW = (tw / 2) | 0;
  const halfH = (th / 2) | 0;
  const blocksPerChannel = halfW * halfH;
  const bitsPerChannel = blocksPerChannel;
  for (let ch = 0; ch < 3; ch++) {
    const { ll, lh, hl, hh } = haar2dForward(raw, tw, th, ch, stride);
    const lhMod = new Int32Array(lh);
    for (let blockIdx = 0; blockIdx < blocksPerChannel; blockIdx++) {
      const globalIdx = ch * bitsPerChannel + blockIdx;
      if (globalIdx >= bitsNeeded) break;
      const byteIdx = (globalIdx / 8) | 0;
      const bitInByte = 7 - (globalIdx % 8);
      const bit = (toEmbed[byteIdx]! >> bitInByte) & 1;
      lhMod[blockIdx] = (lhMod[blockIdx]! & ~1) | bit;
    }
    haar2dInverse(raw, tw, th, ch, stride, ll, lhMod, hl, hh);
  }
}

function decodeFromTile(
  raw: Uint8ClampedArray,
  tw: number,
  th: number,
  stride: number
): Uint8Array | null {
  if (tw < 2 || th < 2) return null;
  const halfW = (tw / 2) | 0;
  const halfH = (th / 2) | 0;
  const blocksPerChannel = halfW * halfH;
  const totalBits = blocksPerChannel * 3;
  if (totalBits < 88) return null;
  const bits: boolean[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const { lh } = haar2dForward(raw, tw, th, ch, stride);
    for (let blockIdx = 0; blockIdx < blocksPerChannel; blockIdx++)
      bits.push((lh[blockIdx]! & 1) !== 0);
  }
  console.log("[stego-web] decodeFromTile: dims=", tw, "x", th);
  for (let start = 0; start <= bits.length - 88; start++) {
    const slice = bits.slice(start, start + MAGIC_LEN * 8);
    const bytes = bitsToBytes(slice);
    let match = true;
    for (let i = 0; i < MAGIC_LEN; i++) if (bytes[i] !== MAGIC[i]) { match = false; break; }
    if (!match) continue;
    console.log("[stego-web] decodeFromTile: MAGIC FOUND at offset", start);
    const lenSlice = bits.slice(
      start + MAGIC_LEN * 8,
      start + (MAGIC_LEN + LENGTH_BYTES) * 8
    );
    const lenBytes = bitsToBytes(lenSlice);
    const payloadLen =
      (lenBytes[0]! << 24) | (lenBytes[1]! << 16) | (lenBytes[2]! << 8) | lenBytes[3]!;
    const payloadEnd = start + (MAGIC_LEN + LENGTH_BYTES) * 8 + payloadLen * 8;
    if (payloadEnd > bits.length) continue;
    const payloadBits = bits.slice(
      start + (MAGIC_LEN + LENGTH_BYTES) * 8,
      payloadEnd
    );
    return bitsToBytes(payloadBits);
  }
  return null;
}

/** Build toEmbed = magic + 4-byte length (big-endian) + payload */
function buildToEmbed(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(MAGIC_LEN + LENGTH_BYTES + payload.length);
  out.set(MAGIC, 0);
  const len = payload.length;
  out[MAGIC_LEN] = (len >>> 24) & 0xff;
  out[MAGIC_LEN + 1] = (len >>> 16) & 0xff;
  out[MAGIC_LEN + 2] = (len >>> 8) & 0xff;
  out[MAGIC_LEN + 3] = len & 0xff;
  out.set(payload, MAGIC_LEN + LENGTH_BYTES);
  return out;
}

/**
 * Decode payload from RGBA image buffer (same layout as ImageData: row-major RGBA).
 * Returns payload bytes or null if not a Stegstr image.
 */
export function decodeStegoFromRGBA(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array | null {
  console.log("[stego-web] decodeStegoFromRGBA: input dims=", width, "x", height, "dataLen=", data.length);
  const { data: buf, w, h } = ensureEvenDimensions(data, width, height);
  console.log("[stego-web] decodeStegoFromRGBA: even dims=", w, "x", h);
  if (w < 2 || h < 2) return null;
  const stride = w * 4;

  // CRITICAL FIX: Try tiles FIRST if image is large enough.
  // This matches the embed logic which embeds into 256x256 tiles for large images.
  if (w >= TILE_SIZE && h >= TILE_SIZE) {
    console.log("[stego-web] decodeStegoFromRGBA: trying tile-based decode first");
    for (let oy = 0; oy <= h - TILE_SIZE; oy += DECODE_STEP) {
      for (let ox = 0; ox <= w - TILE_SIZE; ox += DECODE_STEP) {
        const tw = Math.min(TILE_SIZE, w - ox);
        const th = Math.min(TILE_SIZE, h - oy);
        const twEven = tw % 2 === 0 ? tw : tw - 1;
        const thEven = th % 2 === 0 ? th : th - 1;
        if (twEven < 2 || thEven < 2) continue;
        const tile = new Uint8ClampedArray(twEven * thEven * 4);
        for (let y = 0; y < thEven; y++) {
          const srcStart = (oy + y) * w * 4 + ox * 4;
          const row = buf.subarray(srcStart, srcStart + twEven * 4);
          tile.set(row, y * twEven * 4);
        }
        const payload = decodeFromTile(tile, twEven, thEven, twEven * 4);
        if (payload) {
          console.log("[stego-web] decodeStegoFromRGBA: found payload in tile at", ox, oy, "len=", payload.length);
          return payload;
        }
      }
    }
  }

  // Fallback: try full image (for small images that don't use tiles)
  console.log("[stego-web] decodeStegoFromRGBA: trying full image decode");
  const payload = decodeFromTile(buf, w, h, stride);
  if (payload) {
    console.log("[stego-web] decodeStegoFromRGBA: found payload in full image, len=", payload.length);
    return payload;
  }
  
  return null;
}

/**
 * Encode payload into a copy of the RGBA buffer. Modifies the copy in place; returns it.
 * Caller can then draw to canvas and export as PNG.
 * Returns { data, width, height } with possibly cropped even dimensions.
 */
export function encodeStegoIntoRGBA(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  payload: Uint8Array
): { data: Uint8ClampedArray; width: number; height: number } {
  const { data: buf, w, h } = ensureEvenDimensions(data, width, height);
  if (w < 2 || h < 2) throw new Error("Image too small");
  const raw = buf.slice(0);
  const stride = w * 4;
  const toEmbed = buildToEmbed(payload);
  const bitsNeeded = toEmbed.length * 8;
  console.log("[stego-web] Embed: dims=", w, "x", h, "payload=", payload.length, "bytes, toEmbed=", toEmbed.length, "bytes");

  let embeddedAny = false;
  for (let ty = 0; ty < h; ty += TILE_SIZE) {
    for (let tx = 0; tx < w; tx += TILE_SIZE) {
      let tw = Math.min(TILE_SIZE, w - tx);
      let th = Math.min(TILE_SIZE, h - ty);
      let twEven = tw % 2 === 0 ? tw : tw - 1;
      let thEven = th % 2 === 0 ? th : th - 1;
      if (twEven < 2 || thEven < 2) continue;
      const capacity = ((twEven / 2) | 0) * ((thEven / 2) | 0) * 3;
      if (capacity < bitsNeeded) continue;
      const tile = new Uint8ClampedArray(twEven * thEven * 4);
      for (let y = 0; y < thEven; y++) {
        const srcStart = (ty + y) * w * 4 + tx * 4;
        tile.set(raw.subarray(srcStart, srcStart + twEven * 4), y * twEven * 4);
      }
      embedInTile(tile, twEven, thEven, toEmbed, twEven * 4);
      for (let y = 0; y < thEven; y++) {
        const row = tile.subarray(y * twEven * 4, (y + 1) * twEven * 4);
        raw.set(row, (ty + y) * w * 4 + tx * 4);
      }
      embeddedAny = true;
    }
  }

  if (!embeddedAny) {
    const halfW = (w / 2) | 0;
    const halfH = (h / 2) | 0;
    const totalBitsAvailable = halfW * halfH * 3;
    if (bitsNeeded > totalBitsAvailable)
      throw new Error(
        `Payload too large: need ${bitsNeeded} bits, image has ${totalBitsAvailable}`
      );
    embedInTile(raw, w, h, toEmbed, stride);
  }

  // CRITICAL: Immediate round-trip test to verify DWT embed/decode works
  const testDecode = decodeStegoFromRGBA(raw, w, h);
  if (!testDecode) {
    console.error("[stego-web] CRITICAL BUG: Embed succeeded but immediate decode failed! DWT is broken.");
  } else {
    console.log("[stego-web] Immediate decode OK, len:", testDecode.length);
    // Verify the payload matches what we embedded
    const payloadMatch = payload.length === testDecode.length && payload.every((b, i) => b === testDecode[i]);
    console.log("[stego-web] Payload match:", payloadMatch ? "SUCCESS" : "FAIL");
  }

  return { data: raw, width: w, height: h };
}

/** Load image file to ImageData (RGBA). */
export async function fileToImageData(file: File): Promise<{ data: ImageData; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await createImageBitmap(file);
    const w = img.width;
    const h = img.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2d not available");
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    img.close();
    return { data: imageData, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Encode image file with payload; return PNG blob with exact pixel values. */
export async function encodeImageFile(
  coverFile: File,
  payload: Uint8Array
): Promise<Blob> {
  const { data, width, height } = await fileToImageData(coverFile);
  console.log("[stego-web] encodeImageFile: cover dims=", width, "x", height);
  const result = encodeStegoIntoRGBA(data.data, width, height, payload);
  console.log("[stego-web] encodeImageFile: output dims=", result.width, "x", result.height);
  // Use raw PNG encoder to preserve exact pixel values (DWT steganography)
  const pngBytes = encodeRGBAtoPNG(result.data, result.width, result.height);
  console.log("[stego-web] encodeImageFile: PNG bytes=", pngBytes.length);

  // CRITICAL: Test PNG round-trip to verify encoder/decoder preserve pixels
  const pngDecoded = decodePngToRGBA(pngBytes.buffer);
  console.log("[stego-web] PNG round-trip: decoded dims=", pngDecoded.width, "x", pngDecoded.height);
  let pixelDiffs = 0;
  for (let i = 0; i < result.data.length && i < pngDecoded.data.length; i++) {
    if (result.data[i] !== pngDecoded.data[i]) pixelDiffs++;
  }
  console.log("[stego-web] PNG round-trip: pixel differences=", pixelDiffs, "/", result.data.length);
  if (pixelDiffs > 0) {
    console.error("[stego-web] CRITICAL BUG: PNG encoder/decoder is corrupting pixels!");
  }

  // Test stego decode from PNG-decoded data
  const pngStegoTest = decodeStegoFromRGBA(pngDecoded.data, pngDecoded.width, pngDecoded.height);
  if (!pngStegoTest) {
    console.error("[stego-web] CRITICAL BUG: Stego decode failed after PNG round-trip!");
  } else {
    const pngPayloadMatch = payload.length === pngStegoTest.length && payload.every((b, i) => b === pngStegoTest[i]);
    console.log("[stego-web] PNG stego test: payload match=", pngPayloadMatch ? "SUCCESS" : "FAIL");
  }

  return new Blob([pngBytes], { type: "image/png" });
}

/**
 * Test the full encode/decode round-trip to verify PNG encoder/decoder preserve exact pixels.
 * Call this from browser console: import('./stego-web').then(m => m.testRoundTrip())
 */
export async function testRoundTrip(): Promise<void> {
  console.log("=== STEGO ROUND-TRIP TEST ===");
  
  // Create a small test image (100x100 solid color with some variation)
  const w = 100, h = 100;
  const testData = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    testData[i * 4 + 0] = (i * 17) & 0xff;     // R
    testData[i * 4 + 1] = (i * 31) & 0xff;     // G
    testData[i * 4 + 2] = (i * 47) & 0xff;     // B
    testData[i * 4 + 3] = 255;                  // A
  }
  
  // Test payload
  const testPayload = new TextEncoder().encode('{"test":"hello world from stegstr"}');
  console.log("Test payload:", testPayload.length, "bytes");
  
  // Encode
  const encoded = encodeStegoIntoRGBA(testData, w, h, testPayload);
  console.log("Encoded dims:", encoded.width, "x", encoded.height, "dataLen:", encoded.data.length);
  
  // PNG round-trip
  const pngBytes = encodeRGBAtoPNG(encoded.data, encoded.width, encoded.height);
  console.log("PNG encoded:", pngBytes.length, "bytes");
  
  // Decode PNG (use the static import)
  const decoded = decodePngToRGBA(pngBytes.buffer);
  console.log("PNG decoded dims:", decoded.width, "x", decoded.height, "dataLen:", decoded.data.length);
  
  // Compare pixel data
  let diffs = 0;
  for (let i = 0; i < encoded.data.length && i < decoded.data.length; i++) {
    if (encoded.data[i] !== decoded.data[i]) {
      if (diffs < 10) console.log("Pixel diff at", i, ":", encoded.data[i], "vs", decoded.data[i]);
      diffs++;
    }
  }
  console.log("Total pixel differences:", diffs, "/", encoded.data.length);
  
  // Decode stego
  const stegoPayload = decodeStegoFromRGBA(decoded.data, decoded.width, decoded.height);
  if (!stegoPayload) {
    console.error("FAIL: Could not decode stego payload!");
    return;
  }
  console.log("Decoded stego payload:", stegoPayload.length, "bytes");
  
  // Compare payloads
  const match = testPayload.length === stegoPayload.length && 
    testPayload.every((b, i) => b === stegoPayload[i]);
  console.log("Payload match:", match ? "SUCCESS" : "FAIL");
  console.log("=== TEST COMPLETE ===");
}

/** Decode payload from image file. Returns payload as string (UTF-8) or base64 prefix. */
export async function decodeImageFile(file: File): Promise<{ ok: boolean; payload?: string; error?: string }> {
  try {
    let data: Uint8ClampedArray;
    let width: number;
    let height: number;
    const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
    console.log("[stego-web] decodeImageFile: file=", file.name, "type=", file.type, "isPng=", isPng);
    if (isPng) {
      const buf = await file.arrayBuffer();
      console.log("[stego-web] decodeImageFile: raw PNG bytes=", buf.byteLength);
      const decoded = decodePngToRGBA(buf);
      data = decoded.data;
      width = decoded.width;
      height = decoded.height;
      console.log("[stego-web] decodeImageFile: decoded PNG dims=", width, "x", height, "dataLen=", data.length);
    } else {
      const imageData = await fileToImageData(file);
      data = imageData.data.data;
      width = imageData.width;
      height = imageData.height;
      console.log("[stego-web] decodeImageFile: canvas dims=", width, "x", height);
    }
    const payload = decodeStegoFromRGBA(data, width, height);
    if (!payload || payload.length === 0) {
      console.log("[stego-web] decodeImageFile: NO PAYLOAD FOUND");
      return { ok: false, error: "Not a Stegstr image (magic not found)" };
    }
    console.log("[stego-web] decodeImageFile: payload found, len=", payload.length);
    const trimStart = (s: string) => s.replace(/^\s+/, "");
    const asUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(payload);
    if (trimStart(asUtf8).startsWith("{")) {
      return { ok: true, payload: asUtf8 };
    }
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.subarray(i, Math.min(i + chunkSize, payload.length));
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return {
      ok: true,
      payload: "base64:" + btoa(binary),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
