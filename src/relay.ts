/** Reliable multi-relay Nostr manager with bounded persistence and validation. */

import type { NostrEvent } from "./types";
import { NOSTR_LIMITS, validateNostrEvent } from "./nostr-events";
import { browserStorage, loadBoundedArray, saveBoundedArray, type StorageLike } from "./nostr-persistence";

export const STEGSTR_CONFIG_URL = "https://www.stegstr.com/config/relay.json";
export const STEGSTR_CONFIG_URL_PHP = "https://www.stegstr.com/config/relay.php";
export const DEFAULT_RELAYS = ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];

export type RelayConnectionState = "Disconnected" | "Connecting" | "Connected" | "Subscribed" | "Retrying" | "Error";
export type SyncState = "offline" | "syncing" | "partial" | "synced";
export type PublishRelayStatus = "pending" | "sent" | "accepted" | "rejected" | "timed_out";
export type PublishOverallStatus = "pending" | "sent" | "accepted" | "rejected" | "timed_out";

export interface RelaySnapshot {
  url: string;
  state: RelayConnectionState;
  initialEose: boolean;
  retryAttempt: number;
  lastError?: string;
}

export interface RelayManagerSnapshot {
  relays: RelaySnapshot[];
  connected: number;
  configured: number;
  completedInitialSync: number;
  syncState: SyncState;
  pendingPublishes: number;
  failedPublishes: number;
}

export interface PublishRelayResult {
  status: PublishRelayStatus;
  attempts: number;
  message?: string;
  updatedAt: number;
}

export interface PublishRecord {
  event: NostrEvent;
  createdAt: number;
  relays: Record<string, PublishRelayResult>;
  overall: PublishOverallStatus;
}

interface WebSocketLike {
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface SubscriptionDefinition {
  id: string;
  filters: unknown[];
  expiresAt?: number;
}

interface RelayNode {
  url: string;
  state: RelayConnectionState;
  socket: WebSocketLike | null;
  initialEose: boolean;
  retryAttempt: number;
  connectTimer: TimerHandle | null;
  retryTimer: TimerHandle | null;
  stableTimer: TimerHandle | null;
  lastError?: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type StateListener = (snapshot: RelayManagerSnapshot) => void;

export interface RelayManagerOptions {
  websocketFactory?: (url: string) => WebSocketLike;
  storage?: StorageLike | null;
  storageKey?: string;
  connectionTimeoutMs?: number;
  ackTimeoutMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  stableConnectionMs?: number;
  maxOutbox?: number;
  random?: () => number;
  now?: () => number;
  onlineTarget?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  isOnline?: () => boolean;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

const OPEN = 1;
const CONNECTING = 0;
const MAIN_SUB_ID = "stegstr-feed";
const DM_SUB_ID = "stegstr-dm";
const MAX_DYNAMIC_SUBSCRIPTIONS = 20;
const MAX_SEEN_EVENTS = 20_000;
const MAX_PUBLISH_ATTEMPTS = 3;

export function normalizeRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
    if (!url.hostname || url.username || url.password || url.hash) return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseConfigResponse(data: unknown): string[] {
  const obj = data as { relays?: unknown; proxyUrl?: unknown };
  const candidates = Array.isArray(obj?.relays) ? obj.relays : [obj?.proxyUrl];
  return [...new Set(candidates.filter((value): value is string => typeof value === "string").map(normalizeRelayUrl).filter((value): value is string => value !== null))];
}

export async function getRelayUrls(): Promise<string[]> {
  for (const configUrl of [STEGSTR_CONFIG_URL, STEGSTR_CONFIG_URL_PHP]) {
    let timeout: TimerHandle | null = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 4_000);
      const response = await fetch(configUrl, { signal: controller.signal });
      if (!response.ok) continue;
      const urls = parseConfigResponse(await response.json());
      if (urls.length > 0) return urls;
    } catch {
      // Try the next endpoint, then the local fallback.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  return [...DEFAULT_RELAYS];
}

export type RelayEventCallback = (event: NostrEvent) => void;

export class RelayManager {
  private readonly nodes = new Map<string, RelayNode>();
  private readonly subscriptions = new Map<string, SubscriptionDefinition>();
  private readonly listeners = new Set<StateListener>();
  private readonly seenEvents = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly ackTimers = new Map<string, TimerHandle>();
  private readonly miscellaneousTimers = new Set<TimerHandle>();
  private readonly outbox = new Map<string, PublishRecord>();
  private readonly websocketFactory: (url: string) => WebSocketLike;
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly connectionTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly stableConnectionMs: number;
  private readonly maxOutbox: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly onlineTarget: RelayManagerOptions["onlineTarget"];
  private readonly isOnline: () => boolean;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private closed = false;
  private started = false;
  private suspended = false;
  private syncNotified = false;

  constructor(
    relayUrls: string[],
    private readonly ourPubkeys: string[],
    private readonly onEvent: RelayEventCallback,
    private readonly onInitialSync?: () => void,
    private readonly onError?: (error: unknown) => void,
    options: RelayManagerOptions = {},
  ) {
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.storageKey = options.storageKey ?? "stegstr_nostr_outbox";
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 8_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    this.baseRetryMs = options.baseRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.stableConnectionMs = options.stableConnectionMs ?? 10_000;
    this.maxOutbox = options.maxOutbox ?? 100;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.onlineTarget = options.onlineTarget === undefined ? (typeof window === "undefined" ? null : window) : options.onlineTarget;
    this.isOnline = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;

    const urls = [...new Set(relayUrls.map(normalizeRelayUrl).filter((url): url is string => url !== null))];
    for (const url of urls) this.nodes.set(url, this.newNode(url));
    this.installBaseSubscriptions();
    this.restoreOutbox();
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.onlineTarget?.addEventListener("online", this.handleOnline);
    this.onlineTarget?.addEventListener("offline", this.handleOffline);
    this.onlineTarget?.addEventListener("visibilitychange", this.handleVisibility);
    if (!this.isOnline()) this.handleOffline();
    else for (const node of this.nodes.values()) this.connect(node);
    this.emit();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onlineTarget?.removeEventListener("online", this.handleOnline);
    this.onlineTarget?.removeEventListener("offline", this.handleOffline);
    this.onlineTarget?.removeEventListener("visibilitychange", this.handleVisibility);
    for (const timer of this.ackTimers.values()) this.clearTimer(timer);
    this.ackTimers.clear();
    for (const timer of this.miscellaneousTimers) this.clearTimer(timer);
    this.miscellaneousTimers.clear();
    for (const node of this.nodes.values()) this.disconnectNode(node);
    this.persistOutbox();
    this.listeners.clear();
  }

  publish(event: NostrEvent): PublishRecord {
    const validation = validateNostrEvent(event);
    if (!validation.ok) throw new Error(`refusing to publish invalid event: ${validation.error}`);
    const existing = this.outbox.get(event.id);
    if (existing) return existing;
    while (this.outbox.size >= this.maxOutbox) {
      const completed = [...this.outbox.entries()].find(([, record]) => record.overall === "accepted" || record.overall === "rejected");
      if (!completed) throw new Error(`publish outbox is full (${this.maxOutbox} events)`);
      this.outbox.delete(completed[0]);
    }
    const relays: Record<string, PublishRelayResult> = {};
    for (const url of this.nodes.keys()) relays[url] = { status: "pending", attempts: 0, updatedAt: this.now() };
    const record: PublishRecord = { event, createdAt: this.now(), relays, overall: "pending" };
    this.outbox.set(event.id, record);
    for (const node of this.nodes.values()) this.flushNode(node);
    this.updatePublishOverall(record);
    this.persistOutbox();
    this.emit();
    return record;
  }

  getPublish(eventId: string): PublishRecord | undefined {
    return this.outbox.get(eventId);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): RelayManagerSnapshot {
    const relays = [...this.nodes.values()].map((node) => ({ url: node.url, state: node.state, initialEose: node.initialEose, retryAttempt: node.retryAttempt, lastError: node.lastError }));
    const connected = relays.filter((relay) => relay.state === "Connected" || relay.state === "Subscribed").length;
    const completedInitialSync = relays.filter((relay) => relay.initialEose).length;
    let syncState: SyncState = "offline";
    if (completedInitialSync > 0) syncState = completedInitialSync === relays.length ? "synced" : "partial";
    else if (connected > 0 || relays.some((relay) => relay.state === "Connecting" || relay.state === "Retrying")) syncState = "syncing";
    return {
      relays,
      connected,
      configured: relays.length,
      completedInitialSync,
      syncState,
      pendingPublishes: [...this.outbox.values()].filter((record) => record.overall === "pending" || record.overall === "sent").length,
      failedPublishes: [...this.outbox.values()].filter((record) => record.overall === "rejected" || record.overall === "timed_out").length,
    };
  }

  requestProfiles(pubkeys: string[]): void {
    const values = validHexValues(pubkeys, 300);
    if (values.length) this.dynamicSubscription(`profiles-${stableKey(values)}`, [{ kinds: [0], authors: values, limit: 200 }]);
  }

  requestReplies(noteIds: string[]): void {
    const values = validHexValues(noteIds, 300);
    if (values.length) this.dynamicSubscription(`replies-${stableKey(values)}`, [{ kinds: [1], "#e": values, limit: 500 }]);
  }

  requestAuthor(authorPubkey: string): void {
    const [author] = validHexValues([authorPubkey], 1);
    if (author) this.dynamicSubscription(`author-${author.slice(0, 16)}`, [{ kinds: [0, 1, 3], authors: [author], limit: 200 }]);
  }

  requestFollowers(pubkey: string): void {
    const [value] = validHexValues([pubkey], 1);
    if (value) this.dynamicSubscription(`followers-${value.slice(0, 16)}`, [{ kinds: [3], "#p": [value], limit: 500 }]);
  }

  requestSearch(query: string): void {
    const value = query.trim().slice(0, 256);
    if (value) this.replaceDynamicSubscription("search", [{ kinds: [1], search: value, limit: 100 }]);
  }

  requestProfileSearch(query: string): void {
    const value = query.trim().slice(0, 256);
    if (value.length >= 2) this.replaceDynamicSubscription("profile-search", [{ kinds: [0], search: value, limit: 50 }]);
  }

  requestMore(until: number): void {
    if (Number.isSafeInteger(until) && until > 0) this.replaceDynamicSubscription("more", [{ kinds: [1], until, limit: 100 }]);
  }

  reconnectNow(): void {
    if (this.closed || !this.isOnline()) return;
    this.suspended = false;
    for (const node of this.nodes.values()) {
      if (!node.socket || (node.socket.readyState !== OPEN && node.socket.readyState !== CONNECTING)) {
        this.clearNodeTimers(node);
        this.connect(node);
      }
    }
  }

  private installBaseSubscriptions(): void {
    const authors = validHexValues(this.ourPubkeys, 500);
    const safeAuthors = authors.length ? authors : ["0".repeat(64)];
    this.subscriptions.set(MAIN_SUB_ID, { id: MAIN_SUB_ID, filters: [
      { kinds: [0, 1, 3, 5, 6, 10003], authors: safeAuthors, limit: 200 },
      { kinds: [0], limit: 500 }, { kinds: [1], limit: 300 }, { kinds: [6], limit: 300 },
      { kinds: [7], "#p": safeAuthors, limit: 300 }, { kinds: [9735], "#p": safeAuthors, limit: 300 },
    ] });
    this.subscriptions.set(DM_SUB_ID, { id: DM_SUB_ID, filters: [{ kinds: [4], "#p": safeAuthors, limit: 100 }] });
  }

  private dynamicSubscription(id: string, filters: unknown[]): void {
    if (!this.subscriptions.has(id) && this.subscriptions.size >= MAX_DYNAMIC_SUBSCRIPTIONS + 2) {
      const oldest = [...this.subscriptions.keys()].find((key) => key !== MAIN_SUB_ID && key !== DM_SUB_ID);
      if (oldest) this.closeSubscription(oldest);
    }
    const definition = { id, filters, expiresAt: this.now() + 10_000 };
    this.subscriptions.set(id, definition);
    for (const node of this.nodes.values()) this.sendSubscription(node, definition);
    this.scheduleMiscellaneous(() => {
      if (this.subscriptions.get(id)?.expiresAt === definition.expiresAt) this.closeSubscription(id);
    }, 10_000);
  }

  private replaceDynamicSubscription(id: string, filters: unknown[]): void {
    this.closeSubscription(id);
    this.dynamicSubscription(id, filters);
  }

  private closeSubscription(id: string): void {
    if (!this.subscriptions.delete(id)) return;
    for (const node of this.nodes.values()) this.send(node, ["CLOSE", id]);
  }

  private connect(node: RelayNode): void {
    if (this.closed || this.suspended || node.socket || !this.isOnline()) return;
    this.transition(node, "Connecting");
    node.initialEose = false;
    let socket: WebSocketLike;
    try {
      socket = this.websocketFactory(node.url);
    } catch (error) {
      this.failNode(node, error);
      return;
    }
    node.socket = socket;
    node.connectTimer = this.setTimer(() => {
      if (node.socket !== socket || socket.readyState === OPEN) return;
      node.lastError = "connection timeout";
      try { socket.close(); } catch { /* ignored */ }
      if (node.socket === socket) this.failNode(node, new Error("connection timeout"));
    }, this.connectionTimeoutMs);

    socket.onopen = () => {
      if (this.closed || node.socket !== socket) return;
      this.clearTimerHandle(node, "connectTimer");
      this.transition(node, "Connected");
      for (const definition of this.activeSubscriptions()) this.sendSubscription(node, definition);
      this.transition(node, "Subscribed");
      for (const record of this.outbox.values()) {
        const relay = record.relays[node.url];
        if (relay?.status === "sent" || relay?.status === "timed_out") relay.status = "pending";
      }
      this.flushNode(node);
      node.stableTimer = this.setTimer(() => { node.retryAttempt = 0; }, this.stableConnectionMs);
    };
    socket.onmessage = (message) => this.handleMessage(node, socket, message.data);
    socket.onerror = (error) => this.failNode(node, error ?? new Error("websocket error"));
    socket.onclose = () => {
      if (node.socket !== socket) return;
      node.socket = null;
      node.initialEose = false;
      this.clearTimerHandle(node, "connectTimer");
      this.clearTimerHandle(node, "stableTimer");
      if (this.closed || this.suspended) this.transition(node, "Disconnected");
      else this.scheduleRetry(node);
    };
  }

  private failNode(node: RelayNode, error: unknown): void {
    node.lastError = describeRelayError(error);
    this.onError?.(error);
    const socket = node.socket;
    node.socket = null;
    if (socket) try { socket.close(); } catch { /* ignored */ }
    this.transition(node, "Error");
    this.scheduleRetry(node);
  }

  private scheduleRetry(node: RelayNode): void {
    if (this.closed || this.suspended || node.retryTimer) return;
    this.transition(node, "Retrying");
    const exponential = Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** Math.min(node.retryAttempt, 10));
    const delay = Math.round(exponential * (0.8 + this.random() * 0.4));
    node.retryAttempt += 1;
    node.retryTimer = this.setTimer(() => {
      node.retryTimer = null;
      this.connect(node);
    }, delay);
  }

  private handleMessage(node: RelayNode, socket: WebSocketLike, data: unknown): void {
    if (node.socket !== socket || typeof data !== "string" || data.length > NOSTR_LIMITS.messageBytes) return;
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;
    if (message[0] === "EVENT") {
      if (typeof message[1] !== "string") return;
      const validation = validateNostrEvent(message[2]);
      if (!validation.ok || this.seenEvents.has(validation.event.id)) return;
      this.rememberEvent(validation.event.id);
      try { this.onEvent(validation.event); } catch (error) { this.onError?.(error); }
      return;
    }
    if (message[0] === "EOSE" && typeof message[1] === "string") {
      if (message[1] === MAIN_SUB_ID) {
        node.initialEose = true;
        this.emit();
        if (!this.syncNotified) {
          this.syncNotified = true;
          this.onInitialSync?.();
        }
      } else if (this.subscriptions.has(message[1]) && message[1] !== DM_SUB_ID) {
        this.closeSubscription(message[1]);
      }
      return;
    }
    if (message[0] === "OK" && typeof message[1] === "string" && typeof message[2] === "boolean") {
      this.handleAck(node.url, message[1], message[2], typeof message[3] === "string" ? message[3].slice(0, 512) : undefined);
    }
  }

  private sendSubscription(node: RelayNode, definition: SubscriptionDefinition): void {
    if (definition.expiresAt && definition.expiresAt <= this.now()) return;
    this.send(node, ["REQ", definition.id, ...definition.filters]);
  }

  private send(node: RelayNode, payload: unknown[]): boolean {
    if (!node.socket || node.socket.readyState !== OPEN) return false;
    try {
      node.socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      node.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private flushNode(node: RelayNode): void {
    if (!node.socket || node.socket.readyState !== OPEN) return;
    for (const record of this.outbox.values()) {
      const relay = record.relays[node.url];
      if (!relay || relay.status !== "pending" || relay.attempts >= MAX_PUBLISH_ATTEMPTS) continue;
      if (!this.send(node, ["EVENT", record.event])) continue;
      relay.status = "sent";
      relay.attempts += 1;
      relay.updatedAt = this.now();
      this.startAckTimer(record, node.url);
      this.updatePublishOverall(record);
    }
    this.persistOutbox();
    this.emit();
  }

  private startAckTimer(record: PublishRecord, relayUrl: string): void {
    const key = `${record.event.id}:${relayUrl}`;
    const previous = this.ackTimers.get(key);
    if (previous) this.clearTimer(previous);
    this.ackTimers.set(key, this.setTimer(() => {
      this.ackTimers.delete(key);
      const relay = record.relays[relayUrl];
      if (!relay || relay.status !== "sent") return;
      if (relay.attempts < MAX_PUBLISH_ATTEMPTS) {
        relay.status = "pending";
        relay.updatedAt = this.now();
        this.scheduleMiscellaneous(() => {
          const node = this.nodes.get(relayUrl);
          if (node) this.flushNode(node);
        }, this.baseRetryMs * relay.attempts);
      } else {
        relay.status = "timed_out";
        relay.updatedAt = this.now();
      }
      this.updatePublishOverall(record);
      this.persistOutbox();
      this.emit();
    }, this.ackTimeoutMs));
  }

  private handleAck(relayUrl: string, eventId: string, accepted: boolean, message?: string): void {
    const record = this.outbox.get(eventId);
    const relay = record?.relays[relayUrl];
    if (!record || !relay) return;
    const key = `${eventId}:${relayUrl}`;
    const timer = this.ackTimers.get(key);
    if (timer) this.clearTimer(timer);
    this.ackTimers.delete(key);
    relay.status = accepted ? "accepted" : "rejected";
    relay.message = message;
    relay.updatedAt = this.now();
    this.updatePublishOverall(record);
    this.persistOutbox();
    this.emit();
  }

  private updatePublishOverall(record: PublishRecord): void {
    const statuses = Object.values(record.relays).map((relay) => relay.status);
    if (statuses.includes("accepted")) record.overall = "accepted";
    else if (statuses.length > 0 && statuses.every((status) => status === "rejected")) record.overall = "rejected";
    else if (statuses.length > 0 && statuses.every((status) => status === "rejected" || status === "timed_out")) record.overall = "timed_out";
    else if (statuses.includes("sent")) record.overall = "sent";
    else record.overall = "pending";
  }

  private restoreOutbox(): void {
    const stored = loadBoundedArray<PublishRecord>(this.storage, this.storageKey, this.maxOutbox);
    for (const candidate of stored) {
      const validation = validateNostrEvent(candidate?.event);
      if (!validation.ok || !candidate.relays || typeof candidate.relays !== "object") continue;
      const relays: Record<string, PublishRelayResult> = {};
      for (const url of this.nodes.keys()) {
        const previous = candidate.relays[url];
        if (previous?.status === "rejected") relays[url] = { ...previous, message: previous.message?.slice(0, 512) };
        else relays[url] = { status: "pending", attempts: Math.min(Number(previous?.attempts) || 0, MAX_PUBLISH_ATTEMPTS - 1), updatedAt: this.now() };
      }
      const record: PublishRecord = { event: validation.event, createdAt: Number(candidate.createdAt) || this.now(), relays, overall: "pending" };
      this.outbox.set(record.event.id, record);
    }
  }

  private persistOutbox(): void {
    const pending = [...this.outbox.values()].filter((record) => record.overall !== "accepted" && record.overall !== "rejected");
    saveBoundedArray(this.storage, this.storageKey, pending, this.maxOutbox);
  }

  private activeSubscriptions(): SubscriptionDefinition[] {
    const now = this.now();
    return [...this.subscriptions.values()].filter((definition) => !definition.expiresAt || definition.expiresAt > now);
  }

  private rememberEvent(id: string): void {
    this.seenEvents.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > MAX_SEEN_EVENTS) {
      const removed = this.seenOrder.shift();
      if (removed) this.seenEvents.delete(removed);
    }
  }

  private transition(node: RelayNode, state: RelayConnectionState): void {
    node.state = state;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private disconnectNode(node: RelayNode): void {
    this.clearNodeTimers(node);
    const socket = node.socket;
    node.socket = null;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { socket.close(); } catch { /* ignored */ }
    }
    node.state = "Disconnected";
    node.initialEose = false;
  }

  private clearNodeTimers(node: RelayNode): void {
    this.clearTimerHandle(node, "connectTimer");
    this.clearTimerHandle(node, "retryTimer");
    this.clearTimerHandle(node, "stableTimer");
  }

  private clearTimerHandle(node: RelayNode, key: "connectTimer" | "retryTimer" | "stableTimer"): void {
    if (node[key]) this.clearTimer(node[key]!);
    node[key] = null;
  }

  private newNode(url: string): RelayNode {
    return { url, state: "Disconnected", socket: null, initialEose: false, retryAttempt: 0, connectTimer: null, retryTimer: null, stableTimer: null };
  }

  private scheduleMiscellaneous(callback: () => void, delay: number): void {
    const timer = this.setTimer(() => {
      this.miscellaneousTimers.delete(timer);
      if (!this.closed) callback();
    }, delay);
    this.miscellaneousTimers.add(timer);
  }

  private handleOnline = () => {
    this.suspended = false;
    this.reconnectNow();
  };

  private handleOffline = () => {
    this.suspended = true;
    for (const node of this.nodes.values()) this.disconnectNode(node);
    this.emit();
  };

  private handleVisibility = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") this.reconnectNow();
  };
}

function describeRelayError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) return error.message;
  return "WebSocket error";
}

export type ConnectRelaysResult = {
  close: () => void;
  publish: (event: NostrEvent) => PublishRecord;
  requestProfiles: (pubkeys: string[]) => void;
  requestReplies: (noteIds: string[]) => void;
  requestAuthor: (authorPubkey: string) => void;
  requestFollowers: (ofPubkey: string) => void;
  requestSearch: (query: string) => void;
  requestProfileSearch: (query: string) => void;
  requestMore: (until: number) => void;
  snapshot: () => RelayManagerSnapshot;
  subscribe: (listener: StateListener) => () => void;
  getPublish: (eventId: string) => PublishRecord | undefined;
  reconnectNow: () => void;
};

export function connectRelays(
  ourPubkeys: string[],
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (error: unknown) => void,
  relays: string[] = DEFAULT_RELAYS,
  options: RelayManagerOptions = {},
): ConnectRelaysResult {
  const manager = new RelayManager(relays, ourPubkeys, onEvent, onEose, onError, options);
  manager.start();
  return {
    close: () => manager.close(), publish: (event) => manager.publish(event),
    requestProfiles: (pubkeys) => manager.requestProfiles(pubkeys), requestReplies: (ids) => manager.requestReplies(ids),
    requestAuthor: (pubkey) => manager.requestAuthor(pubkey), requestFollowers: (pubkey) => manager.requestFollowers(pubkey),
    requestSearch: (query) => manager.requestSearch(query), requestProfileSearch: (query) => manager.requestProfileSearch(query),
    requestMore: (until) => manager.requestMore(until), snapshot: () => manager.snapshot(),
    subscribe: (listener) => manager.subscribe(listener), getPublish: (eventId) => manager.getPublish(eventId),
    reconnectNow: () => manager.reconnectNow(),
  };
}

/** Queue a signed event without opening sockets (used while Network is OFF). */
export function queueEventForOutbox(
  event: NostrEvent,
  relayUrls: string[],
  options: Pick<RelayManagerOptions, "storage" | "storageKey" | "maxOutbox" | "now"> = {},
): PublishRecord {
  const validation = validateNostrEvent(event);
  if (!validation.ok) throw new Error(`refusing to queue invalid event: ${validation.error}`);
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const storageKey = options.storageKey ?? "stegstr_nostr_outbox";
  const maxOutbox = options.maxOutbox ?? 100;
  const now = options.now ?? Date.now;
  const records = loadBoundedArray<PublishRecord>(storage, storageKey, maxOutbox)
    .filter((record) => validateNostrEvent(record?.event).ok);
  const existing = records.find((record) => record.event.id === event.id);
  if (existing) return existing;
  if (records.length >= maxOutbox) throw new Error(`publish outbox is full (${maxOutbox} events)`);
  const relays: Record<string, PublishRelayResult> = {};
  for (const url of [...new Set(relayUrls.map(normalizeRelayUrl).filter((value): value is string => value !== null))]) {
    relays[url] = { status: "pending", attempts: 0, updatedAt: now() };
  }
  const record: PublishRecord = { event: validation.event, createdAt: now(), relays, overall: "pending" };
  saveBoundedArray(storage, storageKey, [...records, record], maxOutbox);
  return record;
}

function validHexValues(values: string[], max: number): string[] {
  return [...new Set(values.filter((value) => /^[0-9a-fA-F]{64}$/.test(value)).map((value) => value.toLowerCase()))].slice(0, max);
}

function stableKey(values: string[]): string {
  let hash = 2166136261;
  for (const char of values.join(",")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
