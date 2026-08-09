import * as Nostr from "./nostr-stub";
import { isWeb } from "./platform-web";
import { getTauri } from "./platform-desktop";
import type { IdentityEntry, NostrEvent } from "./types";

export type EventTemplate = Pick<NostrEvent, "created_at" | "kind" | "tags" | "content">;
export type NativeIdentityMaterial = { keyHandle: string; publicKey: string };

export function identityPublicKey(identity: IdentityEntry): string {
  if (identity.publicKey && /^[0-9a-f]{64}$/i.test(identity.publicKey)) return identity.publicKey.toLowerCase();
  if (identity.privKeyHex && /^[0-9a-f]{64}$/i.test(identity.privKeyHex)) {
    return Nostr.getPublicKey(Nostr.hexToBytes(identity.privKeyHex));
  }
  throw new Error(`Identity ${identity.id} has no usable public key`);
}

export async function createIdentityMaterial(): Promise<Pick<IdentityEntry, "publicKey" | "keyHandle" | "privKeyHex">> {
  if (isWeb()) {
    const secret = Nostr.generateSecretKey();
    return { publicKey: Nostr.getPublicKey(secret), privKeyHex: Nostr.bytesToHex(secret) };
  }
  const { invoke } = await getTauri();
  return invoke<NativeIdentityMaterial>("native_key_create");
}

export async function importIdentityMaterial(privateKeyHex: string, expectedPublicKey?: string): Promise<Pick<IdentityEntry, "publicKey" | "keyHandle" | "privKeyHex">> {
  if (isWeb()) {
    const publicKey = Nostr.getPublicKey(Nostr.hexToBytes(privateKeyHex));
    if (expectedPublicKey && publicKey !== expectedPublicKey.toLowerCase()) throw new Error("Private key does not match expected public key");
    return { publicKey, privKeyHex: privateKeyHex.toLowerCase() };
  }
  const { invoke } = await getTauri();
  return invoke<NativeIdentityMaterial>("native_key_import", { privateKeyHex, expectedPublicKey });
}

export async function signEventWithIdentity(identity: IdentityEntry, event: EventTemplate): Promise<NostrEvent> {
  if (!isWeb()) {
    if (!identity.keyHandle) throw new Error("Native identity migration is incomplete");
    const { invoke } = await getTauri();
    return invoke<NostrEvent>("native_sign_event", { keyHandle: identity.keyHandle, event });
  }
  if (!identity.privKeyHex) throw new Error("Web identity has no private key");
  return Nostr.finishEventAsync(event, Nostr.hexToBytes(identity.privKeyHex));
}

export async function nip04EncryptWithIdentity(identity: IdentityEntry, recipientPublicKey: string, plaintext: string): Promise<string> {
  if (!isWeb()) {
    if (!identity.keyHandle) throw new Error("Native identity migration is incomplete");
    const { invoke } = await getTauri();
    return invoke<string>("native_nip04_encrypt", { keyHandle: identity.keyHandle, recipientPublicKey, plaintext });
  }
  if (!identity.privKeyHex) throw new Error("Web identity has no private key");
  return Nostr.nip04Encrypt(plaintext, identity.privKeyHex, recipientPublicKey);
}

export async function nip04DecryptWithIdentity(identity: IdentityEntry, senderPublicKey: string, payload: string): Promise<string> {
  if (!isWeb()) {
    if (!identity.keyHandle) throw new Error("Native identity migration is incomplete");
    const { invoke } = await getTauri();
    return invoke<string>("native_nip04_decrypt", { keyHandle: identity.keyHandle, senderPublicKey, payload });
  }
  if (!identity.privKeyHex) throw new Error("Web identity has no private key");
  return Nostr.nip04Decrypt(payload, identity.privKeyHex, senderPublicKey);
}

/** Explicit backup/export path only. Never call during startup, signing, or migration. */
export async function exportIdentitySecret(identity: IdentityEntry): Promise<string> {
  let privateKeyHex: string;
  if (!isWeb()) {
    if (!identity.keyHandle) throw new Error("Native identity migration is incomplete");
    const { invoke } = await getTauri();
    privateKeyHex = await invoke<string>("native_key_export", { keyHandle: identity.keyHandle });
  } else {
    if (!identity.privKeyHex) throw new Error("Web identity has no private key");
    privateKeyHex = identity.privKeyHex;
  }
  return Nostr.nip19.nsecEncode(Nostr.hexToBytes(privateKeyHex));
}
