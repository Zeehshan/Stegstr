/**
 * Browser-only platform: file picker, stego in JS, download. No Tauri, no network for stego.
 */

import { decodeDotImageFile, encodeDotImageFile } from "./stego-dot-web";

export function isWeb(): boolean {
  return typeof window !== "undefined" && !(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

function createFileInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      document.body.removeChild(input);
      resolve(file);
    };
    input.oncancel = () => {
      document.body.removeChild(input);
      resolve(null);
    };
    document.body.appendChild(input);
    input.click();
  });
}

/** Pick one image file (for detect or embed). */
export function pickImageFile(): Promise<File | null> {
  return createFileInput("image/png,image/jpeg,image/gif,image/webp,image/bmp");
}

/** Decode stego payload from file. Same result shape as Tauri decode_stego_image. */
export async function decodeStegoFile(file: File): Promise<{ ok: boolean; payload?: string; error?: string }> {
  try {
    console.log("[platform-web] decodeStegoFile: starting for", file.name, "size:", file.size, "type:", file.type);
    const result = await decodeDotImageFile(file);
    console.log("[platform-web] decodeStegoFile: result ok=", result.ok, "payloadLen=", result.payload?.length, "error=", result.error);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[platform-web] decodeStegoFile: exception:", e);
    return { ok: false, error: `Decode error: ${msg}` };
  }
}

/** Payload is either raw JSON string or "base64:..." (UTF-8 bytes for base64). */
function payloadStringToBytes(payload: string): Uint8Array {
  if (payload.startsWith("base64:")) {
    const b64 = payload.slice(7).trim();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(payload);
}

/** Encode image with payload; returns PNG blob. */
export async function encodeStegoToBlob(coverFile: File, payload: string): Promise<Blob> {
  try {
    const payloadBytes = payloadStringToBytes(payload);
    console.log("[platform-web] encodeStegoToBlob: coverFile=", coverFile.name, "size=", coverFile.size);
    console.log("[platform-web] encodeStegoToBlob: payload string len:", payload.length, "bytes len:", payloadBytes.length);
    const blob = await encodeDotImageFile(coverFile, payloadBytes);
    console.log("[platform-web] encodeStegoToBlob: success, blob size=", blob.size);
    return blob;
  } catch (e) {
    console.error("[platform-web] encodeStegoToBlob: exception:", e);
    throw e;
  }
}

/** Trigger download of a blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  try {
    console.log("[platform-web] downloadBlob: blob size=", blob.size, "filename=", filename);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "stegstr-embed.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Delay revoke to allow download to start
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log("[platform-web] downloadBlob: download triggered");
  } catch (e) {
    console.error("[platform-web] downloadBlob: error:", e);
    throw e;
  }
}
