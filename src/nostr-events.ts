import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NostrEvent } from "./types";

export const NOSTR_LIMITS = {
  messageBytes: 1_000_000,
  contentLength: 64_000,
  tagCount: 200,
  tagElements: 20,
  tagValueLength: 2_048,
  batchEvents: 500,
  cachedEvents: 2_000,
} as const;

export type EventValidation =
  | { ok: true; event: NostrEvent }
  | { ok: false; error: string };

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const encoder = new TextEncoder();

export function serializeNostrEvent(event: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function calculateEventId(event: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return bytesToHex(sha256(encoder.encode(serializeNostrEvent(event))));
}

export function validateNostrEvent(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): EventValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "event is not an object" };
  const event = value as Partial<NostrEvent>;
  if (typeof event.id !== "string" || !HEX_64.test(event.id)) return { ok: false, error: "invalid event id" };
  if (typeof event.pubkey !== "string" || !HEX_64.test(event.pubkey)) return { ok: false, error: "invalid pubkey" };
  if (typeof event.sig !== "string" || !HEX_128.test(event.sig)) return { ok: false, error: "invalid signature encoding" };
  if (!Number.isSafeInteger(event.created_at) || event.created_at! < 0 || event.created_at! > nowSeconds + 86_400) return { ok: false, error: "invalid created_at" };
  if (!Number.isSafeInteger(event.kind) || event.kind! < 0 || event.kind! > 65_535) return { ok: false, error: "invalid kind" };
  if (typeof event.content !== "string" || event.content.length > NOSTR_LIMITS.contentLength) return { ok: false, error: "invalid content" };
  if (!Array.isArray(event.tags) || event.tags.length > NOSTR_LIMITS.tagCount) return { ok: false, error: "invalid tags" };
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length > NOSTR_LIMITS.tagElements) return { ok: false, error: "invalid tag" };
    if (tag.some((item) => typeof item !== "string" || item.length > NOSTR_LIMITS.tagValueLength)) return { ok: false, error: "invalid tag value" };
  }

  const complete = event as NostrEvent;
  const calculatedId = calculateEventId(complete);
  if (calculatedId !== complete.id) return { ok: false, error: "event id does not match serialized event" };
  try {
    if (!secp.schnorr.verify(hexToBytes(complete.sig), hexToBytes(complete.id), hexToBytes(complete.pubkey))) {
      return { ok: false, error: "invalid Schnorr signature" };
    }
  } catch {
    return { ok: false, error: "invalid Schnorr signature" };
  }
  return { ok: true, event: complete };
}

export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000) || (kind >= 30_000 && kind < 40_000);
}

export function replaceableEventKey(event: NostrEvent): string | null {
  if (!isReplaceableKind(event.kind)) return null;
  const parameter = event.kind >= 30_000 && event.kind < 40_000
    ? event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""
    : "";
  return `${event.pubkey}:${event.kind}:${parameter}`;
}

export function newerReplaceableEvent(left: NostrEvent, right: NostrEvent): NostrEvent {
  if (left.created_at !== right.created_at) return left.created_at > right.created_at ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

export function mergeNostrEvents(existing: NostrEvent[], incoming: NostrEvent[], maxEvents = 10_000): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  const replaceable = new Map<string, NostrEvent>();
  for (const event of [...existing, ...incoming].slice(0, existing.length + NOSTR_LIMITS.batchEvents)) {
    if (byId.has(event.id)) continue;
    const key = replaceableEventKey(event);
    if (!key) {
      byId.set(event.id, event);
      continue;
    }
    const previous = replaceable.get(key);
    if (!previous) {
      replaceable.set(key, event);
      byId.set(event.id, event);
      continue;
    }
    const winner = newerReplaceableEvent(previous, event);
    if (winner.id === previous.id) continue;
    byId.delete(previous.id);
    byId.set(event.id, event);
    replaceable.set(key, event);
  }
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, maxEvents);
}

/**
 * Tracks events explicitly restored from an image. A deletion included in the
 * same image remains authoritative, while an older local tombstone must not
 * prevent a recovered event from being shown immediately.
 */
export function mergeImportedEventIds(
  existing: ReadonlySet<string>,
  imported: NostrEvent[],
  maxEvents = NOSTR_LIMITS.cachedEvents,
): Set<string> {
  const next = new Set(existing);
  for (const event of imported) next.add(event.id);
  for (const event of imported) {
    if (event.kind !== 5) continue;
    for (const tag of event.tags) {
      if (tag[0] === "e" && tag[1]) next.delete(tag[1]);
    }
  }
  while (next.size > maxEvents) {
    const oldest = next.values().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export function isEventHiddenByDeletion(
  eventId: string,
  deletedEventIds: ReadonlySet<string>,
  importedEventIds: ReadonlySet<string>,
): boolean {
  return deletedEventIds.has(eventId) && !importedEventIds.has(eventId);
}

export function summarizeImportedEvents(existing: NostrEvent[], imported: NostrEvent[]): {
  validCount: number;
  newCount: number;
  knownCount: number;
  noteCount: number;
} {
  const existingIds = new Set(existing.map((event) => event.id));
  const seen = new Set<string>();
  let newCount = 0;
  let knownCount = 0;
  let noteCount = 0;
  for (const event of imported) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (existingIds.has(event.id)) knownCount += 1;
    else newCount += 1;
    if (event.kind === 1) noteCount += 1;
  }
  return { validCount: seen.size, newCount, knownCount, noteCount };
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
