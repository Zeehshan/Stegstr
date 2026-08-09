/**
 * Stegstr payload encryption: only the app can read; optionally restrict to selected pubkeys.
 * Outer layer: always AES-GCM with app-derived key. Inner: either raw JSON (any Stegstr user)
 * or recipients envelope (only listed pubkeys can decrypt inner payload).
 */

import * as Nostr from "./nostr-stub";

const STEGSTR_MAGIC = new TextEncoder().encode("STEGSTR1");
const VERSION = 1;
const APP_KEY_SALT = "stegstr-decrypt-v1";

let cachedAppKey: CryptoKey | null = null;

async function getAppKey(): Promise<CryptoKey> {
  if (cachedAppKey) return cachedAppKey;
  const msg = new TextEncoder().encode(APP_KEY_SALT);
  const hash = await crypto.subtle.digest("SHA-256", msg);
  cachedAppKey = await crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  return cachedAppKey;
}

/** Encrypt plaintext (JSON string) so only Stegstr can decrypt. Returns binary. */
export async function encryptApp(plaintext: string): Promise<Uint8Array> {
  const key = await getAppKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encoded
  );
  const out = new Uint8Array(STEGSTR_MAGIC.length + 1 + iv.length + ciphertext.byteLength);
  let off = 0;
  out.set(STEGSTR_MAGIC, off); off += STEGSTR_MAGIC.length;
  out[off++] = VERSION;
  out.set(iv, off); off += iv.length;
  out.set(new Uint8Array(ciphertext), off);
  console.log("[stego-crypto] encryptApp: plaintext len=", plaintext.length, "output len=", out.length);
  return out;
}

/** Decrypt app-encrypted payload. Returns inner plaintext string. */
export async function decryptApp(encrypted: Uint8Array): Promise<string> {
  console.log("[stego-crypto] decryptApp: encrypted len=", encrypted.length);
  if (encrypted.length < STEGSTR_MAGIC.length + 1 + 12 + 16) throw new Error("Payload too short");
  const magic = encrypted.slice(0, STEGSTR_MAGIC.length);
  if ([...magic].some((b, i) => b !== STEGSTR_MAGIC[i])) throw new Error("Invalid Stegstr encrypted payload");
  const version = encrypted[STEGSTR_MAGIC.length];
  console.log("[stego-crypto] decryptApp: version=", version);
  if (version !== VERSION) throw new Error("Unsupported encryption version");
  const iv = encrypted.slice(STEGSTR_MAGIC.length + 1, STEGSTR_MAGIC.length + 1 + 12);
  const ciphertext = encrypted.slice(STEGSTR_MAGIC.length + 1 + 12);
  console.log("[stego-crypto] decryptApp: ciphertext len=", ciphertext.length);
  const key = await getAppKey();
  try {
    const dec = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      ciphertext
    );
    console.log("[stego-crypto] decryptApp: SUCCESS, decrypted len=", dec.byteLength);
    return new TextDecoder().decode(dec);
  } catch (e) {
    console.error("[stego-crypto] decryptApp: AES-GCM decrypt FAILED:", e);
    throw e;
  }
}

/** Recipients envelope: inner payload encrypted with sym key K; K encrypted per recipient (NIP-04). s = sender pubkey. */
interface RecipientsEnvelope {
  t: "r";
  s: string;
  r: { p: string; k: string }[];
  c: string;
}

/** Encrypt for "any Stegstr user" (open). Returns binary to embed. */
export async function encryptOpen(jsonString: string): Promise<Uint8Array> {
  return encryptApp(jsonString);
}

/** Encrypt for selected pubkeys only. ourPrivKeyHex = sender; recipientPubkeys must include self to open later. */
export async function encryptForRecipients(
  jsonString: string,
  ourPrivKeyHex: string,
  recipientPubkeys: string[]
): Promise<Uint8Array> {
  const symKey = Nostr.generateSecretKey();
  const symKeyHex = Nostr.bytesToHex(symKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    symKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    new TextEncoder().encode(jsonString)
  );
  const ctWithIv = new Uint8Array(iv.length + ciphertext.byteLength);
  ctWithIv.set(iv, 0);
  ctWithIv.set(new Uint8Array(ciphertext), iv.length);
  const cBase64 = (() => {
    const chunk = 8192;
    let s = "";
    for (let i = 0; i < ctWithIv.length; i += chunk) {
      const sub = ctWithIv.subarray(i, Math.min(i + chunk, ctWithIv.length));
      s += String.fromCharCode.apply(null, Array.from(sub));
    }
    return btoa(s);
  })();

  const ourPubkey = Nostr.getPublicKey(Nostr.hexToBytes(ourPrivKeyHex));
  const r: { p: string; k: string }[] = [];
  for (const pk of recipientPubkeys) {
    const encK = await Nostr.nip04Encrypt(symKeyHex, ourPrivKeyHex, pk);
    r.push({ p: pk, k: encK });
  }

  const envelope: RecipientsEnvelope = { t: "r", s: ourPubkey, r, c: cBase64 };
  return encryptApp(JSON.stringify(envelope));
}

/** Decrypt embedded payload. Returns JSON string (bundle) or throws. ourPrivKeyHex = current user for recipients mode. */
export async function decryptPayload(
  encryptedBytes: Uint8Array,
  ourPrivKeyHex: string
): Promise<string> {
  const inner = await decryptApp(encryptedBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return inner;
  }
  if (typeof parsed === "object" && parsed !== null && "t" in parsed && (parsed as { t: string }).t === "r") {
    const env = parsed as RecipientsEnvelope;
    const ourPubkey = Nostr.getPublicKey(Nostr.hexToBytes(ourPrivKeyHex));
    const entry = env.r.find((x) => x.p === ourPubkey || x.p.toLowerCase() === ourPubkey.toLowerCase());
    if (!entry) throw new Error("You are not a recipient of this stego image");
    const senderPubkey = "s" in env ? env.s : entry.p;
    const symKeyHex = await Nostr.nip04Decrypt(entry.k, ourPrivKeyHex, senderPubkey);
    const ctWithIv = Uint8Array.from(atob(env.c), (c) => c.charCodeAt(0));
    const iv = ctWithIv.slice(0, 12);
    const ciphertext = ctWithIv.slice(12);
    const keyBytes = Nostr.hexToBytes(symKeyHex);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const dec = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      ciphertext
    );
    return new TextDecoder().decode(dec);
  }
  return inner;
}

/** True if bytes look like Stegstr encrypted (magic). */
export function isEncryptedPayload(bytes: Uint8Array): boolean {
  if (bytes.length < STEGSTR_MAGIC.length) return false;
  return STEGSTR_MAGIC.every((b, i) => bytes[i] === b);
}
