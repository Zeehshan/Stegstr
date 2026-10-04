import type { NostrEvent, ProfileData } from "./types";
import { NOSTR_LIMITS, mergeNostrEvents, validateNostrEvent } from "./nostr-events";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CachedNostrState = {
  version: 1;
  events: NostrEvent[];
  profiles: Record<string, ProfileData>;
  savedAt: number;
};

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadCachedNostrState(storage: StorageLike | null, key: string): CachedNostrState {
  const empty: CachedNostrState = { version: 1, events: [], profiles: {}, savedAt: 0 };
  if (!storage) return empty;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "null") as Partial<CachedNostrState> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.events)) return empty;
    const validEvents: NostrEvent[] = [];
    for (const candidate of parsed.events.slice(0, NOSTR_LIMITS.cachedEvents)) {
      const validation = validateNostrEvent(candidate);
      if (validation.ok) validEvents.push(validation.event);
    }
    const profiles = parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)
      ? sanitizeProfiles(parsed.profiles)
      : {};
    return { version: 1, events: mergeNostrEvents([], validEvents, NOSTR_LIMITS.cachedEvents), profiles, savedAt: Number(parsed.savedAt) || 0 };
  } catch {
    return empty;
  }
}

export function saveCachedNostrState(storage: StorageLike | null, key: string, events: NostrEvent[], profiles: Record<string, ProfileData>): void {
  if (!storage) return;
  try {
    const state: CachedNostrState = {
      version: 1,
      events: mergeNostrEvents([], events, NOSTR_LIMITS.cachedEvents),
      profiles: sanitizeProfiles(profiles),
      savedAt: Date.now(),
    };
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Quota/privacy failures must never block offline steganography.
  }
}

export function loadBoundedArray<T>(storage: StorageLike | null, key: string, maxItems: number): T[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.slice(0, maxItems) as T[] : [];
  } catch {
    return [];
  }
}

export function saveBoundedArray<T>(storage: StorageLike | null, key: string, items: T[], maxItems: number): void {
  if (!storage) return;
  try {
    if (items.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(items.slice(0, maxItems)));
  } catch {
    // Persistence is best effort; the in-memory queue remains authoritative.
  }
}

function sanitizeProfiles(value: Record<string, ProfileData>): Record<string, ProfileData> {
  const result: Record<string, ProfileData> = {};
  for (const [pubkey, profile] of Object.entries(value).slice(0, 1_000)) {
    if (!/^[0-9a-f]{64}$/.test(pubkey) || !profile || typeof profile !== "object") continue;
    result[pubkey] = {
      name: boundedString(profile.name, 256),
      about: boundedString(profile.about, 4_096),
      picture: boundedString(profile.picture, 2_048),
      banner: boundedString(profile.banner, 2_048),
      nip05: boundedString(profile.nip05, 256),
    };
  }
  return result;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}
