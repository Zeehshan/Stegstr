import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Nostr from "../nostr-stub";
import { DEFAULT_RELAYS, getRelayUrls, normalizeRelayUrl, queueEventForOutbox, RelayManager } from "../relay";
import type { StorageLike } from "../nostr-persistence";
import type { NostrEvent } from "../types";

const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 2 : 0);

async function signedEvent(content = "hello"): Promise<NostrEvent> {
  return Nostr.finishEventAsync({ kind: 1, created_at: 100, content, tags: [] }, secretKey);
}

class MockSocket {
  readyState = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
  fail() { this.onerror?.(new Error("mock error")); }
  close() { const callback = this.onclose; this.readyState = 3; callback?.(); }
  sentMessages() { return this.sent.map((value) => JSON.parse(value)); }
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class MockOnlineTarget {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = listener as () => void;
    const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) { this.listeners.get(type)?.delete(listener as () => void); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
}

function harness(relays = ["wss://one.test"], storage: StorageLike | null = null) {
  const sockets: MockSocket[] = [];
  const events: NostrEvent[] = [];
  const manager = new RelayManager(relays, ["1".repeat(64)], (event) => events.push(event), undefined, undefined, {
    websocketFactory: (url) => { const socket = new MockSocket(url); sockets.push(socket); return socket; },
    storage,
    storageKey: "outbox",
    connectionTimeoutMs: 100,
    ackTimeoutMs: 100,
    baseRetryMs: 1_000,
    maxRetryMs: 8_000,
    stableConnectionMs: 5_000,
    random: () => 0.5,
    onlineTarget: null,
    isOnline: () => true,
  });
  manager.start();
  return { manager, sockets, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("relay configuration", () => {
  it("filters remote relay configuration before use", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ relays: [" WSS://Relay.Example/ ", "https://invalid.test", "wss://user:secret@bad.test"] }),
    }));
    await expect(getRelayUrls()).resolves.toEqual(["wss://relay.example"]);
  });

  it("falls back to defaults when both configuration endpoints fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(getRelayUrls()).resolves.toEqual(DEFAULT_RELAYS);
  });
});

describe("RelayManager connection lifecycle", () => {
  it("preserves the browser receiver for default timeout scheduling", () => {
    const delegatedSetTimeout = globalThis.setTimeout.bind(globalThis);
    const delegatedClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const receiverSensitiveSetTimeout = function (
      this: unknown,
      callback: (...args: unknown[]) => void,
      delay?: number,
    ) {
      if (this !== globalThis) throw new TypeError("Can only call Window.setTimeout on instances of Window");
      return delegatedSetTimeout(callback, delay);
    } as typeof setTimeout;
    const receiverSensitiveClearTimeout = function (this: unknown, timer: ReturnType<typeof setTimeout>) {
      if (this !== globalThis) throw new TypeError("Can only call Window.clearTimeout on instances of Window");
      return delegatedClearTimeout(timer);
    } as typeof clearTimeout;
    vi.stubGlobal("setTimeout", receiverSensitiveSetTimeout);
    vi.stubGlobal("clearTimeout", receiverSensitiveClearTimeout);

    const { manager } = harness();
    expect(manager.snapshot().relays[0].state).toBe("Connecting");
    expect(() => manager.close()).not.toThrow();
  });

  it("accepts only normalized WebSocket relay URLs", () => {
    expect(normalizeRelayUrl(" WSS://Relay.Example/ ")).toBe("wss://relay.example");
    expect(normalizeRelayUrl("https://relay.example")).toBeNull();
    expect(normalizeRelayUrl("wss://user:secret@relay.example")).toBeNull();
  });

  it("connects and subscribes successfully", () => {
    const { manager, sockets } = harness();
    expect(manager.snapshot().relays[0].state).toBe("Connecting");
    sockets[0].open();
    expect(manager.snapshot().relays[0].state).toBe("Subscribed");
    expect(sockets[0].sentMessages().filter((message) => message[0] === "REQ")).toHaveLength(2);
    manager.close();
  });

  it("times out a connection and schedules exponential retry", () => {
    const { manager, sockets } = harness();
    vi.advanceTimersByTime(100);
    expect(manager.snapshot().relays[0].state).toBe("Retrying");
    expect(manager.snapshot().relays[0].retryAttempt).toBe(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    manager.close();
  });

  it("normalizes opaque WebSocket errors into a useful diagnostic", () => {
    const errors: unknown[] = [];
    const sockets: MockSocket[] = [];
    const manager = new RelayManager(["wss://one.test"], ["1".repeat(64)], () => {}, undefined, (error) => errors.push(error), {
      websocketFactory: (url) => { const socket = new MockSocket(url); sockets.push(socket); return socket; },
      storage: null, onlineTarget: null, isOnline: () => true, random: () => 0.5,
    });
    manager.start();
    sockets[0].onerror?.({ type: "error" });
    expect(manager.snapshot().relays[0].lastError).toBe("WebSocket error");
    expect(errors).toHaveLength(1);
    manager.close();
  });

  it("reconnects at 1s then 2s and restores active subscriptions", () => {
    const { manager, sockets } = harness();
    sockets[0].open();
    manager.requestProfiles(["2".repeat(64)]);
    sockets[0].close();
    vi.advanceTimersByTime(1_000);
    sockets[1].open();
    expect(sockets[1].sentMessages().some((message) => message[0] === "REQ" && String(message[1]).startsWith("profiles-"))).toBe(true);
    sockets[1].close();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    manager.close();
  });

  it("continues with one relay down and reports subset EOSE as partial sync", () => {
    const { manager, sockets } = harness(["wss://one.test", "wss://two.test"]);
    sockets[0].open();
    sockets[1].fail();
    sockets[0].message(["EOSE", "stegstr-feed"]);
    expect(manager.snapshot()).toMatchObject({ connected: 1, configured: 2, completedInitialSync: 1, syncState: "partial" });
    manager.close();
  });

  it("reports fully synced only after every relay completes its initial feed", () => {
    const { manager, sockets } = harness(["wss://one.test", "wss://two.test"]);
    sockets.forEach((socket) => socket.open());
    sockets[0].message(["EOSE", "stegstr-feed"]);
    expect(manager.snapshot().syncState).toBe("partial");
    sockets[1].message(["EOSE", "stegstr-feed"]);
    expect(manager.snapshot()).toMatchObject({ completedInitialSync: 2, syncState: "synced" });
    manager.close();
  });

  it("recovers after offline and online lifecycle events", () => {
    const sockets: MockSocket[] = [];
    const target = new MockOnlineTarget();
    let online = true;
    const manager = new RelayManager(["wss://one.test"], ["1".repeat(64)], () => {}, undefined, undefined, {
      websocketFactory: (url) => { const socket = new MockSocket(url); sockets.push(socket); return socket; },
      storage: null, onlineTarget: target as unknown as Window,
      isOnline: () => online, random: () => 0.5,
    });
    manager.start(); sockets[0].open();
    online = false; target.dispatch("offline");
    expect(manager.snapshot()).toMatchObject({ connected: 0, syncState: "offline" });
    online = true; target.dispatch("online");
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(manager.snapshot().connected).toBe(1);
    manager.close();
  });
});

describe("RelayManager validation and deduplication", () => {
  it("accepts one valid copy from several relays", async () => {
    const { manager, sockets, events } = harness(["wss://one.test", "wss://two.test"]);
    sockets.forEach((socket) => socket.open());
    const event = await signedEvent();
    sockets[0].message(["EVENT", "stegstr-feed", event]);
    sockets[1].message(["EVENT", "stegstr-feed", event]);
    expect(events).toEqual([event]);
    manager.close();
  });

  it("ignores malformed JSON, invalid IDs, and invalid signatures", async () => {
    const { manager, sockets, events } = harness();
    sockets[0].open();
    const event = await signedEvent();
    sockets[0].message("{");
    sockets[0].message(["EVENT", "stegstr-feed", { ...event, id: "0".repeat(64) }]);
    sockets[0].message(["EVENT", "stegstr-feed", { ...event, sig: "0".repeat(128) }]);
    expect(events).toEqual([]);
    manager.close();
  });
});

describe("RelayManager persistent publish outbox", () => {
  it("persists content created while networking is disabled and flushes on next start", async () => {
    const storage = new MemoryStorage();
    const event = await signedEvent("created fully offline");
    queueEventForOutbox(event, ["wss://one.test"], { storage, storageKey: "outbox" });
    const { manager, sockets } = harness(["wss://one.test"], storage);
    sockets[0].open();
    expect(sockets[0].sentMessages().some((message) => message[0] === "EVENT" && message[1].id === event.id)).toBe(true);
    manager.close();
  });

  it("queues while connecting and flushes when the relay opens", async () => {
    const { manager, sockets } = harness();
    const event = await signedEvent();
    expect(manager.publish(event).overall).toBe("pending");
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].sentMessages().some((message) => message[0] === "EVENT" && message[1].id === event.id)).toBe(true);
    expect(manager.getPublish(event.id)?.overall).toBe("sent");
    manager.close();
  });

  it("marks an OK acceptance as overall success", async () => {
    const { manager, sockets } = harness();
    sockets[0].open();
    const event = await signedEvent("accepted");
    manager.publish(event);
    sockets[0].message(["OK", event.id, true, "saved"]);
    expect(manager.getPublish(event.id)).toMatchObject({ overall: "accepted", relays: { "wss://one.test": { status: "accepted" } } });
    manager.close();
  });

  it("succeeds when one of several writable relays accepts", async () => {
    const { manager, sockets } = harness(["wss://one.test", "wss://two.test"]);
    sockets.forEach((socket) => socket.open());
    const event = await signedEvent("one acceptance is enough");
    manager.publish(event);
    sockets[0].message(["OK", event.id, false, "policy"]);
    sockets[1].message(["OK", event.id, true, "saved"]);
    expect(manager.getPublish(event.id)?.overall).toBe("accepted");
    manager.close();
  });

  it("does not retry a permanent relay rejection", async () => {
    const { manager, sockets } = harness();
    sockets[0].open();
    const event = await signedEvent("rejected");
    manager.publish(event);
    sockets[0].message(["OK", event.id, false, "blocked: policy"]);
    vi.advanceTimersByTime(10_000);
    expect(manager.getPublish(event.id)).toMatchObject({ overall: "rejected", relays: { "wss://one.test": { status: "rejected", attempts: 1 } } });
    expect(sockets[0].sentMessages().filter((message) => message[0] === "EVENT")).toHaveLength(1);
    manager.close();
  });

  it("retries acknowledgement timeouts with a bounded attempt count", async () => {
    const { manager, sockets } = harness();
    sockets[0].open();
    const event = await signedEvent("timeout");
    manager.publish(event);
    vi.advanceTimersByTime(100 + 1_000 + 100 + 2_000 + 100);
    expect(manager.getPublish(event.id)?.relays["wss://one.test"]).toMatchObject({ status: "timed_out", attempts: 3 });
    manager.close();
  });

  it("restores a pending outbox after restart", async () => {
    const storage = new MemoryStorage();
    const first = harness(["wss://one.test"], storage);
    const event = await signedEvent("restart");
    first.manager.publish(event);
    first.manager.close();
    const second = harness(["wss://one.test"], storage);
    second.sockets[0].open();
    expect(second.sockets[0].sentMessages().some((message) => message[0] === "EVENT" && message[1].id === event.id)).toBe(true);
    second.manager.close();
  });

  it("removes accepted work from persistent retry state", async () => {
    const storage = new MemoryStorage();
    const first = harness(["wss://one.test"], storage);
    first.sockets[0].open();
    const event = await signedEvent("persisted acceptance");
    first.manager.publish(event);
    first.sockets[0].message(["OK", event.id, true, "saved"]);
    expect(storage.getItem("outbox")).toBeNull();
    first.manager.close();
    const second = harness(["wss://one.test"], storage);
    second.sockets[0].open();
    expect(second.sockets[0].sentMessages().filter((message) => message[0] === "EVENT")).toHaveLength(0);
    second.manager.close();
  });
});
