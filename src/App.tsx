import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as Nostr from "./nostr-stub";
import { isWeb, pickImageFile, decodeStegoFile, encodeStegoToBlob, downloadBlob } from "./platform-web";
import { getDotCapacityForFile } from "./stego-dot-web";
import { getTauri } from "./platform-desktop";
import { connectRelays, DEFAULT_RELAYS, getRelayUrls, queueEventForOutbox } from "./relay";
import { mergeNostrEvents, NOSTR_LIMITS } from "./nostr-events";
import { browserStorage, loadCachedNostrState, saveCachedNostrState } from "./nostr-persistence";
import { uint8ArrayToBase64 } from "./utils";
import {
  decodeQimImageFile,
  encodeQimImageFile,
  resizeCoverForPlatform,
  qimSelfTest,
  getQimCapacityForFile,
  PLATFORM_WIDTHS,
  DEFAULT_PLATFORM,
} from "./stego-qim";
import { uploadMedia } from "./upload";
import { ensureStegstrSuffix } from "./constants";
import * as stegoCrypto from "./stego-crypto";
import * as logger from "./logger";
import { useToast, ToastContainer } from "./Toast";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import { NotificationsView } from "./NotificationsView";
import { BookmarksView } from "./BookmarksView";
import { ExploreView } from "./ExploreView";
import { SettingsView } from "./SettingsView";
import { IdentityView } from "./IdentityView";
import { FollowingView } from "./FollowingView";
import { MessagesView } from "./MessagesView";
import { ProfileView } from "./ProfileView";
import { FeedView } from "./FeedView";
import type { FeedItem } from "./FeedView";
import { EmbedModal } from "./EmbedModal";
import type { StegoMethod } from "./EmbedModal";
import { EditProfileModal } from "./EditProfileModal";
import { LoginModal } from "./LoginModal";
import { NewMessageModal } from "./NewMessageModal";
import type { NostrEvent, NostrStateBundle, IdentityEntry, View, ProfileData } from "./types";
import {
  createIdentityMaterial,
  identityPublicKey,
  importIdentityMaterial,
  nip04DecryptWithIdentity,
  nip04EncryptWithIdentity,
  signEventWithIdentity,
} from "./identity-crypto";
import { loadIdentityEntries, migrateIdentityStorage, saveIdentityEntries } from "./identity-storage";
import "./App.css";

const STEGSTR_BUNDLE_VERSION = 1;
const BASE_ANON_KEY = "stegstr_anon_key";
const BASE_IDENTITIES = "stegstr_identities";
const BASE_ACTING = "stegstr_acting_identity";
const BASE_VIEWING = "stegstr_viewing_identities";
const BASE_MUTE_PUBKEYS = "stegstr_mute_pubkeys";
const BASE_MUTE_WORDS = "stegstr_mute_words";
const BASE_RELAYS = "stegstr_relays";
const BASE_ZAP_QUEUE = "stegstr_zap_queue";
const BASE_DM_READ = "stegstr_dm_read_timestamps";
const BASE_NOTIF_READ = "stegstr_notification_read_at";
const BASE_NOSTR_CACHE = "stegstr_nostr_cache_v1";
const BASE_NOSTR_OUTBOX = "stegstr_nostr_outbox_v1";

/** Default follows for new local identities so the feed shows posts when network is on. */
const DEFAULT_FOLLOW_NPUBS = [
  "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", // jack
  "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6", // fiatjaf
  "npub1rs787tkd6mle8jxvqr07zngzf8h6qu5fc8g3jfdtj8xux9a6aumqkdgtgf",
  "npub1c3lf9hdmghe4l7xcy8phlhepr66hz7wp5dnkpwxjvw8x7hzh0pesc9mpv4",
  "npub1gcxzte5zlknqx26dzuyuzhhnz5q4fvnvcyn0x0cpqvjq0s8qfjds0x2df2",
];
function getDefaultFollowPubkeys(): string[] {
  const out: string[] = [];
  for (const npub of DEFAULT_FOLLOW_NPUBS) {
    try {
      const d = Nostr.nip19.decode(npub);
      if (d.type === "npub" && d.data.length === 32) out.push(Nostr.bytesToHex(d.data));
    } catch (_) {}
  }
  return out;
}

function getStorageProfileSync(): string | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("profile");
  if (p) return p;
  try {
    return localStorage.getItem("stegstr_test_profile");
  } catch { return null; }
}
function getStorageKey(base: string, profile: string | null | undefined): string {
  const prefix = profile ? `stegstr_test_${profile}_` : "";
  return prefix + base;
}

function getOrCreateAnonKey(profile?: string | null): string {
  const key = getStorageKey(BASE_ANON_KEY, profile);
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[a-fA-F0-9]{64}$/.test(stored)) return stored;
  } catch (_) {}
  const sk = Nostr.generateSecretKey();
  const hex = Nostr.bytesToHex(sk);
  try {
    localStorage.setItem(getStorageKey(BASE_ANON_KEY, profile), hex);
  } catch (_) {}
  return hex;
}

type QueuedZap = {
  id: string;
  noteId: string;
  event: NostrEvent;
  createdAt: number;
  zapStreamUrl: string;
};

function loadQueuedZaps(profile: string | null): QueuedZap[] {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_ZAP_QUEUE, profile));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is QueuedZap => {
      if (typeof x !== "object" || x === null) return false;
      const z = x as QueuedZap;
      return (
        typeof z.id === "string" &&
        typeof z.noteId === "string" &&
        typeof z.zapStreamUrl === "string" &&
        typeof z.createdAt === "number" &&
        typeof z.event === "object" &&
        z.event !== null &&
        typeof (z.event as NostrEvent).id === "string"
      );
    });
  } catch (_) {
    return [];
  }
}

export type { IdentityEntry } from "./types";

function App({ profile }: { profile: string | null }) {
  const toast = useToast();
  const [initialNostrState] = useState(() => loadCachedNostrState(browserStorage(), getStorageKey(BASE_NOSTR_CACHE, profile)));
  const [identities, setIdentities] = useState<IdentityEntry[]>(() => loadIdentityEntries(browserStorage(), getStorageKey(BASE_IDENTITIES, profile), getStorageKey(BASE_ANON_KEY, profile)));
  const [nativeKeysReady, setNativeKeysReady] = useState(() => isWeb());
  const [actingPubkey, setActingPubkey] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_ACTING, profile));
      if (raw && /^[a-fA-F0-9]{64}$/.test(raw)) return raw;
    } catch (_) {}
    return null;
  });
  const [viewingPubkeys, setViewingPubkeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_VIEWING, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string" && /^[a-fA-F0-9]{64}$/.test(x)));
      }
    } catch (_) {}
    return new Set();
  });
  const [nsec, setNsec] = useState("");
  const [loginFormOpen, setLoginFormOpen] = useState(false);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [events, setEvents] = useState<NostrEvent[]>(() => initialNostrState.events);
  const [profiles, setProfiles] = useState<Record<string, ProfileData>>(() => initialNostrState.profiles);
  const [newPost, setNewPost] = useState("");
  const [postMediaUrls, setPostMediaUrls] = useState<string[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [decodeError, setDecodeError] = useState<string>("");
  const [relayStatus, setRelayStatus] = useState<string>("");
  const [view, setView] = useState<View>("feed");
  const [replyingTo, setReplyingTo] = useState<NostrEvent | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editAbout, setEditAbout] = useState("");
  const [editPicture, setEditPicture] = useState("");
  const [editBanner, setEditBanner] = useState("");
  const [dmDecrypted, setDmDecrypted] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [embedModalOpen, setEmbedModalOpen] = useState(false);
  const [embedMethod, setEmbedMethod] = useState<StegoMethod>("qim");
  const [targetPlatform, setTargetPlatform] = useState<string>("instagram");
  const [embedCoverFile, setEmbedCoverFile] = useState<File | null>(null);
  const [embedRecipientMode, setEmbedRecipientMode] = useState<"open" | "recipients">("open");
  const [embedRecipientInput, setEmbedRecipientInput] = useState("");
  const [embedRecipients, setEmbedRecipients] = useState<string[]>([]);
  const [selectedMessagePeer, setSelectedMessagePeer] = useState<string | null>(null);
  const [dmReplyContent, setDmReplyContent] = useState("");
  const [lastReadTimestamps, setLastReadTimestamps] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_DM_READ, profile));
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, number>;
        if (typeof obj === "object" && obj !== null) return obj;
      }
    } catch (_) {}
    return {};
  });
  const [lastNotifReadAt, setLastNotifReadAt] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_NOTIF_READ, profile));
      if (raw) return Number(raw) || 0;
    } catch (_) {}
    return 0;
  });
  const [newMessagePubkeyInput, setNewMessagePubkeyInput] = useState("");
  const [newMessageModalOpen, setNewMessageModalOpen] = useState(false);
  const [viewingProfilePubkey, setViewingProfilePubkey] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<"notes" | "replies">("notes");
  const [showNsecFor, setShowNsecFor] = useState<string | null>(null);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [followingSearchInput, setFollowingSearchInput] = useState("");
  const [mutedPubkeys, setMutedPubkeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_MUTE_PUBKEYS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) {}
    return new Set();
  });
  // Event IDs loaded via Detect image; show them even if author identity has "view" off (shared with any Stegstr user).
  const [importedEventIds, setImportedEventIds] = useState<Set<string>>(() => new Set());
  const [mutedWords, setMutedWords] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_MUTE_WORDS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return arr;
      }
    } catch (_) {}
    return [];
  });
  const [muteInput, setMuteInput] = useState("");
  const [relayUrls, setRelayUrls] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_RELAYS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (_) {}
    return [...DEFAULT_RELAYS];
  });
  useEffect(() => {
    getRelayUrls().then((urls) => {
      setRelayUrls((prev) => {
        if (prev.length === DEFAULT_RELAYS.length && prev.every((u, i) => u === DEFAULT_RELAYS[i])) return urls;
        return prev;
      });
    });
  }, []);
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const [feedFilter, setFeedFilter] = useState<"global" | "following">("global");
  const [detecting, setDetecting] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [stegoProgress, setStegoProgress] = useState("");
  const [stegoLogs, setStegoLogs] = useState<string[]>([]);
  const [dragOverStego, setDragOverStego] = useState(false);
  const [queuedZaps, setQueuedZaps] = useState<QueuedZap[]>(() => loadQueuedZaps(profile));
  const relayRef = useRef<ReturnType<typeof connectRelays> | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const postMediaInputRef = useRef<HTMLInputElement | null>(null);
  const loadingMoreRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const eventBufferRef = useRef<NostrEvent[]>([]);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const FLUSH_MS = 120;

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_RELAYS, profile), JSON.stringify(relayUrls));
    } catch (_) {}
  }, [relayUrls, profile]);

  useEffect(() => {
    const timer = setTimeout(() => {
      saveCachedNostrState(browserStorage(), getStorageKey(BASE_NOSTR_CACHE, profile), events, profiles);
    }, 250);
    return () => clearTimeout(timer);
  }, [events, profiles, profile]);

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_MUTE_PUBKEYS, profile), JSON.stringify([...mutedPubkeys]));
    } catch (_) {}
  }, [mutedPubkeys, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_MUTE_WORDS, profile), JSON.stringify(mutedWords));
    } catch (_) {}
  }, [mutedWords, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_ZAP_QUEUE, profile), JSON.stringify(queuedZaps));
    } catch (_) {}
  }, [queuedZaps, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_DM_READ, profile), JSON.stringify(lastReadTimestamps));
    } catch (_) {}
  }, [lastReadTimestamps, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_NOTIF_READ, profile), String(lastNotifReadAt));
    } catch (_) {}
  }, [lastNotifReadAt, profile]);

  useEffect(() => {
    if (searchQuery.trim()) setReplyingTo(null);
  }, [searchQuery]);
  useEffect(() => {
    if (view !== "feed") setFocusedNoteId(null);
  }, [view]);
  const prevViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevViewRef.current !== null && prevViewRef.current !== view) {
      logger.logAction("view_change", `View changed to ${view}`, { view });
    }
    prevViewRef.current = view;
  }, [view]);

  // Prevent browser from opening dropped images (global handler for web)
  useEffect(() => {
    if (!isWeb()) return;
    const preventDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("dragover", preventDrop);
    document.addEventListener("drop", preventDrop);
    return () => {
      document.removeEventListener("dragover", preventDrop);
      document.removeEventListener("drop", preventDrop);
    };
  }, []);

  const prevNetworkRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevNetworkRef.current !== null && prevNetworkRef.current !== networkEnabled) {
      logger.logAction("network_toggle", networkEnabled ? "Network enabled" : "Network disabled", { networkEnabled });
    }
    prevNetworkRef.current = networkEnabled;
  }, [networkEnabled]);
  const hasSyncedAnonRef = useRef(false);

  useEffect(() => {
    if (isWeb()) return;
    const storage = browserStorage();
    if (!storage) {
      setStatus("Protected-key migration unavailable: local identity metadata storage is inaccessible.");
      return;
    }
    let cancelled = false;
    migrateIdentityStorage(
      storage,
      getStorageKey(BASE_IDENTITIES, profile),
      getStorageKey(BASE_ANON_KEY, profile),
      {
        importKey: async (privateKeyHex, expectedPublicKey) => {
          const material = await importIdentityMaterial(privateKeyHex, expectedPublicKey);
          if (!material.keyHandle || !material.publicKey) throw new Error("Native credential import did not return a key handle");
          return { keyHandle: material.keyHandle, publicKey: material.publicKey };
        },
      },
    ).then((migrated) => {
      if (cancelled) return;
      setIdentities(migrated);
      setNativeKeysReady(true);
    }).catch((error) => {
      if (cancelled) return;
      setStatus("Protected-key migration failed; the original key was retained for retry: " + (error instanceof Error ? error.message : String(error)));
      logger.logError("Protected-key migration failed", error);
    });
    return () => { cancelled = true; };
  }, [profile]);

  // Ensure at least one identity
  useEffect(() => {
    if (identities.length !== 0 || !nativeKeysReady) return;
    let cancelled = false;
    (async () => {
      try {
        let material: Pick<IdentityEntry, "publicKey" | "keyHandle" | "privKeyHex">;
        if (isWeb()) {
          const anon = getOrCreateAnonKey(profile);
          material = { publicKey: Nostr.getPublicKey(Nostr.hexToBytes(anon)), privKeyHex: anon };
        } else {
          material = await createIdentityMaterial();
        }
        if (cancelled || !material.publicKey) return;
        const identity: IdentityEntry = { id: "anon-" + material.publicKey.slice(0, 12), ...material, label: "Local", type: "local", category: "local" };
        setIdentities([identity]);
        setActingPubkey(material.publicKey);
        setViewingPubkeys(new Set([material.publicKey]));
      } catch (error) {
        if (!cancelled) setStatus("Could not create protected identity: " + (error instanceof Error ? error.message : String(error)));
      }
    })();
    return () => { cancelled = true; };
  }, [identities.length, nativeKeysReady, profile]);

  useEffect(() => {
    if (!isWeb() && !nativeKeysReady) return;
    try { saveIdentityEntries(browserStorage(), getStorageKey(BASE_IDENTITIES, profile), identities); } catch (_) {}
  }, [identities, nativeKeysReady, profile]);
  useEffect(() => {
    if (actingPubkey) {
      try { localStorage.setItem(getStorageKey(BASE_ACTING, profile), actingPubkey); } catch (_) {}
    }
  }, [actingPubkey, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_VIEWING, profile), JSON.stringify([...viewingPubkeys]));
    } catch (_) {}
  }, [viewingPubkeys, profile]);

  // Sync viewing to include all identities if empty
  useEffect(() => {
    if (viewingPubkeys.size === 0 && identities.length > 0) {
      setViewingPubkeys(new Set(identities.map(identityPublicKey)));
    }
  }, [identities, viewingPubkeys.size]);
  useEffect(() => {
    if (!actingPubkey && identities.length > 0) {
      const firstPk = identityPublicKey(identities[0]);
      setActingPubkey(firstPk);
    }
  }, [actingPubkey, identities]);

  const actingIdentity = identities.find((i) => identityPublicKey(i) === actingPubkey) ?? identities[0];
  const pubkey = actingIdentity ? identityPublicKey(actingIdentity) : "";
  const selfPubkeys = Array.from(viewingPubkeys).length > 0 ? Array.from(viewingPubkeys) : [pubkey];
  const selfPubkeysKey = useMemo(() => selfPubkeys.join(","), [selfPubkeys.length, ...selfPubkeys]);
  const viewingPubkeysKey = useMemo(() => [...viewingPubkeys].join(","), [viewingPubkeys]);
  const relayUrlsKey = useMemo(() => relayUrls.join(","), [relayUrls]);
  /** Only publish to Nostr relays when identity category is "nostr". Local = steganographic only. */
  const canPublishToNetwork = actingIdentity?.category === "nostr";

  const getIdentityLabelsForPubkey = useCallback((pk: string): string[] => {
    return identities
      .filter((i) => identityPublicKey(i) === pk)
      .map((i) => profiles[pk]?.name || i.label || pk.slice(0, 8) + "…");
  }, [identities, profiles]);

  const isNostrLoggedIn = actingIdentity?.type === "nostr";
  // Use actingPubkey for profile display to avoid crossover with other identities (pubkey has fallback to identities[0])
  const profileDisplayKey = actingPubkey ?? pubkey;
  const myProfile = profileDisplayKey ? profiles[profileDisplayKey] : null;
  const myName = myProfile?.name ?? (profileDisplayKey ? `${profileDisplayKey.slice(0, 8)}…` : "");
  const myPicture = myProfile?.picture ?? null;
  const myAbout = myProfile?.about ?? "";
  const myBanner = myProfile?.banner ?? null;

  const ourPubkeysSet = new Set(identities.map(identityPublicKey));
  let contacts = Array.from(viewingPubkeys).flatMap((pk) => {
    const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pk);
    return kind3 ? kind3.tags.filter((t) => t[0] === "p").map((t) => t[1]) : [];
  });
  if (actingIdentity?.category === "local" && actingPubkey && viewingPubkeys.has(actingPubkey) && !events.some((e) => e.kind === 3 && e.pubkey === actingPubkey)) {
    contacts = [...contacts, ...getDefaultFollowPubkeys()];
  }
  const contactsSet = new Set(contacts);
  const dmEvents = events.filter(
    (e) =>
      e.kind === 4 &&
      (selfPubkeys.includes(e.pubkey) || e.tags.some((t) => t[0] === "p" && t[1] && selfPubkeys.includes(t[1])))
  );
  const recentDmPartners = (() => {
    const seen = new Set<string>();
    const list: { pubkey: string }[] = [];
    for (const ev of dmEvents.sort((a, b) => b.created_at - a.created_at)) {
      const other = selfPubkeys.includes(ev.pubkey) ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
      if (other && !seen.has(other)) {
        seen.add(other);
        list.push({ pubkey: other });
      }
    }
    return list;
  })();
  const notes = events.filter((e) => e.kind === 1);
  const noteIds = new Set(notes.map((n) => n.id));
  const deletedNoteIds = new Set(
    events.filter((e) => e.kind === 5 && selfPubkeys.includes(e.pubkey)).flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
  );
  const rootNotes = notes
    .filter((n) => {
      const eTag = n.tags.find((t) => t[0] === "e");
      return (!eTag || !noteIds.has(eTag[1])) && !deletedNoteIds.has(n.id);
    });
  const getRepliesTo = (noteId: string) =>
    notes.filter((n) => n.tags.find((t) => t[0] === "e" && t[1] === noteId));

  const reposts = events.filter((e) => e.kind === 6);
  const getRepostedNote = (repost: NostrEvent): NostrEvent | null => {
    if (repost.content && repost.content.trim()) {
      try {
        const parsed = JSON.parse(repost.content) as NostrEvent;
        if (parsed.kind === 1 && parsed.id && parsed.pubkey) return parsed;
      } catch (_) {}
    }
    const eTag = repost.tags.find((t) => t[0] === "e");
    if (eTag) {
      const found = notes.find((n) => n.id === eTag[1]);
      if (found) return found;
    }
    return null;
  };

  const myNoteIds = new Set(notes.filter((n) => selfPubkeys.includes(n.pubkey)).map((n) => n.id));
  const noteContentMatchesMutedWord = (content: string) =>
    mutedWords.some((w) => w.trim() && content.toLowerCase().includes(w.trim().toLowerCase()));

  const notificationEventsRaw = selfPubkeys.length > 0
    ? events.filter(
        (e) =>
          (e.kind === 7 && e.tags.some((t) => t[0] === "p" && t[1] && selfPubkeys.includes(t[1]))) ||
          (e.kind === 1 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1]))) ||
          (e.kind === 6 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1]))) ||
          (e.kind === 9735 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1])))
      )
    : [];
  const notificationEvents = notificationEventsRaw
    .filter((e) => !mutedPubkeys.has(e.pubkey) && !noteContentMatchesMutedWord(e.kind === 1 ? e.content : ""))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 100);

  const reactions = events.filter((e) => e.kind === 7);
  const zapReceipts = events.filter((e) => e.kind === 9735);
  const getLikeCount = (noteId: string) =>
    reactions.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;
  const getZapCount = (noteId: string) =>
    zapReceipts.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;
  const hasLiked = (noteId: string) =>
    reactions.some((r) => selfPubkeys.includes(r.pubkey) && r.tags.some((t) => t[0] === "e" && t[1] === noteId));

  const bookmarksEvent = pubkey ? events.filter((e) => e.kind === 10003 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0] : null;
  const bookmarkIds = new Set(
    events
      .filter((e) => e.kind === 10003 && viewingPubkeys.has(e.pubkey))
      .flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
  );
  const hasBookmarked = (noteId: string) => bookmarkIds.has(noteId);

  const profileViewPubkey = viewingProfilePubkey ?? profileDisplayKey;
  const profileRootNotes = rootNotes.filter((n) => n.pubkey === profileViewPubkey);
  // Profile's own replies (notes by this user that are replies to other notes)
  const profileReplies = notes.filter((n) => {
    if (n.pubkey !== profileViewPubkey) return false;
    const eTag = n.tags.find((t) => t[0] === "e");
    return eTag && noteIds.has(eTag[1]);
  }).sort((a, b) => b.created_at - a.created_at);
  // Helper to get parent note for a reply
  const getParentNote = (noteId: string) => notes.find((n) => n.id === noteId) ?? null;
  const profileFollowing = profileViewPubkey
    ? (events.find((e) => e.kind === 3 && e.pubkey === profileViewPubkey)?.tags?.filter((t) => t[0] === "p").map((t) => t[1]) ?? [])
    : [];
  const profileFollowers = profileViewPubkey
    ? [...new Set(events.filter((e) => e.kind === 3 && e.tags.some((t) => t[0] === "p" && t[1] === profileViewPubkey)).map((e) => e.pubkey))]
    : [];

  const searchTrim = searchQuery.trim();
  const searchLower = searchTrim.toLowerCase();
  const searchNoSpaces = searchTrim.replace(/\s/g, "");
  // Resolve npub to hex for author search (allow npub anywhere in query, strip spaces)
  let searchPubkeyHex: string | null = null;
  const npubMatch = searchNoSpaces.match(/npub1[a-zA-Z0-9]+/i);
  const npubStr = npubMatch ? npubMatch[0] : null;
  if (npubStr) {
    try {
      const decoded = Nostr.nip19.decode(npubStr);
      if (decoded.type === "npub") searchPubkeyHex = Nostr.bytesToHex(decoded.data);
    } catch (_) {}
  }
  if (!searchPubkeyHex && /^[a-fA-F0-9]{64}$/.test(searchNoSpaces)) {
    searchPubkeyHex = searchNoSpaces.toLowerCase();
  }
  const searchNoSpacesLower = searchNoSpaces.toLowerCase();
  const filteredRootNotes = searchTrim
    ? rootNotes.filter((n) => {
        if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
        // Partial hex match: only use no-spaces version for hex-like queries
        if (/^[a-f0-9]{8,64}$/.test(searchNoSpacesLower) && n.pubkey.toLowerCase().includes(searchNoSpacesLower)) return true;
        const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
        if (authorName && searchLower && authorName.includes(searchLower)) return true;
        if (searchLower && n.content.toLowerCase().includes(searchLower)) return true;
        for (const t of n.tags) {
          if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
          if (t[1]?.toLowerCase().includes(searchLower)) return true;
        }
        return false;
      })
    : rootNotes;

  const noteMatchesSearch = (n: NostrEvent) => {
    if (!searchTrim) return true;
    if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
    const pkLower = n.pubkey.toLowerCase();
    if (searchLower && pkLower.includes(searchLower)) return true;
    const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
    if (authorName && authorName.includes(searchLower)) return true;
    if (n.content.toLowerCase().includes(searchLower)) return true;
    for (const t of n.tags) {
      if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
      if (t[1]?.toLowerCase().includes(searchLower)) return true;
    }
    return false;
  };

  const isNoteMuted = (n: NostrEvent) => mutedPubkeys.has(n.pubkey) || noteContentMatchesMutedWord(n.content);

  const exploreNotes = rootNotes
    .filter((n) => !isNoteMuted(n))
    .sort((a, b) => {
      const la = getLikeCount(a.id);
      const lb = getLikeCount(b.id);
      if (lb !== la) return lb - la;
      return b.created_at - a.created_at;
    })
    .slice(0, 100);

  const feedItems: FeedItem[] = [
    ...filteredRootNotes.map((note) => ({ type: "note" as const, note, sortAt: note.created_at })),
    ...reposts
      .map((r) => ({ type: "repost" as const, repost: r, note: getRepostedNote(r), sortAt: r.created_at }))
      .filter((x): x is { type: "repost"; repost: NostrEvent; note: NostrEvent; sortAt: number } => x.note !== null && !deletedNoteIds.has(x.note.id) && noteMatchesSearch(x.note)),
  ]
    .filter((item) => {
      const note = item.type === "note" ? item.note : item.note;
      const reposter = item.type === "repost" ? item.repost.pubkey : null;
      if (mutedPubkeys.has(note.pubkey) || (reposter && mutedPubkeys.has(reposter))) return false;
      if (isNoteMuted(note)) return false;
      if (ourPubkeysSet.has(note.pubkey) && !viewingPubkeys.has(note.pubkey) && !importedEventIds.has(note.id)) return false;
      if (reposter && ourPubkeysSet.has(reposter) && !viewingPubkeys.has(reposter) && !importedEventIds.has(item.type === "repost" ? item.repost.id : note.id)) return false;
      if (feedFilter === "following") {
        const authorPk = item.type === "repost" ? item.repost.pubkey : item.note.pubkey;
        if (!contactsSet.has(authorPk)) return false;
      }
      return true;
    })
    .sort((a, b) => b.sortAt - a.sortAt);

  const publishViaRelay = useCallback((ev: NostrEvent) => {
    try {
      if (relayRef.current) relayRef.current.publish(ev);
      else queueEventForOutbox(ev, relayUrls, { storageKey: getStorageKey(BASE_NOSTR_OUTBOX, profile) });
    } catch (error) {
      setStatus("Publish queue error: " + (error instanceof Error ? error.message : String(error)));
      logger.logError("Nostr publish queue failed", error, { eventId: ev.id.slice(0, 16) });
    }
  }, [relayUrls, profile]);

  useEffect(() => {
    const authors = Array.from(viewingPubkeys).filter((pk) => pk && /^[a-fA-F0-9]{64}$/.test(pk));
    if (!networkEnabled || authors.length === 0) {
      relayRef.current?.close();
      relayRef.current = null;
      eventBufferRef.current = [];
      setRelayStatus("");
      return;
    }
    setRelayStatus("Connecting…");
    eventBufferRef.current = [];
    relayRef.current = connectRelays(
      authors,
      (ev) => {
        try {
          if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return;
          const safe: NostrEvent = {
            id: ev.id,
            pubkey: ev.pubkey,
            created_at: typeof ev.created_at === "number" ? ev.created_at : 0,
            kind: typeof ev.kind === "number" ? ev.kind : 0,
            tags: Array.isArray(ev.tags) ? ev.tags : [],
            content: typeof ev.content === "string" ? ev.content : "",
            sig: typeof ev.sig === "string" ? ev.sig : "",
          };
          if (eventBufferRef.current.length < NOSTR_LIMITS.batchEvents) eventBufferRef.current.push(safe);
        } catch (_) {}
      },
      undefined,
      () => { /* Individual relay failures are represented in the aggregate snapshot. */ },
      relayUrls,
      { storageKey: getStorageKey(BASE_NOSTR_OUTBOX, profile) },
    );
    const unsubscribeState = relayRef.current.subscribe((snapshot) => {
      const prefix = snapshot.syncState === "synced"
        ? "Synced"
        : snapshot.syncState === "partial"
          ? "Partially synced"
          : snapshot.syncState === "syncing"
            ? "Connecting"
            : "Offline";
      const pending = snapshot.pendingPublishes > 0 ? ` · ${snapshot.pendingPublishes} pending` : "";
      const failed = snapshot.failedPublishes > 0 ? ` · ${snapshot.failedPublishes} failed` : "";
      setRelayStatus(`${prefix} · ${snapshot.connected}/${snapshot.configured} relays${pending}${failed}`);
    });
    const flush = () => {
      const batch = eventBufferRef.current;
      if (batch.length === 0) return;
      eventBufferRef.current = [];
      try {
        const mergedForProfiles = mergeNostrEvents(eventsRef.current, batch, 10_000);
        setEvents((prev) => {
          let all = mergeNostrEvents(prev, batch, 10_000);
          const MAX_EVENTS = 10000;
          if (all.length > MAX_EVENTS) {
            const ownPks = new Set(selfPubkeys);
            const own = all.filter((e) => ownPks.has(e.pubkey));
            const rest = all.filter((e) => !ownPks.has(e.pubkey)).slice(0, MAX_EVENTS - own.length);
            all = [...own, ...rest].sort((a, b) => b.created_at - a.created_at);
          }
          eventsRef.current = all;
          return all;
        });
        const profileUpdates: Record<string, ProfileData> = {};
        batch.filter((e) => e.kind === 0).forEach((e) => {
          const winner = mergedForProfiles.find((candidate) => candidate.kind === 0 && candidate.pubkey === e.pubkey);
          if (winner?.id !== e.id) return;
          try {
            const raw = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
            profileUpdates[e.pubkey] = {
              name: raw.name ?? raw.display_name,
              about: raw.about,
              picture: raw.picture,
              banner: raw.banner,
              nip05: raw.nip05,
            };
          } catch (_) {}
        });
        if (Object.keys(profileUpdates).length > 0) {
          setProfiles((p) => {
            const merged = { ...p, ...profileUpdates };
            const MAX_PROFILES = 1000;
            const keys = Object.keys(merged);
            if (keys.length <= MAX_PROFILES) return merged;
            const keepKeys = new Set<string>();
            selfPubkeys.forEach((pk) => keepKeys.add(pk));
            contacts.forEach((pk) => keepKeys.add(pk));
            for (const k of Object.keys(profileUpdates)) keepKeys.add(k);
            const evictable = keys.filter((k) => !keepKeys.has(k));
            const toRemove = evictable.slice(0, keys.length - MAX_PROFILES);
            for (const k of toRemove) delete merged[k];
            return merged;
          });
        }
      } catch (err) {
        console.error("[Stegstr] flush error", err);
      }
    };
    const interval = setInterval(flush, FLUSH_MS);
    return () => {
      clearInterval(interval);
      unsubscribeState();
      relayRef.current?.close();
      relayRef.current = null;
      eventBufferRef.current = [];
      setRelayStatus("");
    };
  }, [networkEnabled, viewingPubkeysKey, relayUrlsKey, profile]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !networkEnabled || !relayRef.current || view !== "feed") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || loadingMoreRef.current) return;
        const notesForMin = events.filter((e) => e.kind === 1);
        if (notesForMin.length === 0) return;
        const oldest = Math.min(...notesForMin.map((n) => n.created_at));
        loadingMoreRef.current = true;
        setLoadingMore(true);
        relayRef.current?.requestMore(oldest);
        setTimeout(() => {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }, 2000);
      },
      { rootMargin: "200px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [networkEnabled, view, events.length]);

  const contactsKey = useMemo(() => [...contactsSet].join(","), [contactsSet.size]);
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
  }, [networkEnabled, contactsKey, notes.length]);

  const rootNoteIdsKey = useMemo(() => rootNotes.map((n) => n.id).join(","), [rootNotes.length]);
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [networkEnabled, rootNoteIdsKey]);

  useEffect(() => {
    if (!(relayStatus.startsWith("Synced") || relayStatus.startsWith("Partially synced")) || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [relayStatus]);

  // When user searches by pubkey/npub, fetch that author's notes and profile from relays (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = searchQuery.trim().replace(/\s/g, "");
    let toFetch: string | null = null;
    const npubMatch = trimmed.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") toFetch = Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      toFetch = trimmed.toLowerCase();
    }
    if (!toFetch) return;
    const t = setTimeout(() => {
      relayRef.current?.requestAuthor(toFetch!);
    }, 400);
    return () => clearTimeout(t);
  }, [networkEnabled, searchQuery]);

  // When relay becomes Synced and search is a pubkey, fetch that author (in case first request ran too early)
  useEffect(() => {
    if (!(relayStatus.startsWith("Synced") || relayStatus.startsWith("Partially synced")) || !relayRef.current) return;
    const trimmed = searchQuery.trim().replace(/\s/g, "");
    let toFetch: string | null = null;
    const npubMatch = trimmed.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") toFetch = Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) toFetch = trimmed.toLowerCase();
    if (toFetch) relayRef.current.requestAuthor(toFetch);
  }, [relayStatus, searchQuery]);

  // When viewing a profile (own or other), fetch profile, notes, and followers
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const pk = viewingProfilePubkey ?? pubkey;
    if (!pk) return;
    relayRef.current.requestProfiles([pk]);
    relayRef.current.requestAuthor(pk);
    relayRef.current.requestFollowers(pk);
  }, [networkEnabled, viewingProfilePubkey, pubkey]);

  // When Nostr is acting and we lack profile data, aggressively fetch after relay syncs
  const profileSyncRetryRef = useRef(0);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  useEffect(() => {
    if (!networkEnabled || !relayRef.current || !(relayStatus.startsWith("Synced") || relayStatus.startsWith("Partially synced"))) return;
    if (!actingPubkey || actingIdentity?.type !== "nostr") return;
    const haveProfile = profilesRef.current[actingPubkey]?.name || profilesRef.current[actingPubkey]?.picture || profilesRef.current[actingPubkey]?.about;
    if (haveProfile) { profileSyncRetryRef.current = 0; return; }
    if (profileSyncRetryRef.current >= 5) {
      setStatus("Could not fetch profile from relays. Try toggling Network off/on.");
      return;
    }
    profileSyncRetryRef.current++;
    relayRef.current.requestProfiles([actingPubkey]);
    relayRef.current.requestAuthor(actingPubkey);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [1500, 3500, 7000]) {
      timeouts.push(
        setTimeout(() => {
          if (profilesRef.current[actingPubkey]?.name || profilesRef.current[actingPubkey]?.picture) return;
          relayRef.current?.requestProfiles([actingPubkey]);
          relayRef.current?.requestAuthor(actingPubkey);
        }, delay)
      );
    }
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [networkEnabled, relayStatus, actingPubkey, actingIdentity?.type]);

  // NIP-50: when user searches by text (not pubkey), ask relays for matching notes and profiles (debounced)
  useEffect(() => {
    try {
      if (!networkEnabled || !relayRef.current) return;
      const trimmed = searchQuery.trim();
      if (trimmed.length < 2) return;
      const isPubkey = /npub1[a-zA-Z0-9]+/i.test(trimmed.replace(/\s/g, "")) || /^[a-fA-F0-9]{64}$/.test(trimmed.replace(/\s/g, ""));
      if (isPubkey) return;
      const t = setTimeout(() => {
        try {
          relayRef.current?.requestSearch(trimmed);
          relayRef.current?.requestProfileSearch(trimmed);
          logger.logAction("search", "Search performed", { query: trimmed.slice(0, 50), networkEnabled });
        } catch (e) {
          console.error("[Stegstr] search request error", e);
        }
      }, 500);
      return () => clearTimeout(t);
    } catch (e) {
      console.error("[Stegstr] search effect error", e);
    }
  }, [networkEnabled, searchQuery]);

  // New message modal: fetch profiles by name from relays when user types (debounced)
  useEffect(() => {
    if (!newMessageModalOpen || !networkEnabled || !relayRef.current) return;
    const trimmed = newMessagePubkeyInput.trim();
    if (trimmed.length < 2) return;
    if (resolvePubkeyFromInput(newMessagePubkeyInput)) return;
    const t = setTimeout(() => {
      relayRef.current?.requestProfileSearch(trimmed);
    }, 400);
    return () => clearTimeout(t);
  }, [newMessageModalOpen, newMessagePubkeyInput, networkEnabled]);

  // Follow area: fetch profiles by name from relays when user types (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = followingSearchInput.trim();
    if (trimmed.length < 2) return;
    if (resolvePubkeyFromInput(followingSearchInput)) return;
    const t = setTimeout(() => {
      relayRef.current?.requestProfileSearch(trimmed);
    }, 400);
    return () => clearTimeout(t);
  }, [networkEnabled, followingSearchInput]);

  const dmCacheRef = useRef<Record<string, string>>({});
  const dmEventIds = dmEvents.map((e) => e.id).join(",");
  useEffect(() => {
    if (dmEvents.length === 0) {
      dmCacheRef.current = {};
      setDmDecrypted({});
      return;
    }
    let cancelled = false;
    const cached = dmCacheRef.current;
    const newEvents = dmEvents.filter((ev) => !(ev.id in cached));
    if (newEvents.length === 0) {
      setDmDecrypted({ ...cached });
      return;
    }
    (async () => {
      for (const ev of newEvents) {
        if (cancelled) return;
        const weAreSender = selfPubkeys.includes(ev.pubkey);
        const ourPk = weAreSender ? ev.pubkey : ev.tags.find((t) => t[0] === "p")?.[1];
        const otherPubkey = weAreSender ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
        if (!ourPk || !otherPubkey || !selfPubkeys.includes(ourPk)) {
          cached[ev.id] = "[No peer]";
          continue;
        }
        const identityForPk = identities.find((i) => identityPublicKey(i) === ourPk) ?? actingIdentity;
        try {
          if (!identityForPk) throw new Error("identity unavailable");
          const plain = await nip04DecryptWithIdentity(identityForPk, otherPubkey, ev.content);
          if (!cancelled) cached[ev.id] = plain;
        } catch {
          if (!cancelled) cached[ev.id] = "[Decryption failed]";
        }
      }
      if (!cancelled) {
        dmCacheRef.current = cached;
        setDmDecrypted({ ...cached });
      }
    })();
    return () => { cancelled = true; };
  }, [identities, actingIdentity, dmEventIds, selfPubkeysKey]);

  // Mark DM conversation as read when user opens it
  useEffect(() => {
    if (selectedMessagePeer) {
      setLastReadTimestamps((prev) => ({ ...prev, [selectedMessagePeer]: Math.floor(Date.now() / 1000) }));
    }
  }, [selectedMessagePeer]);

  // Compute total unread DM count across all peers
  const totalUnreadDmCount = useMemo(() => {
    let count = 0;
    for (const { pubkey: pk } of recentDmPartners) {
      const lastRead = lastReadTimestamps[pk] ?? 0;
      count += dmEvents.filter((ev) => {
        // Only count messages FROM them (not our own sent messages)
        if (selfPubkeys.includes(ev.pubkey)) return false;
        const other = ev.pubkey;
        return other === pk && ev.created_at > lastRead;
      }).length;
    }
    return count;
  }, [dmEvents, recentDmPartners, lastReadTimestamps, selfPubkeys]);

  const totalUnreadNotifCount = useMemo(() => {
    return notificationEvents.filter((ev) => ev.created_at > lastNotifReadAt).length;
  }, [notificationEvents, lastNotifReadAt]);

  // Mark notifications as read when viewing
  useEffect(() => {
    if (view === "notifications" && notificationEvents.length > 0) {
      const latest = notificationEvents[0].created_at;
      if (latest > lastNotifReadAt) {
        setLastNotifReadAt(latest);
      }
    }
  }, [view, notificationEvents, lastNotifReadAt]);

  const handleAddNostrIdentity = useCallback(async (hexOrNsec: string) => {
    const trimmed = hexOrNsec.trim();
    let privHex: string;
    if (trimmed.toLowerCase().startsWith("nsec")) {
      try {
        const decoded = Nostr.nip19.decode(trimmed);
        if (decoded.type === "nsec") privHex = Nostr.bytesToHex(decoded.data);
        else { setStatus("Invalid nsec"); return; }
      } catch (e) {
        setStatus("Invalid nsec: " + (e as Error).message);
        return;
      }
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      privHex = trimmed;
    } else {
      setStatus("Enter valid nsec or 64-char hex key");
      return;
    }
    const pk = Nostr.getPublicKey(Nostr.hexToBytes(privHex));
    if (identities.some((i) => identityPublicKey(i) === pk)) {
      setStatus("Identity already added");
      return;
    }
    let material: Pick<IdentityEntry, "publicKey" | "keyHandle" | "privKeyHex">;
    try {
      material = await importIdentityMaterial(privHex, pk);
    } catch (error) {
      setStatus("Could not protect imported identity: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    setIdentities((prev) => [...prev, { id: "nostr-" + pk.slice(0, 12), ...material, label: pk.slice(0, 8) + "…", type: "nostr", category: "nostr" }]);
    setActingPubkey(pk);
    setViewingPubkeys((prev) => new Set(prev).add(pk));
    setLoginFormOpen(false);
    setNsec("");
    setStatus(networkEnabled ? "Nostr identity added. Fetching profile…" : "Nostr identity added. Turn Network ON to fetch your profile and posts.");
    if (networkEnabled) {
      const fetchProfile = () => {
        relayRef.current?.requestProfiles([pk]);
        relayRef.current?.requestAuthor(pk);
      };
      setTimeout(fetchProfile, 800);
      setTimeout(fetchProfile, 2500);
      setTimeout(fetchProfile, 5000);
    }
  }, [identities, networkEnabled]);

  const handleLogin = useCallback(() => {
    if (!nsec.trim()) {
      setStatus("Enter nsec or click Generate");
      return;
    }
    void handleAddNostrIdentity(nsec.trim());
  }, [nsec, handleAddNostrIdentity]);

  const handleGenerate = useCallback(() => {
    void (async () => {
      try {
        const material = await createIdentityMaterial();
        if (!material.publicKey) throw new Error("Identity creation returned no public key");
        const pk = material.publicKey;
        setIdentities((prev) => [...prev, { id: "local-" + pk.slice(0, 12), ...material, label: "Local " + (prev.length + 1), type: "local", category: "local" }]);
        setActingPubkey(pk);
        setViewingPubkeys((prev) => new Set(prev).add(pk));
        setNsec("");
        setStatus("New local identity created");
        setLoginFormOpen(false);
      } catch (error) {
        setStatus("Identity creation failed: " + (error instanceof Error ? error.message : String(error)));
      }
    })();
  }, []);

  // Helper to add stego log entries (visible in UI)
  const addStegoLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setStegoLogs(prev => [...prev.slice(-19), `[${ts}] ${msg}`]);
    console.log("[StegoLog]", msg);
  }, []);

  const handleLoadFromImage = useCallback(async (providedPathOrFile?: string | File | null) => {
    setDecodeError("");
    setStegoLogs([]);
    if (isWeb()) {
      let file: File | null;
      if (providedPathOrFile instanceof File) {
        file = providedPathOrFile;
        addStegoLog(`Dropped file: ${file.name}`);
      } else if (providedPathOrFile !== undefined && providedPathOrFile !== null) {
        return;
      } else {
        setDetecting(true);
        addStegoLog("Opening file picker...");
        try {
          file = await pickImageFile();
        } finally {
          setDetecting(false);
        }
      }
      if (!file) {
        setStatus("Cancelled");
        addStegoLog("File picker cancelled");
        logger.logAction("detect_cancelled", "User cancelled file picker");
        return;
      }
      setDetecting(true);
      setStegoProgress("Reading image file...");
      addStegoLog(`Selected: ${file.name} (${file.size} bytes, type: ${file.type})`);
      logger.logAction("detect_started", "Decoding stego image (browser)", { name: file.name });
      try {
      // Try QIM first for JPEG files, then fall back to Dot
      let result: { ok: boolean; payload?: string; error?: string } = { ok: false };
      const isJpeg = file.type === "image/jpeg" || file.name.toLowerCase().endsWith(".jpg") || file.name.toLowerCase().endsWith(".jpeg");
      if (isJpeg) {
        setStegoProgress("Trying QIM decode (robust)...");
        addStegoLog("Trying QIM steganography decode...");
        try {
          result = await decodeQimImageFile(file);
          if (result.ok) {
            addStegoLog(`QIM decode OK! Payload: ${result.payload?.length ?? 0} chars`);
          } else {
            addStegoLog(`QIM decode failed: ${result.error ?? "unknown"}, falling back to Dot...`);
          }
        } catch (qimErr) {
          addStegoLog(`QIM decode error: ${qimErr instanceof Error ? qimErr.message : String(qimErr)}, falling back to Dot...`);
        }
      }
      if (!result.ok) {
        setStegoProgress("Extracting hidden data (Dot decode)...");
        addStegoLog("Running Dot steganography decode...");
        console.log("[App] Starting decodeStegoFile for:", file.name, "size:", file.size);
        result = await decodeStegoFile(file);
        console.log("[App] decodeStegoFile result:", result.ok, "error:", result.error, "payloadLen:", result.payload?.length);
      }
      if (!result.ok || !result.payload) {
        const err = result.error || "Decode failed";
        addStegoLog(`FAIL: ${err}`);
        setDecodeError(err);
        logger.logAction("detect_error", err, { name: file.name });
        return;
      }
      addStegoLog(`Decode OK! Payload: ${result.payload.length} chars`);
        const raw = result.payload;
        console.log("[App] Detected payload type:", raw.startsWith("base64:") ? "base64" : "json", "len:", raw.length);
        let jsonString: string;
        if (raw.startsWith("base64:")) {
          addStegoLog("Decoding base64 payload...");
          const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
          addStegoLog(`Decoded: ${bytes.length} bytes, prefix: ${String.fromCharCode(...bytes.slice(0, 8))}`);
          console.log("[App] Decoded encrypted payload bytes:", bytes.length);
          if (!stegoCrypto.isEncryptedPayload(bytes)) {
            addStegoLog("FAIL: Missing STEGSTR1 magic header!");
            setDecodeError("Not a Stegstr encrypted image");
            logger.logAction("detect_error", "Not a Stegstr encrypted image", { name: file.name });
            return;
          }
          addStegoLog("STEGSTR1 header found! Decrypting...");
          let keysToTry = identities.filter((identity) => viewingPubkeys.has(identityPublicKey(identity)));
          if (keysToTry.length === 0 && actingIdentity) keysToTry = [actingIdentity];
          addStegoLog(`Trying ${keysToTry.length} keys...`);
          let lastErr: Error | null = null;
          jsonString = "";
          for (let ki = 0; ki < keysToTry.length; ki++) {
            const identity = keysToTry[ki];
            try {
              addStegoLog(`Trying key ${ki + 1}/${keysToTry.length}...`);
              jsonString = await stegoCrypto.decryptPayloadWithNip04(
                bytes,
                identityPublicKey(identity),
                (payload, sender) => nip04DecryptWithIdentity(identity, sender, payload),
              );
              addStegoLog(`Key ${ki + 1} succeeded! JSON len: ${jsonString.length}`);
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e : new Error(String(e));
              addStegoLog(`Key ${ki + 1} failed: ${lastErr.message}`);
            }
          }
          if (!jsonString && lastErr) {
            addStegoLog("All keys failed, trying app-level decrypt...");
            try {
              jsonString = await stegoCrypto.decryptApp(bytes);
              addStegoLog(`App decrypt succeeded! JSON len: ${jsonString.length}`);
              const parsed = JSON.parse(jsonString);
              if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.events)) lastErr = null;
            } catch (e2) {
              addStegoLog(`App decrypt failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
            }
          }
          if (!jsonString) {
            addStegoLog(`FAIL: Decryption failed - ${lastErr?.message || "unknown error"}`);
            throw lastErr ?? new Error("Decryption failed");
          }
          addStegoLog(`Decryption complete, parsing JSON...`);
        } else if (raw.trimStart().startsWith("{")) {
          jsonString = raw;
        } else {
          setDecodeError("Invalid payload");
          return;
        }
        const bundle = JSON.parse(jsonString) as NostrStateBundle;
        if (!Array.isArray(bundle.events)) {
          setDecodeError("Invalid payload");
          return;
        }
        const normalized = bundle.events.map((e) => ({
          ...e,
          kind: typeof e.kind === "number" ? e.kind : parseInt(String(e.kind), 10) || 1,
          created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
        }));
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          normalized.forEach((e) => byId.set(e.id, e));
          return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
        });
        const profileUpdates: Record<string, ProfileData> = {};
        bundle.events.filter((e) => e.kind === 0).forEach((e) => {
          try {
            const c = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
            profileUpdates[e.pubkey] = { name: c.name ?? c.display_name, about: c.about, picture: c.picture, banner: c.banner, nip05: c.nip05 };
          } catch (_) {}
        });
        if (Object.keys(profileUpdates).length > 0) setProfiles((p) => ({ ...p, ...profileUpdates }));
        setImportedEventIds((prev) => {
          const next = new Set(prev);
          bundle.events.forEach((e) => next.add(e.id));
          if (next.size > 2000) return new Set([...next].slice(-2000));
          return next;
        });
        setDecodeError("");
        setStatus(`Loaded ${bundle.events.length} events from image.`);
        addStegoLog(`SUCCESS - Loaded ${bundle.events.length} events!`);
        logger.logAction("detect_completed", `Loaded ${bundle.events.length} events`, { name: file.name, eventCount: bundle.events.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[App] Detect error:", e);
        setDecodeError(msg);
        logger.logAction("detect_error", msg, { name: file.name });
      } finally {
        setDetecting(false);
        setStegoProgress("");
      }
      return;
    }
    let path: string | null;
    const tauri = await getTauri();
    if (providedPathOrFile === undefined || typeof providedPathOrFile !== "string") {
      setDetecting(true);
      try {
        path = await tauri.openDialog({
          multiple: false,
          filters: [
            { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
            { name: "PNG", extensions: ["png"] },
            { name: "JPEG", extensions: ["jpg", "jpeg"] },
          ],
        });
      } finally {
        setDetecting(false);
      }
      if (!path || typeof path !== "string") {
        setStatus("Cancelled");
        logger.logAction("detect_cancelled", "User cancelled detect file dialog");
        return;
      }
    } else {
      path = providedPathOrFile;
      if (!path || typeof path !== "string") return;
    }
    setDetecting(true);
    addStegoLog(`Selected: ${path}`);
    logger.logAction("detect_started", "Decoding stego image", { path });
    try {
      const isJpeg = /\.jpe?g$/i.test(path);
      let result: { ok: boolean; payload?: string; error?: string };
      setStegoProgress("Extracting hidden data (Dot decode)...");
      addStegoLog("Running Dot steganography decode...");
      console.log("[Detect] Trying Dot decode first:", path);
      result = await tauri.invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_dot", { path });
      console.log("[Detect] Dot result: ok=", result.ok, "error=", result.error ?? "(none)");
      if (!result.ok) {
        addStegoLog(`Dot decode failed: ${result.error ?? "unknown error"}`);
        if (isJpeg) {
          addStegoLog("Falling back to QIM decode (JPEG)...");
          console.log("[Detect] JPEG: falling back to QIM decode:", path);
          result = await tauri.invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_qim", { path });
          console.log("[Detect] QIM result: ok=", result.ok, "error=", result.error ?? "(none)", "payloadLen=", result.payload?.length ?? 0);
        } else {
          addStegoLog("Falling back to DWT decode (PNG/other)...");
          console.log("[Detect] PNG/other: falling back to DWT decode:", path);
          result = await tauri.invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_image", { path });
          console.log("[Detect] DWT result: ok=", result.ok, "error=", result.error ?? "(none)");
        }
      }
      if (!result.ok || !result.payload) {
        const err = result.error || "Decode failed";
        addStegoLog(`FAIL: ${err}`);
        setDecodeError(err);
        logger.logAction("detect_error", err, { path });
        return;
      }
      addStegoLog(`Dot decode OK! Payload: ${result.payload.length} chars`);
      let jsonString: string;
      const raw = result.payload;
      if (raw.startsWith("base64:")) {
        const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
        if (!stegoCrypto.isEncryptedPayload(bytes)) {
          addStegoLog("FAIL: Not a Stegstr encrypted image");
          setDecodeError("Not a Stegstr encrypted image");
          logger.logAction("detect_error", "Not a Stegstr encrypted image", { path });
          return;
        }
        let keysToTry = identities.filter((identity) => viewingPubkeys.has(identityPublicKey(identity)));
        if (keysToTry.length === 0 && actingIdentity) keysToTry = [actingIdentity];
        let lastErr: Error | null = null;
        jsonString = "";
        for (const identity of keysToTry) {
          try {
            jsonString = await stegoCrypto.decryptPayloadWithNip04(
              bytes,
              identityPublicKey(identity),
              (payload, sender) => nip04DecryptWithIdentity(identity, sender, payload),
            );
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
          }
        }
        if (!jsonString && lastErr) {
          try {
            jsonString = await stegoCrypto.decryptApp(bytes);
            const parsed = JSON.parse(jsonString);
            if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.events)) lastErr = null;
          } catch (_) {}
        }
        if (!jsonString) throw lastErr ?? new Error("Decryption failed");
      } else if (raw.trimStart().startsWith("{")) {
        jsonString = raw;
      } else {
        setDecodeError("Invalid payload");
        logger.logAction("detect_error", "Invalid payload", { path });
        return;
      }
      const bundle = JSON.parse(jsonString) as NostrStateBundle;
      if (!Array.isArray(bundle.events)) {
        setDecodeError("Invalid payload");
        logger.logAction("detect_error", "Invalid payload (events not array)", { path });
        return;
      }
      const normalized = bundle.events.map((e) => ({
        ...e,
        kind: typeof e.kind === "number" ? e.kind : parseInt(String(e.kind), 10) || 1,
        created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
      }));
      setEvents((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        normalized.forEach((e) => byId.set(e.id, e));
        return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
      });
      const profileUpdates: Record<string, ProfileData> = {};
      bundle.events.filter((e) => e.kind === 0).forEach((e) => {
        try {
          const raw = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
          profileUpdates[e.pubkey] = {
            name: raw.name ?? raw.display_name,
            about: raw.about,
            picture: raw.picture,
            banner: raw.banner,
            nip05: raw.nip05,
          };
        } catch (_) {}
      });
      if (Object.keys(profileUpdates).length > 0) {
        setProfiles((p) => ({ ...p, ...profileUpdates }));
      }
      setImportedEventIds((prev) => {
        const next = new Set(prev);
        bundle.events.forEach((e) => next.add(e.id));
        if (next.size > 2000) {
          const arr = [...next];
          arr.splice(0, arr.length - 2000);
          return new Set(arr);
        }
        return next;
      });
      setView("feed");
      setFeedFilter("global");
      setSearchQuery("");
      setStatus(`Loaded ${bundle.events.length} events`);
      addStegoLog(`SUCCESS - Loaded ${bundle.events.length} events!`);
      logger.logAction("detect_completed", `Loaded ${bundle.events.length} events`, { path, eventCount: bundle.events.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTauriBridgeError = /undefined.*invoke|__TAURI_INTERNALS__/i.test(String(msg));
      setDecodeError(
        isTauriBridgeError
          ? "Detect requires the Stegstr desktop app. Run: npm run tauri dev (not in a browser)"
          : msg
      );
      logger.logError("Detect failed", e, { path });
    } finally {
      setDetecting(false);
      setStegoProgress("");
    }
  }, [actingIdentity, identities, viewingPubkeys, addStegoLog]);

  useEffect(() => {
    if (isWeb()) return;
    let unlisten: (() => void) | null = null;
    getTauri()
      .then((t) => t.getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths?.length) {
          handleLoadFromImage(event.payload.paths[0]);
        }
      }))
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [handleLoadFromImage]);

  const handleSaveToImage = useCallback(() => {
    setDecodeError("");
    setStegoLogs([]);
    if (isWeb()) setEmbedCoverFile(null);
    setEmbedModalOpen(true);
  }, []);

  const handleDetectFromExchange = useCallback(async () => {
    if (isWeb()) return;
    try {
      const tauri = await getTauri();
      const path = await tauri.invoke<string>("get_exchange_path");
      handleLoadFromImage(path);
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
    }
  }, [handleLoadFromImage]);

  const handleEmbedToExchange = useCallback(async () => {
    if (isWeb() || !profile) return;
    setDecodeError("");
    setDetecting(true);
    logger.logAction("embed_started", "Embed to exchange (quick test)", { eventCount: events.length });
    try {
      const tauri = await getTauri();
      const coverPath = await tauri.openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setDetecting(false);
        return;
      }
      const outputPath = await tauri.invoke<string>("get_exchange_path");
      const bundle: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events };
      const jsonString = JSON.stringify(bundle);
      const encrypted = await stegoCrypto.encryptOpen(jsonString);
      const payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
      const cmd = "encode_stego_dot";
      const result = await tauri.invoke<{ ok: boolean; path?: string; error?: string }>(cmd, {
        coverPath,
        outputPath,
        payload: payloadToEmbed,
      });
      if (result.ok && result.path) {
        try {
          const isPng = await tauri.invoke<boolean>("check_png_signature", { path: result.path });
          addStegoLog(`PNG signature check: ${isPng ? "OK" : "FAIL"}`);
        } catch (e) {
          addStegoLog(`PNG signature check error: ${e instanceof Error ? e.message : String(e)}`);
        }
        addStegoLog(`Saved to: ${result.path}`);
        setStatus(`Saved to exchange. B can click Detect from exchange.`);
        logger.logAction("embed_completed", "Embed to exchange done", { path: result.path, eventCount: events.length });
      } else {
        setDecodeError(result.error || "Encode failed");
      }
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      logger.logError("Embed to exchange failed", e, {});
    } finally {
      setDetecting(false);
    }
  }, [profile, events, embedMethod]);

  const handleEmbedConfirm = useCallback(async () => {
    if (!embedModalOpen) return;
    setDecodeError("");
    setEmbedding(true);
    setStegoProgress("Preparing data...");
    addStegoLog("Starting embed flow...");
    logger.logAction("embed_started", "Starting embed flow", { eventCount: events.length });
    try {
      if (isWeb()) {
        if (!embedCoverFile) {
          setDecodeError("Choose an image first.");
          setEmbedding(false);
          addStegoLog("Error: No image selected");
          return;
        }
        addStegoLog(`Cover image: ${embedCoverFile.name} (${embedCoverFile.size} bytes)`);
        const pubkeysInEmbed = new Set(events.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])]));
        const kind0InEvents = new Set(events.filter((e) => e.kind === 0).map((e) => e.pubkey));
        const syntheticKind0: NostrEvent[] = [];
        for (const pk of pubkeysInEmbed) {
          if (!pk || kind0InEvents.has(pk)) continue;
          const idForPk = identities.find((i) => identityPublicKey(i) === pk);
          if (!idForPk) continue;
          const prof = profiles[pk];
          if (!prof) continue;
          try {
            const content = JSON.stringify(prof);
            const ev = await signEventWithIdentity(idForPk, { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) });
            syntheticKind0.push(ev as NostrEvent);
          } catch (_) {}
        }
        const buildBundle = async (eventList: NostrEvent[]) => {
          const pubkeysInEmbed = new Set(
            eventList.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])])
          );
          const kind0InEvents = new Set(eventList.filter((e) => e.kind === 0).map((e) => e.pubkey));
          const synthetic: NostrEvent[] = [];
          for (const pk of pubkeysInEmbed) {
            if (!pk || kind0InEvents.has(pk)) continue;
            const idForPk = identities.find((i) => identityPublicKey(i) === pk);
            if (!idForPk) continue;
            const prof = profiles[pk];
            if (!prof) continue;
            try {
              const content = JSON.stringify(prof);
              const ev = await signEventWithIdentity(idForPk, { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) });
              synthetic.push(ev as NostrEvent);
            } catch (_) {}
          }
          return { version: STEGSTR_BUNDLE_VERSION, events: [...synthetic, ...eventList] } as NostrStateBundle;
        };
        // Helper: encrypt and fit payload to capacity, trimming events if needed
        const encryptAndFit = async (maxPayloadBytes: number) => {
          let trimmedEvents = [...events];
          let encrypted: Uint8Array | null = null;
          while (true) {
            const bundle = await buildBundle(trimmedEvents);
            const jsonString = JSON.stringify(bundle);
            addStegoLog(`Bundle: ${trimmedEvents.length} events, ${jsonString.length} bytes JSON`);
            if (embedRecipientMode === "recipients" && embedRecipients.length > 0 && actingIdentity) {
              const selfPk = identityPublicKey(actingIdentity);
              const allRecipients = Array.from(new Set([selfPk, ...embedRecipients]));
              addStegoLog(`Encrypting for ${allRecipients.length} recipient(s)...`);
              encrypted = await stegoCrypto.encryptForRecipientsWithNip04(
                jsonString,
                selfPk,
                allRecipients,
                (plaintext, recipient) => nip04EncryptWithIdentity(actingIdentity, recipient, plaintext),
              );
            } else {
              addStegoLog("Encrypting for any Stegstr user...");
              encrypted = await stegoCrypto.encryptOpen(jsonString);
            }
            if (!maxPayloadBytes || encrypted.length <= maxPayloadBytes) break;
            if (trimmedEvents.length === 0) break;
            trimmedEvents = trimmedEvents.slice(0, -1);
          }
          if (!encrypted || (maxPayloadBytes && encrypted.length > maxPayloadBytes)) {
            return null;
          }
          if (trimmedEvents.length < events.length) {
            addStegoLog(`Trimmed events: kept ${trimmedEvents.length}/${events.length} to fit capacity`);
          }
          addStegoLog(`Encrypted: ${encrypted.length} bytes`);
          return encrypted;
        };

        if (embedMethod === "qim") {
          // ===== QIM BRANCH =====
          addStegoLog(`Using QIM method (target platform: ${targetPlatform})`);

          // Step 1: Pre-resize cover for platform
          setStegoProgress("Pre-resizing image for target platform...");
          const platformWidth = PLATFORM_WIDTHS[targetPlatform] ?? PLATFORM_WIDTHS[DEFAULT_PLATFORM];
          let resizedCover: File;
          try {
            resizedCover = await resizeCoverForPlatform(embedCoverFile, platformWidth);
            addStegoLog(`Resized cover: ${resizedCover.name} (${resizedCover.size} bytes)`);
          } catch (e) {
            setDecodeError(`Resize failed: ${e instanceof Error ? e.message : String(e)}`);
            setEmbedding(false);
            return;
          }

          // Step 2: Check QIM capacity
          const { capacityBytes: maxPayloadBytes, width: resW, height: resH } = await getQimCapacityForFile(embedCoverFile, targetPlatform);
          addStegoLog(`QIM capacity: ${maxPayloadBytes} bytes (${resW}x${resH})`);

          // Step 3: Encrypt and fit payload
          const encrypted = await encryptAndFit(maxPayloadBytes);
          if (!encrypted) {
            setDecodeError("Image too small for stego payload (try a larger image or fewer events)");
            setEmbedding(false);
            return;
          }

          // Step 4: QIM embed
          setStegoProgress("Embedding data into image (QIM encode)...");
          addStegoLog("Running QIM steganography encode...");
          let blob: Blob;
          try {
            blob = await encodeQimImageFile(resizedCover, encrypted);
            addStegoLog(`QIM encode complete! Output: ${blob.size} bytes JPEG`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setDecodeError(`QIM encode failed: ${msg}`);
            setEmbedding(false);
            return;
          }

          // Step 5: Round-trip self-test
          setStegoProgress("Verifying embed integrity (self-test)...");
          addStegoLog("Running round-trip self-test...");
          const selfTestResult = await qimSelfTest(blob, encrypted);
          if (selfTestResult.ok) {
            addStegoLog("Self-test PASSED! Payload survives encode/decode round-trip.");
          } else {
            addStegoLog(`Self-test FAILED: ${selfTestResult.error}`);
            addStegoLog("WARNING: Payload may not survive platform transforms. Consider using Dot method instead.");
          }

          // Step 6: Download
          const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
          setStegoProgress("Downloading embedded image...");
          addStegoLog(`Triggering download: ${name}-stegstr.jpg`);
          downloadBlob(blob, `${name}-stegstr.jpg`);
          addStegoLog("SUCCESS - Download started!");
          setEmbedModalOpen(false);
          setEmbedCoverFile(null);
          setEmbedding(false);
          setStegoProgress("");
          setStatus("Image downloaded. Save it from your Downloads folder.");
          logger.logAction("embed_completed", "QIM embed saved (browser download)", { eventCount: events.length, platform: targetPlatform });
          return;
        }

        // ===== DOT BRANCH (legacy) =====
        const maxPayloadBytes = await getDotCapacityForFile(embedCoverFile);
        addStegoLog(`Dot capacity: ${maxPayloadBytes} bytes`);
        const encrypted = await encryptAndFit(maxPayloadBytes);
        if (!encrypted) {
          setDecodeError("Image too small for stego payload");
          setEmbedding(false);
          return;
        }
        const payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
        setStegoProgress("Embedding data into image (Dot encode)...");
        addStegoLog("Running Dot steganography encode...");
        const blob = await encodeStegoToBlob(embedCoverFile, payloadToEmbed);
        addStegoLog(`Dot encode complete! Output: ${blob.size} bytes PNG`);
        const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
        setStegoProgress("Downloading embedded image...");
        addStegoLog(`Triggering download: ${name}-stegstr.png`);
        downloadBlob(blob, `${name}-stegstr.png`);
        addStegoLog("SUCCESS - Download started!");
        setEmbedModalOpen(false);
        setEmbedCoverFile(null);
        setEmbedding(false);
        setStegoProgress("");
        setStatus("Image downloaded. Save it from your Downloads folder.");
        logger.logAction("embed_completed", "Dot embed saved (browser download)", { eventCount: events.length });
        return;
      }
      const tauri = await getTauri();
      const coverPath = await tauri.openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setEmbedModalOpen(false);
        return;
      }
      const coverName = coverPath.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "") || "image";
      const ext = "png";
      let defaultPath = `${coverName}.${ext}`;
      try {
        const desktop = await tauri.invoke<string>("get_desktop_path");
        if (desktop) defaultPath = `${desktop}/${coverName}.${ext}`;
      } catch (_) {}
      const outputPath = await tauri.saveDialog({
        filters: [{ name: "PNG", extensions: [ext] }],
        defaultPath,
      });
      if (!outputPath) {
        setEmbedModalOpen(false);
        return;
      }
      const finalOutputPath = outputPath.endsWith(`.${ext}`) ? outputPath : outputPath + `.${ext}`;
      let maxPayloadBytes = 0;
      try {
        maxPayloadBytes = await tauri.invoke<number>("get_dot_capacity", { path: coverPath });
        addStegoLog(`Dot capacity: ${maxPayloadBytes} bytes`);
      } catch (e) {
        addStegoLog(`Dot capacity check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const buildBundle = async (eventList: NostrEvent[]) => {
        const pubkeysInEmbed = new Set(
          eventList.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])])
        );
        const kind0InEvents = new Set(eventList.filter((e) => e.kind === 0).map((e) => e.pubkey));
        const syntheticKind0: NostrEvent[] = [];
        for (const pk of pubkeysInEmbed) {
          if (!pk || kind0InEvents.has(pk)) continue;
          const idForPk = identities.find((i) => identityPublicKey(i) === pk);
          if (!idForPk) continue;
          const prof = profiles[pk];
          if (!prof) continue;
          try {
            const content = JSON.stringify(prof);
            const ev = await signEventWithIdentity(idForPk, { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) });
            syntheticKind0.push(ev as NostrEvent);
          } catch (_) {}
        }
        return { version: STEGSTR_BUNDLE_VERSION, events: [...syntheticKind0, ...eventList] } as NostrStateBundle;
      };
      let trimmedEvents = [...events];
      let jsonString = "";
      let payloadBytes: Uint8Array | null = null;
      while (true) {
        const bundle = await buildBundle(trimmedEvents);
        jsonString = JSON.stringify(bundle);
        const encrypted = await stegoCrypto.encryptOpen(jsonString);
        if (!maxPayloadBytes || encrypted.length <= maxPayloadBytes) {
          payloadBytes = encrypted;
          break;
        }
        if (trimmedEvents.length === 0) break;
        trimmedEvents = trimmedEvents.slice(0, -1);
      }
      if (!payloadBytes) {
        setDecodeError("Image too small for stego payload");
        return;
      }
      if (trimmedEvents.length < events.length) {
        addStegoLog(`Trimmed events: kept ${trimmedEvents.length}/${events.length} to fit capacity`);
      }
      const payloadToEmbed = "base64:" + uint8ArrayToBase64(payloadBytes);
      setStegoProgress("Embedding with Dot (offset, robust)...");
      const cmd = "encode_stego_dot";
      const result = await tauri.invoke<{ ok: boolean; path?: string; error?: string }>(cmd, {
        coverPath,
        outputPath: finalOutputPath,
        payload: payloadToEmbed,
      });
      setEmbedModalOpen(false);
      if (result.ok && result.path) {
        try {
          const isPng = await tauri.invoke<boolean>("check_png_signature", { path: result.path });
          addStegoLog(`PNG signature check: ${isPng ? "OK" : "FAIL"}`);
        } catch (e) {
          addStegoLog(`PNG signature check error: ${e instanceof Error ? e.message : String(e)}`);
        }
        addStegoLog(`Saved to: ${result.path}`);
        setStatus(`Saved to ${result.path}. Finder opened.`);
        logger.logAction("embed_completed", "Embed saved successfully", { path: result.path, eventCount: events.length });
        try {
          await tauri.invoke("reveal_in_finder", { path: result.path });
        } catch (_) {}
      } else {
        const err = result.error || "Encode failed";
        setDecodeError(err);
        logger.logAction("embed_error", err, { coverPath, outputPath: finalOutputPath });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[App] Embed error:", e);
      setDecodeError(msg);
      logger.logError("Embed failed", e, {});
      setEmbedModalOpen(false);
    } finally {
      setEmbedding(false);
      setStegoProgress("");
    }
  }, [embedModalOpen, embedCoverFile, events, profiles, identities, actingIdentity, addStegoLog, embedRecipientMode, embedRecipients, embedMethod, targetPlatform]);

  const resolvePubkeyFromInput = useCallback((input: string): string | null => {
    const s = input.trim().replace(/\s/g, "");
    const npubMatch = s.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") return Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    }
    if (/^[a-fA-F0-9]{64}$/.test(s)) return s.toLowerCase();
    return null;
  }, []);

  const handleSendDm = useCallback(
    async (theirPubkeyHex: string, content: string) => {
      if (!actingIdentity || !content.trim()) return;
      try {
        const encrypted = await nip04EncryptWithIdentity(actingIdentity, theirPubkeyHex, content.trim());
        const ev = await signEventWithIdentity(actingIdentity, {
          kind: 4, content: encrypted, tags: [["p", theirPubkeyHex]], created_at: Math.floor(Date.now() / 1000),
        });
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setDmReplyContent("");
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Message sent");
        logger.logAction("dm_send", "DM sent", { to: theirPubkeyHex.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Send failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("DM send failed", e, { to: theirPubkeyHex.slice(0, 8) + "…" });
      }
    },
    [actingIdentity, networkEnabled, canPublishToNetwork, publishViaRelay]
  );

  const handlePost = useCallback(async () => {
    if (!actingIdentity) return;
    const textPart = newPost.trim();
    const mediaPart = postMediaUrls.length ? "\n" + postMediaUrls.join("\n") : "";
    if (!textPart && !postMediaUrls.length) return;
    const content = ensureStegstrSuffix((textPart || " ") + mediaPart);
    const tags: string[][] = postMediaUrls.flatMap((url) => [["im", url]]);
    const ev = await signEventWithIdentity(actingIdentity, { kind: 1, content, tags, created_at: Math.floor(Date.now() / 1000) });
    setEvents((prev) => [ev as NostrEvent, ...prev]);
    setNewPost("");
    setPostMediaUrls([]);
    if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
    setStatus("Posted");
    logger.logAction("post", "Posted note", { networkEnabled, contentLength: content.length, mediaCount: postMediaUrls.length });
  }, [actingIdentity, newPost, postMediaUrls, networkEnabled, canPublishToNetwork, publishViaRelay]);

  const handleLike = useCallback(
    async (note: NostrEvent) => {
      if (!actingIdentity) return;
      try {
        const ev = await signEventWithIdentity(actingIdentity, {
          kind: 7, content: "+", tags: [["e", note.id], ["p", note.pubkey]], created_at: Math.floor(Date.now() / 1000),
        });
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Liked");
        logger.logAction("like", "Liked note", { noteId: note.id.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Like failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Like failed", e, { noteId: note.id.slice(0, 8) + "…" });
      }
    },
    [actingIdentity, networkEnabled, canPublishToNetwork, publishViaRelay]
  );

  const handleRepost = useCallback(
    async (note: NostrEvent) => {
      if (!actingIdentity) return;
      try {
        const ev = await signEventWithIdentity(actingIdentity, {
          kind: 6, content: JSON.stringify(note), tags: [["e", note.id], ["p", note.pubkey]], created_at: Math.floor(Date.now() / 1000),
        });
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Reposted");
      } catch (e) {
        setStatus("Repost failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [actingIdentity, networkEnabled, canPublishToNetwork, publishViaRelay]
  );

  const handleDelete = useCallback(
    async (note: NostrEvent) => {
      if (!selfPubkeys.includes(note.pubkey)) return;
      const identityForNote = identities.find((i) => identityPublicKey(i) === note.pubkey) ?? actingIdentity;
      if (!identityForNote) return;
      try {
        const ev = await signEventWithIdentity(identityForNote, { kind: 5, content: "", tags: [["e", note.id]], created_at: Math.floor(Date.now() / 1000) });
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Note deleted");
      } catch (e) {
        setStatus("Delete failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [actingIdentity, identities, selfPubkeys, networkEnabled, canPublishToNetwork, publishViaRelay]
  );

  const handleBookmark = useCallback(
    async (note: NostrEvent) => {
      if (!actingIdentity || !pubkey) return;
      const existing = bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? [];
      if (existing.includes(note.id)) return;
      try {
        const newTags = [...existing.map((id) => ["e", id] as [string, string]), ["e", note.id]];
        const ev = await signEventWithIdentity(actingIdentity, { kind: 10003, content: "", tags: newTags, created_at: Math.floor(Date.now() / 1000) });
        setEvents((prev) => prev.filter((e) => !(e.kind === 10003 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Bookmarked");
      } catch (e) {
        setStatus("Bookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [actingIdentity, pubkey, networkEnabled, canPublishToNetwork, bookmarksEvent, publishViaRelay]
  );

  const handleUnbookmark = useCallback(
    async (note: NostrEvent) => {
      if (!actingIdentity || !pubkey) return;
      const existing = bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? [];
      if (!existing.includes(note.id)) return;
      try {
        const newTags = existing.filter((id) => id !== note.id).map((id) => ["e", id] as [string, string]);
        const ev = await signEventWithIdentity(actingIdentity, { kind: 10003, content: "", tags: newTags, created_at: Math.floor(Date.now() / 1000) });
        setEvents((prev) => prev.filter((e) => !(e.kind === 10003 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Removed from bookmarks");
      } catch (e) {
        setStatus("Unbookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [actingIdentity, pubkey, networkEnabled, canPublishToNetwork, bookmarksEvent, publishViaRelay]
  );

  const getRootId = useCallback((note: NostrEvent): string => {
    const eTag = note.tags.find((t) => t[0] === "e");
    return eTag ? eTag[1] : note.id;
  }, []);

  const handleReply = useCallback(
    async () => {
      if (!actingIdentity || !replyingTo || !replyContent.trim()) return;
      const rootId = getRootId(replyingTo);
      try {
        const tags: string[][] = [["e", rootId], ["e", replyingTo.id], ["p", replyingTo.pubkey]];
        const ev = await signEventWithIdentity(actingIdentity, {
          kind: 1, content: ensureStegstrSuffix(replyContent.trim()), tags, created_at: Math.floor(Date.now() / 1000),
        });
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setReplyingTo(null);
        setReplyContent("");
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Replied");
        logger.logAction("reply", "Replied to note", { rootId, networkEnabled });
      } catch (e) {
        setStatus("Reply failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Reply failed", e, { rootId });
      }
    },
    [actingIdentity, replyingTo, replyContent, networkEnabled, canPublishToNetwork, getRootId, publishViaRelay]
  );

  const openZapUrl = useCallback((url: string) => {
    try {
      window.open(url, "_blank", "noopener");
    } catch (_) {}
  }, []);

  const flushQueuedZaps = useCallback(() => {
    if (!networkEnabled || !canPublishToNetwork || queuedZaps.length === 0) return;
    const pending = [...queuedZaps];
    setQueuedZaps([]);
    pending.forEach((zap) => {
      try {
        publishViaRelay(zap.event as NostrEvent);
      } catch (_) {}
      openZapUrl(zap.zapStreamUrl);
    });
    setStatus(pending.length === 1 ? "Queued zap sent" : `Queued zaps sent (${pending.length})`);
  }, [networkEnabled, canPublishToNetwork, queuedZaps, openZapUrl, publishViaRelay]);

  useEffect(() => {
    if (!networkEnabled || !canPublishToNetwork || !(relayStatus.startsWith("Synced") || relayStatus.startsWith("Partially synced"))) return;
    if (queuedZaps.length === 0) return;
    flushQueuedZaps();
  }, [networkEnabled, canPublishToNetwork, relayStatus, queuedZaps.length, flushQueuedZaps]);

  const handleZap = useCallback(
    async (note: NostrEvent) => {
      if (!actingIdentity) return;
      if (!canPublishToNetwork) {
        setStatus("Zaps require a Nostr identity");
        return;
      }
      try {
        const zapRequest = await signEventWithIdentity(actingIdentity, {
          kind: 9734,
          content: "Zap request",
          tags: [["e", note.id], ["p", note.pubkey], ["relays", ...relayUrls]],
          created_at: Math.floor(Date.now() / 1000),
        });
        const zapStreamUrl = `https://zap.stream/e/${note.id}`;
        if (networkEnabled) {
          publishViaRelay(zapRequest as NostrEvent);
          openZapUrl(zapStreamUrl);
          setStatus("Zap sent");
        } else {
          const queued: QueuedZap = {
            id: zapRequest.id,
            noteId: note.id,
            event: zapRequest as NostrEvent,
            createdAt: Date.now(),
            zapStreamUrl,
          };
          setQueuedZaps((prev) => [...prev, queued]);
          setStatus("Zap queued. Turn Network ON to send.");
        }
      } catch (e) {
        setStatus("Zap failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [actingIdentity, networkEnabled, canPublishToNetwork, relayUrls, openZapUrl, publishViaRelay]
  );

  const handleEditProfileOpen = useCallback(() => {
    setEditName(myName);
    setEditAbout(myAbout);
    setEditPicture(myPicture ?? "");
    setEditBanner(myBanner ?? "");
    setEditProfileOpen(true);
  }, [myName, myAbout, myPicture, myBanner]);

  const handleEditProfileSave = useCallback(async () => {
    if (!actingIdentity || !pubkey) return;
    const content = JSON.stringify({
      name: editName.trim() || undefined,
      about: editAbout.trim() || undefined,
      picture: editPicture.trim() || undefined,
      banner: editBanner.trim() || undefined,
    });
    const ev = await signEventWithIdentity(actingIdentity, { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) });
    setEvents((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      byId.set(ev.id, ev as NostrEvent);
      return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
    });
    setProfiles((p) => ({
      ...p,
      [(ev as NostrEvent).pubkey]: {
        name: editName.trim() || undefined,
        about: editAbout.trim() || undefined,
        picture: editPicture.trim() || undefined,
        banner: editBanner.trim() || undefined,
      },
    }));
    setEditProfileOpen(false);
    // Never publish kind 0 for Nostr identities—their profile lives on Nostr; publishing would overwrite it
    const isNostr = actingIdentity?.type === "nostr";
    if (canPublishToNetwork && !isNostr) publishViaRelay(ev as NostrEvent);
    setStatus(isNostr ? "Profile updated (local only)" : "Profile updated");
    logger.logAction("profile_edit", isNostr ? "Profile updated (local only)" : "Profile updated", { networkEnabled, isNostr });
  }, [actingIdentity, pubkey, editName, editAbout, editPicture, editBanner, networkEnabled, canPublishToNetwork, publishViaRelay]);

  const handlePostMediaUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    e.target.value = "";
    setUploadingMedia(true);
    setStatus("Uploading…");
    try {
      const urls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
          const url = await uploadMedia(file);
          urls.push(url);
        }
      }
      setPostMediaUrls((prev) => [...prev, ...urls]);
      setStatus(urls.length ? `Uploaded ${urls.length} file(s)` : "Select image or video files");
    } catch (err) {
      setStatus("Upload failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setUploadingMedia(false);
    }
  }, []);

  const handleFollow = useCallback(
    async (theirPk: string) => {
      if (!actingIdentity || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      const existingTags = kind3 ? kind3.tags.filter((t) => t[0] === "p") : [];
      if (existingTags.some((t) => t[1] === theirPk)) {
        setStatus("Already following");
        return;
      }
      try {
        const newTags = [...existingTags.map((t) => ["p", t[1]]), ["p", theirPk]];
        const ev = await signEventWithIdentity(actingIdentity, { kind: 3, content: kind3?.content ?? "", tags: newTags, created_at: Math.floor(Date.now() / 1000) });
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Following");
        logger.logAction("follow", "Followed pubkey", { theirPk: theirPk.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Follow failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Follow failed", e, { theirPk: theirPk.slice(0, 8) + "…" });
      }
    },
    [actingIdentity, pubkey, events, networkEnabled, canPublishToNetwork, publishViaRelay]
  );

  const handleUnfollow = useCallback(
    async (theirPk: string) => {
      if (!actingIdentity || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      if (!kind3) return;
      const newTags = kind3.tags.filter((t) => t[0] !== "p" || t[1] !== theirPk);
      try {
        const ev = await signEventWithIdentity(actingIdentity, { kind: 3, content: kind3.content, tags: newTags, created_at: Math.floor(Date.now() / 1000) });
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Unfollowed");
      } catch (e) {
        setStatus("Unfollow failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [actingIdentity, pubkey, events, networkEnabled, canPublishToNetwork, publishViaRelay]
  );

  useEffect(() => {
    if (!actingIdentity || actingIdentity.type !== "nostr" || actingIdentity.category !== "nostr" || hasSyncedAnonRef.current) return;
    hasSyncedAnonRef.current = true;
    const localIdentity = identities.find((identity) => identity.type === "local");
    if (!localIdentity) return;
    const anonPubkey = identityPublicKey(localIdentity);
    let cancelled = false;
    (async () => {
      const anonEvents = events.filter((e) => e.pubkey === anonPubkey);
      if (anonEvents.length === 0) return;
      const newEvents: NostrEvent[] = [];
      for (const ev of anonEvents) {
        if (cancelled) return;
        try {
          const content = ev.kind === 1 ? ensureStegstrSuffix(ev.content) : ev.content;
          const newEv = await signEventWithIdentity(actingIdentity, { kind: ev.kind, content, tags: ev.tags, created_at: ev.created_at });
          publishViaRelay(newEv as NostrEvent);
          newEvents.push(newEv as NostrEvent);
        } catch (_) {}
      }
      if (!cancelled && newEvents.length > 0) {
        setEvents((prev) => {
          const withoutAnon = prev.filter((e) => e.pubkey !== anonPubkey);
          return [...withoutAnon, ...newEvents].sort((a, b) => b.created_at - a.created_at);
        });
        setStatus("Synced previous posts to Nostr");
      }
    })();
    return () => { cancelled = true; };
  }, [actingIdentity, identities, events, publishViaRelay]);

  // --- Shared NoteCard state & actions ---
  const noteCardState: NoteCardState = useMemo(() => ({
    profiles,
    selfPubkeys,
    getIdentityLabels: getIdentityLabelsForPubkey,
    hasLiked,
    hasBookmarked,
    getLikeCount,
    getZapCount,
  }), [profiles, selfPubkeys, getIdentityLabelsForPubkey, hasLiked, hasBookmarked, getLikeCount, getZapCount]);

  const navigateToProfile = useCallback((pk: string) => {
    setViewingProfilePubkey(pk);
    setView("profile");
  }, []);

  const noteCardActions: NoteCardActions = useMemo(() => ({
    onNavigateProfile: navigateToProfile,
    onReply: (ev: NostrEvent) => { setReplyingTo(ev); setReplyContent(""); },
    onLike: handleLike,
    onRepost: handleRepost,
    onZap: handleZap,
    onBookmark: handleBookmark,
    onUnbookmark: handleUnbookmark,
    onDelete: handleDelete,
  }), [navigateToProfile, handleLike, handleRepost, handleZap, handleBookmark, handleUnbookmark, handleDelete]);

  /** Actions for views that redirect reply to the feed. */
  const noteCardActionsRedirectReply: NoteCardActions = useMemo(() => ({
    ...noteCardActions,
    onReply: (ev: NostrEvent) => { setReplyingTo(ev); setReplyContent(""); setView("feed"); },
  }), [noteCardActions]);

  const handleReplyCancel = useCallback(() => { setReplyingTo(null); setReplyContent(""); }, []);

  return (
    <main className="app-root primal-layout">
      <header className="top-header">
        <h1 className="app-title">
          <img src={`${import.meta.env.BASE_URL}LOGO.png`} alt="" className="app-logo" />
          Stegstr
        </h1>
        <div className="header-actions">
          <div className="network-toggle-wrap">
            <span className="network-label">Network</span>
            <button
              type="button"
              role="switch"
              aria-checked={networkEnabled}
              className={`network-toggle ${networkEnabled ? "on" : "off"}`}
              onClick={() => setNetworkEnabled((v) => !v)}
            >
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="toggle-state off">OFF</span>
              <span className="toggle-state on">ON</span>
            </button>
            <span className="network-status">{networkEnabled ? "ON" : "OFF"}</span>
            {!networkEnabled && (
              <span className="network-off-notice" title="When Network is OFF, no data is sent over the internet. Detect and Embed run entirely in your browser.">
                No internet — local only. Detect &amp; Embed stay in your browser; nothing is sent.
              </span>
            )}
          </div>
          {actingIdentity && (
            <span className="acting-identity" title={`Acting as ${profiles[actingPubkey ?? ""]?.name || actingIdentity.label} (${(actingIdentity.category ?? (actingIdentity.type === "nostr" ? "nostr" : "local")) === "nostr" ? "Nostr" : "Local"})`}>
              as {profiles[actingPubkey ?? ""]?.name || actingIdentity.label} ({(actingIdentity.category ?? (actingIdentity.type === "nostr" ? "nostr" : "local")) === "nostr" ? "Nostr" : "Local"})
            </span>
          )}
          {queuedZaps.length > 0 && (
            <button
              type="button"
              className="queued-zaps"
              onClick={flushQueuedZaps}
              disabled={!networkEnabled || !canPublishToNetwork}
              title={networkEnabled ? "Send queued zaps now" : "Queued zaps will send when Network is ON"}
            >
              Queued zaps <span className="queued-zaps-count">{queuedZaps.length}</span>
              <span className="queued-zaps-label">{networkEnabled ? "Send now" : "Waiting"}</span>
            </button>
          )}
          {relayStatus && <span className="relay-status">{relayStatus}</span>}
        </div>
      </header>

      {view === "feed" && (
        <div className="search-bar-wrap">
          <input
            type="search"
            placeholder="Search by text, hashtags, npub or hex pubkey, or name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && networkEnabled && relayRef.current && searchQuery.trim().length >= 2) {
                try {
                  relayRef.current.requestSearch(searchQuery.trim());
                  relayRef.current.requestProfileSearch(searchQuery.trim());
                } catch (err) {
                  console.error("[Stegstr] search on enter error", err);
                }
              }
            }}
            className="search-input"
          />
          {searchQuery.trim() && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div className="body-wrap">
        <aside className="sidebar left">
          <div className="profile-card">
            {myPicture ? (
              <img src={myPicture} alt="" className="profile-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ) : (
              <div className="profile-avatar placeholder">{myName.slice(0, 1)}</div>
            )}
            <strong className="profile-name">{myName}</strong>
            {myAbout && <p className="profile-about">{myAbout.slice(0, 120)}{myAbout.length > 120 ? "…" : ""}</p>}
            {isNostrLoggedIn ? (
              !myProfile?.name && !myProfile?.picture && !myProfile?.about ? (
                <>
                  <p className="profile-note muted">{networkEnabled ? "Fetching profile from relays…" : "Turn Network ON to fetch profile"}</p>
                  {networkEnabled && actingPubkey && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ marginTop: "0.5rem" }}
                      onClick={() => {
                        relayRef.current?.requestProfiles([actingPubkey]);
                        relayRef.current?.requestAuthor(actingPubkey);
                        setStatus("Refreshing profile…");
                      }}
                    >
                      Refresh profile
                    </button>
                  )}
                </>
              ) : (
                <p className="profile-note muted">From Nostr</p>
              )
            ) : (
              <p className="profile-note muted">Local identity · Add Nostr to sync</p>
            )}
            {isNostrLoggedIn ? (
              <p className="profile-note muted">Nostr profile is from relays. Update via a Nostr client.</p>
            ) : (
              <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
            )}
          </div>
          <nav className="side-nav">
            <button type="button" className={view === "feed" ? "active" : ""} onClick={() => setView("feed")}>Home</button>
            <button type="button" className={view === "identity" ? "active" : ""} onClick={() => setView("identity")}>Identity</button>
            <button type="button" className={view === "notifications" ? "active" : ""} onClick={() => setView("notifications")}>Notifications{totalUnreadNotifCount > 0 && <span className="nav-badge">{totalUnreadNotifCount}</span>}</button>
            <button type="button" className={view === "messages" ? "active" : ""} onClick={() => setView("messages")}>Messages{totalUnreadDmCount > 0 && <span className="nav-badge">{totalUnreadDmCount}</span>}</button>
            <button type="button" className={view === "profile" ? "active" : ""} onClick={() => { setViewingProfilePubkey(null); setView("profile"); }}>Profile</button>
            <button type="button" className={view === "followers" ? "active" : ""} onClick={() => setView("followers")}>Following ({contactsSet.size})</button>
            <button type="button" className={view === "bookmarks" ? "active" : ""} onClick={() => setView("bookmarks")}>Bookmarks</button>
            <button type="button" className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}>Explore</button>
            <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
          </nav>
        </aside>

        <div className="main-content">
          {view === "feed" && (
            <FeedView
              myPicture={myPicture}
              myName={myName}
              newPost={newPost}
              setNewPost={setNewPost}
              postMediaUrls={postMediaUrls}
              setPostMediaUrls={setPostMediaUrls}
              uploadingMedia={uploadingMedia}
              postMediaInputRef={postMediaInputRef}
              handlePostMediaUpload={handlePostMediaUpload}
              handlePost={handlePost}
              feedFilter={feedFilter}
              setFeedFilter={setFeedFilter}
              notesEmpty={notes.length === 0}
              feedItems={feedItems}
              searchTrim={searchTrim}
              searchLower={searchLower}
              searchNoSpaces={searchNoSpaces}
              searchPubkeyHex={searchPubkeyHex}
              npubStr={npubStr}
              networkEnabled={networkEnabled}
              profiles={profiles}
              pubkey={pubkey}
              focusedNoteId={focusedNoteId}
              notes={notes}
              getRepliesTo={getRepliesTo}
              noteCardState={noteCardState}
              noteCardActions={noteCardActions}
              replyingTo={replyingTo}
              replyContent={replyContent}
              onReplyContentChange={setReplyContent}
              handleReply={handleReply}
              handleReplyCancel={handleReplyCancel}
              loadingMore={loadingMore}
              loadMoreSentinelRef={loadMoreSentinelRef}
              setViewingProfilePubkey={setViewingProfilePubkey}
              setView={setView}
            />
          )}

          {view === "messages" && (
            <MessagesView
              dmEvents={dmEvents}
              selfPubkeys={selfPubkeys}
              dmDecrypted={dmDecrypted}
              profiles={profiles}
              lastReadTimestamps={lastReadTimestamps}
              recentDmPartners={recentDmPartners}
              selectedMessagePeer={selectedMessagePeer}
              setSelectedMessagePeer={setSelectedMessagePeer}
              myName={myName}
              dmReplyContent={dmReplyContent}
              setDmReplyContent={setDmReplyContent}
              handleSendDm={handleSendDm}
              onNewMessage={() => setNewMessageModalOpen(true)}
            />
          )}

          {view === "followers" && (
            <FollowingView
              followingSearchInput={followingSearchInput}
              setFollowingSearchInput={setFollowingSearchInput}
              contactsSet={contactsSet}
              profiles={profiles}
              pubkey={pubkey}
              resolvePubkeyFromInput={resolvePubkeyFromInput}
              handleFollow={handleFollow}
              handleUnfollow={handleUnfollow}
              relayRef={relayRef}
              onStatus={setStatus}
              onNavigateProfile={(pk) => setViewingProfilePubkey(pk)}
              setView={setView}
            />
          )}

          {view === "explore" && (
            <ExploreView
              notes={exploreNotes}
              getRepliesTo={getRepliesTo}
              getLikeCount={getLikeCount}
              state={noteCardState}
              actions={noteCardActionsRedirectReply}
            />
          )}

          {view === "bookmarks" && (
            <BookmarksView
              notes={notes}
              bookmarkIds={bookmarkIds}
              deletedNoteIds={deletedNoteIds}
              getRepliesTo={getRepliesTo}
              state={noteCardState}
              actions={noteCardActionsRedirectReply}
            />
          )}

          {view === "notifications" && (
            <NotificationsView
              events={notificationEvents}
              profiles={profiles}
              onNavigateProfile={navigateToProfile}
              onViewPost={(noteId) => { setFocusedNoteId(noteId); setView("feed"); }}
            />
          )}

          {view === "profile" && pubkey && (
            <ProfileView
              viewingProfilePubkey={viewingProfilePubkey}
              setViewingProfilePubkey={setViewingProfilePubkey}
              profileViewPubkey={profileViewPubkey}
              profileDisplayKey={profileDisplayKey}
              profiles={profiles}
              myName={myName}
              myPicture={myPicture}
              myAbout={myAbout}
              myBanner={myBanner}
              myProfile={myProfile}
              isNostrLoggedIn={isNostrLoggedIn}
              contactsSet={contactsSet}
              profileRootNotes={profileRootNotes}
              profileReplies={profileReplies}
              profileFollowing={profileFollowing}
              profileFollowers={profileFollowers}
              profileTab={profileTab}
              setProfileTab={setProfileTab}
              getRepliesTo={getRepliesTo}
              getParentNote={getParentNote}
              noteCardState={noteCardState}
              noteCardActionsRedirectReply={noteCardActionsRedirectReply}
              navigateToProfile={navigateToProfile}
              handleFollow={handleFollow}
              handleUnfollow={handleUnfollow}
              handleEditProfileOpen={handleEditProfileOpen}
              onStatus={setStatus}
              setView={setView}
            />
          )}

          {view === "identity" && (
            <IdentityView
              identities={identities}
              setIdentities={setIdentities}
              profiles={profiles}
              viewingPubkeys={viewingPubkeys}
              setViewingPubkeys={setViewingPubkeys}
              actingPubkey={actingPubkey}
              setActingPubkey={setActingPubkey}
              showNsecFor={showNsecFor}
              setShowNsecFor={setShowNsecFor}
              networkEnabled={networkEnabled}
              relayRef={relayRef}
              onGenerate={handleGenerate}
              onLoginOpen={() => setLoginFormOpen(true)}
              onStatus={setStatus}
            />
          )}

          {view === "settings" && (
            <SettingsView
              identities={identities}
              profiles={profiles}
              relayUrls={relayUrls}
              setRelayUrls={setRelayUrls}
              newRelayUrl={newRelayUrl}
              setNewRelayUrl={setNewRelayUrl}
              muteInput={muteInput}
              setMuteInput={setMuteInput}
              mutedPubkeys={mutedPubkeys}
              setMutedPubkeys={setMutedPubkeys}
              mutedWords={mutedWords}
              setMutedWords={setMutedWords}
              resolvePubkeyFromInput={resolvePubkeyFromInput}
              onStatus={setStatus}
            />
          )}
        </div>

        <aside className="sidebar right">
          <div className="widget steganography-widget">
            <h3>Steganography</h3>
            <p className="muted">Detect image: load an image to extract data. Embed image: save your feed and messages to an image to share.</p>
            <div
              className={`stego-drop-zone${dragOverStego ? " drag-active" : ""}`}
              aria-label="Drop image here to detect"
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(false);
                if (detecting) return;
                const file = e.dataTransfer.files?.[0];
                if (!file || !file.type.startsWith("image/")) {
                  setDecodeError("Please drop an image file (e.g. PNG).");
                  return;
                }
                if (isWeb()) {
                  handleLoadFromImage(file);
                  return;
                }
                const filePath = (file as File & { path?: string }).path;
                if (!filePath) {
                  setDecodeError("Drop failed: file path not available.");
                  return;
                }
                handleLoadFromImage(filePath);
              }}
            >
              <strong>Drop image here to detect</strong>
              <br /><span style={{fontSize: "0.8rem", color: "#888"}}>or click "Detect image" below</span>
            </div>
            {(detecting || embedding) && (
              <div className="stego-progress">
                <p className="muted detect-status">{stegoProgress || (detecting ? "Processing..." : "Embedding...")}</p>
                <div className="progress-bar"><div className="progress-bar-indeterminate"></div></div>
              </div>
            )}
            <div className="stego-actions">
              <button type="button" className="btn-stego" onClick={() => handleLoadFromImage()} disabled={detecting || embedding}>Detect image</button>
              <button type="button" className="btn-stego btn-primary" onClick={handleSaveToImage} disabled={detecting || embedding}>Embed image</button>
              {profile != null && !isWeb() && (
                <>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleDetectFromExchange} disabled={detecting} title="1-click: detect from /tmp/stegstr-test-exchange/exchange.png">Detect from exchange</button>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleEmbedToExchange} disabled={detecting} title="2-click: pick cover → save to exchange path">Embed to exchange</button>
                </>
              )}
            </div>
            {stegoLogs.length > 0 && (
              <div className="stego-log">
                <details>
                  <summary>Stego Log ({stegoLogs.length} entries)</summary>
                  <pre className="stego-log-content">{stegoLogs.join("\n")}</pre>
                </details>
              </div>
            )}
          </div>
        </aside>
      </div>

      {newMessageModalOpen && (
        <NewMessageModal
          onClose={() => setNewMessageModalOpen(false)}
          input={newMessagePubkeyInput}
          onInputChange={setNewMessagePubkeyInput}
          profiles={profiles}
          selfPubkeys={selfPubkeys}
          resolvePubkey={resolvePubkeyFromInput}
          onSelectPeer={setSelectedMessagePeer}
          onStatus={setStatus}
        />
      )}

      {loginFormOpen && (
        <LoginModal
          onClose={() => setLoginFormOpen(false)}
          nsec={nsec}
          onNsecChange={setNsec}
          onLogin={handleLogin}
          onGenerate={handleGenerate}
        />
      )}

      {embedModalOpen && (
        <EmbedModal
          onClose={() => setEmbedModalOpen(false)}
          onConfirm={handleEmbedConfirm}
          embedding={embedding}
          stegoProgress={stegoProgress}
          embedCoverFile={embedCoverFile}
          onCoverFileChange={setEmbedCoverFile}
          recipientMode={embedRecipientMode}
          onRecipientModeChange={setEmbedRecipientMode}
          recipientInput={embedRecipientInput}
          onRecipientInputChange={setEmbedRecipientInput}
          recipients={embedRecipients}
          onRecipientsChange={setEmbedRecipients}
          profiles={profiles}
          stegoMethod={embedMethod}
          onStegoMethodChange={setEmbedMethod}
          targetPlatform={targetPlatform}
          onTargetPlatformChange={setTargetPlatform}
        />
      )}

      {editProfileOpen && (
        <EditProfileModal
          onClose={() => setEditProfileOpen(false)}
          onSave={handleEditProfileSave}
          editName={editName}
          onEditNameChange={setEditName}
          editAbout={editAbout}
          onEditAboutChange={setEditAbout}
          editPicture={editPicture}
          onEditPictureChange={setEditPicture}
          editBanner={editBanner}
          onEditBannerChange={setEditBanner}
        />
      )}

      {(status || decodeError) && (
        <p className={decodeError ? "error" : "status"}>{decodeError || status}</p>
      )}
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </main>
  );
}

function AppBootstrap() {
  const [profile, setProfile] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const sync = getStorageProfileSync();
    if (sync != null) {
      setProfile(sync);
      return;
    }
    if (isWeb()) {
      setProfile(null);
      return;
    }
    getTauri()
      .then((t) => t.invoke<string | null>("get_test_profile"))
      .then((p) => setProfile(p ?? null))
      .catch(() => setProfile(null));
  }, []);
  if (profile === undefined) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  return <App profile={profile} />;
}

export default AppBootstrap;
