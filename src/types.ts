// Nostr event (minimal for feed)
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrStateBundle {
  version: number;
  events: NostrEvent[];
}

export type View = "feed" | "messages" | "followers" | "notifications" | "profile" | "settings" | "bookmarks" | "explore" | "identity";

export type IdentityEntry = {
  id: string;
  /** Public metadata used by both web and native identities. */
  publicKey?: string;
  /** Opaque reference to an OS-protected credential. Present in native builds. */
  keyHandle?: string;
  /** Web fallback and one-time native migration input only. Never persisted after successful native migration. */
  privKeyHex?: string;
  label: string;
  type: "local" | "nostr";
  /** local = data only steganographic (images); nostr = published to relays when Network ON. Convertible both ways. */
  category: "local" | "nostr";
  isPrivate?: boolean;
};

export type ProfileData = {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
};
