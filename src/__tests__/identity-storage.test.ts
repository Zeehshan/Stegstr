import { describe, expect, it, vi } from "vitest";
import * as Nostr from "../nostr-stub";
import { identityPublicKey, signEventWithIdentity } from "../identity-crypto";
import { loadIdentityEntries, migrateIdentityStorage } from "../identity-storage";
import type { StorageLike } from "../nostr-persistence";
import type { IdentityEntry } from "../types";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function legacyIdentity(value = 7): IdentityEntry {
  const secret = new Uint8Array(32); secret[31] = value;
  const privKeyHex = Nostr.bytesToHex(secret);
  return {
    id: `local-${value}`,
    publicKey: Nostr.getPublicKey(secret),
    privKeyHex,
    label: "Legacy",
    type: "local",
    category: "local",
  };
}

describe("native identity migration", () => {
  it("imports once, verifies the public key, and removes plaintext storage", async () => {
    const storage = new MemoryStorage();
    const legacy = legacyIdentity();
    storage.setItem("identities", JSON.stringify([legacy]));
    storage.setItem("anon", legacy.privKeyHex!);
    const importKey = vi.fn(async (_secret: string, publicKey: string) => ({ keyHandle: `nostr-${publicKey}`, publicKey }));
    const migrated = await migrateIdentityStorage(storage, "identities", "anon", { importKey });
    expect(importKey).toHaveBeenCalledOnce();
    expect(migrated[0]).toMatchObject({ publicKey: legacy.publicKey, keyHandle: `nostr-${legacy.publicKey}` });
    expect(migrated[0].privKeyHex).toBeUndefined();
    expect(storage.getItem("identities")).not.toContain(legacy.privKeyHex);
    expect(storage.getItem("anon")).toBeNull();
  });

  it("keeps plaintext intact on mismatch and succeeds on retry", async () => {
    const storage = new MemoryStorage();
    const legacy = legacyIdentity(8);
    const original = JSON.stringify([legacy]);
    storage.setItem("identities", original);
    await expect(migrateIdentityStorage(storage, "identities", "anon", {
      importKey: async () => ({ keyHandle: "nostr-bad", publicKey: "0".repeat(64) }),
    })).rejects.toThrow("public-key mismatch");
    expect(storage.getItem("identities")).toBe(original);
    const migrated = await migrateIdentityStorage(storage, "identities", "anon", {
      importKey: async (_secret, publicKey) => ({ keyHandle: `nostr-${publicKey}`, publicKey }),
    });
    expect(migrated[0].privKeyHex).toBeUndefined();
  });

  it("is idempotent for protected metadata and persists across reload", async () => {
    const storage = new MemoryStorage();
    const publicKey = "a".repeat(64);
    const secure: IdentityEntry = { id: "native", publicKey, keyHandle: `nostr-${publicKey}`, label: "Native", type: "nostr", category: "nostr" };
    storage.setItem("identities", JSON.stringify([secure]));
    const importKey = vi.fn();
    await migrateIdentityStorage(storage, "identities", "anon", { importKey });
    expect(importKey).not.toHaveBeenCalled();
    expect(loadIdentityEntries(storage, "identities", "anon")).toEqual([secure]);
  });
});

describe("web identity fallback", () => {
  it("retains browser key behavior and produces a valid signed event", async () => {
    const identity = legacyIdentity(9);
    expect(identityPublicKey(identity)).toBe(identity.publicKey);
    const event = await signEventWithIdentity(identity, { kind: 1, content: "web", tags: [], created_at: 123 });
    expect(event.pubkey).toBe(identity.publicKey);
    expect(event.sig).toHaveLength(128);
  });
});
