import { describe, expect, it } from "vitest";
import * as Nostr from "../nostr-stub";
import { calculateEventId, mergeNostrEvents, validateNostrEvent } from "../nostr-events";
import { loadCachedNostrState, saveCachedNostrState, type StorageLike } from "../nostr-persistence";
import type { NostrEvent } from "../types";

const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);

async function event(kind = 1, createdAt = 100, content = "hello", tags: string[][] = []): Promise<NostrEvent> {
  return Nostr.finishEventAsync({ kind, created_at: createdAt, content, tags }, secretKey);
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("Nostr event validation", () => {
  it("accepts a correctly hashed and signed event", async () => {
    const signed = await event();
    expect(calculateEventId(signed)).toBe(signed.id);
    expect(validateNostrEvent(signed, 1_000)).toEqual({ ok: true, event: signed });
  });

  it("rejects an invalid event ID", async () => {
    const signed = await event();
    expect(validateNostrEvent({ ...signed, id: "0".repeat(64) }, 1_000)).toMatchObject({ ok: false, error: "event id does not match serialized event" });
  });

  it("rejects an invalid signature", async () => {
    const signed = await event();
    expect(validateNostrEvent({ ...signed, sig: "0".repeat(128) }, 1_000)).toMatchObject({ ok: false, error: "invalid Schnorr signature" });
  });

  it("rejects malformed and resource-heavy structures", async () => {
    const signed = await event();
    expect(validateNostrEvent(null)).toMatchObject({ ok: false });
    expect(validateNostrEvent({ ...signed, content: "x".repeat(64_001) })).toMatchObject({ ok: false, error: "invalid content" });
    expect(validateNostrEvent({ ...signed, tags: Array.from({ length: 201 }, () => ["p", "x"]) })).toMatchObject({ ok: false, error: "invalid tags" });
  });
});

describe("deduplication and replaceable events", () => {
  it("stores one copy of an event received repeatedly", async () => {
    const signed = await event();
    expect(mergeNostrEvents([signed], [signed, signed])).toEqual([signed]);
  });

  it("keeps the newest replaceable event regardless of arrival order", async () => {
    const older = await event(0, 100, JSON.stringify({ name: "old" }));
    const newer = await event(0, 200, JSON.stringify({ name: "new" }));
    expect(mergeNostrEvents([newer], [older])).toEqual([newer]);
    expect(mergeNostrEvents([older], [newer])).toEqual([newer]);
  });

  it("separates parameterized replaceable events by d tag", async () => {
    const first = await event(30_001, 100, "a", [["d", "a"]]);
    const second = await event(30_001, 101, "b", [["d", "b"]]);
    expect(mergeNostrEvents([], [first, second])).toHaveLength(2);
  });
});

describe("bounded persistent event cache", () => {
  it("round-trips valid events and profiles while dropping invalid events", async () => {
    const storage = new MemoryStorage();
    const signed = await event(0, 100, JSON.stringify({ name: "Alice" }));
    saveCachedNostrState(storage, "cache", [signed], { [signed.pubkey]: { name: "Alice" } });
    const raw = JSON.parse(storage.getItem("cache")!);
    raw.events.push({ ...signed, id: "f".repeat(64) });
    storage.setItem("cache", JSON.stringify(raw));
    const restored = loadCachedNostrState(storage, "cache");
    expect(restored.events).toEqual([signed]);
    expect(restored.profiles[signed.pubkey]?.name).toBe("Alice");
  });
});
