import * as Nostr from "./nostr-stub";
import type { StorageLike } from "./nostr-persistence";
import type { IdentityEntry } from "./types";

export interface NativeImportBridge {
  importKey(privateKeyHex: string, expectedPublicKey: string): Promise<{ keyHandle: string; publicKey: string }>;
}

export function loadIdentityEntries(storage: StorageLike | null, identityKey: string, anonKey: string): IdentityEntry[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(identityKey) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      const identities = parsed.filter(isIdentityEntry).map(normalizeIdentity);
      if (identities.length) return identities;
    }
  } catch { /* try the legacy anonymous key */ }
  const legacy = storage.getItem(anonKey);
  if (!legacy || !/^[0-9a-f]{64}$/i.test(legacy)) return [];
  const publicKey = Nostr.getPublicKey(Nostr.hexToBytes(legacy));
  return [{ id: `anon-${publicKey.slice(0, 12)}`, publicKey, privKeyHex: legacy, label: "Local", type: "local", category: "local" }];
}

export function saveIdentityEntries(storage: StorageLike | null, identityKey: string, identities: IdentityEntry[]): void {
  if (!storage) return;
  storage.setItem(identityKey, JSON.stringify(identities));
}

export async function migrateIdentityStorage(
  storage: StorageLike,
  identityKey: string,
  anonKey: string,
  bridge: NativeImportBridge,
): Promise<IdentityEntry[]> {
  const existing = loadIdentityEntries(storage, identityKey, anonKey);
  const migrated: IdentityEntry[] = [];
  for (const identity of existing) {
    if (identity.keyHandle && identity.publicKey && !identity.privKeyHex) {
      migrated.push(identity);
      continue;
    }
    if (!identity.privKeyHex) throw new Error(`Identity ${identity.id} cannot be migrated because its private key is missing`);
    const expectedPublicKey = identity.publicKey ?? Nostr.getPublicKey(Nostr.hexToBytes(identity.privKeyHex));
    const material = await bridge.importKey(identity.privKeyHex, expectedPublicKey);
    if (material.publicKey.toLowerCase() !== expectedPublicKey.toLowerCase()) throw new Error(`Native migration public-key mismatch for ${identity.id}`);
    migrated.push({ ...identity, publicKey: material.publicKey.toLowerCase(), keyHandle: material.keyHandle, privKeyHex: undefined });
  }
  // Commit metadata and delete plaintext only after every import and verification succeeds.
  saveIdentityEntries(storage, identityKey, migrated);
  storage.removeItem(anonKey);
  return migrated;
}

function isIdentityEntry(value: unknown): value is IdentityEntry {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<IdentityEntry>;
  const hasProtected = typeof identity.publicKey === "string" && /^[0-9a-f]{64}$/i.test(identity.publicKey) && typeof identity.keyHandle === "string";
  const hasPlaintext = typeof identity.privKeyHex === "string" && /^[0-9a-f]{64}$/i.test(identity.privKeyHex);
  return typeof identity.id === "string" && typeof identity.label === "string" && (identity.type === "local" || identity.type === "nostr") && (hasProtected || hasPlaintext);
}

function normalizeIdentity(identity: IdentityEntry): IdentityEntry {
  const publicKey = identity.publicKey ?? (identity.privKeyHex ? Nostr.getPublicKey(Nostr.hexToBytes(identity.privKeyHex)) : undefined);
  const category = identity.category === "local" || identity.category === "nostr" ? identity.category : identity.type;
  return { ...identity, publicKey, category };
}
