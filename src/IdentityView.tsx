import { useState } from "react";
import * as Nostr from "./nostr-stub";
import type { IdentityEntry, ProfileData } from "./types";
import type { ConnectRelaysResult } from "./relay";
import { deleteIdentityMaterial, exportIdentitySecret, identityPublicKey } from "./identity-crypto";

export interface IdentityViewProps {
  identities: IdentityEntry[];
  setIdentities: React.Dispatch<React.SetStateAction<IdentityEntry[]>>;
  profiles: Record<string, ProfileData>;
  viewingPubkeys: Set<string>;
  setViewingPubkeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  actingPubkey: string | null;
  setActingPubkey: React.Dispatch<React.SetStateAction<string | null>>;
  showNsecFor: string | null;
  setShowNsecFor: React.Dispatch<React.SetStateAction<string | null>>;
  networkEnabled: boolean;
  relayRef: React.RefObject<ConnectRelaysResult | null>;
  onGenerate: () => void;
  onLoginOpen: () => void;
  onStatus: (msg: string) => void;
}

export function IdentityView({
  identities, setIdentities, profiles, viewingPubkeys, setViewingPubkeys,
  actingPubkey, setActingPubkey, showNsecFor, setShowNsecFor,
  networkEnabled, relayRef, onGenerate, onLoginOpen, onStatus,
}: IdentityViewProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  return (
    <section className="identity-view">
      <h2>Identity</h2>
      <p className="identity-view-desc muted">
        Choose which identities to view and which one acts (posts, DMs). Local = data only in images; Nostr = syncs to relays when Network is ON. Convert between them anytime.
        <span className="info-icon" tabIndex={0} data-tooltip="Local identities keep data embedded in images only. Nostr identities publish to relays when Network is ON.">ⓘ</span>
      </p>
      <div className="identity-actions">
        <button type="button" className="btn-primary" onClick={onGenerate}>Create local identity</button>
        <button type="button" className="btn-secondary" onClick={onLoginOpen}>Add Nostr identity</button>
      </div>
      <ul className="identity-list">
        {identities.map((id) => {
          const pk = identityPublicKey(id);
          const isViewing = viewingPubkeys.has(pk);
          const isActing = actingPubkey === pk;
          const displayLabel = profiles[pk]?.name || id.label || pk.slice(0, 8) + "…";
          const category = id.category ?? (id.type === "nostr" ? "nostr" : "local");
          const categoryExplainer = "Local: data is only shared via embedded images (steganographic). Nostr: when Network is ON, your posts and profile are published to Nostr relays. You can convert between Local and Nostr at any time.";
          return (
            <li key={id.id} className="identity-card">
              <div className="identity-card-header">
                <span className="identity-card-name">{displayLabel}</span>
                <span className="identity-card-type" data-type={id.type}>{id.type}</span>
                <label className="identity-card-view">
                  <input type="checkbox" checked={isViewing} onChange={() => setViewingPubkeys((prev) => { const n = new Set(prev); if (isViewing) n.delete(pk); else n.add(pk); return n; })} />
                  View
                  <span className="info-icon" tabIndex={0} data-tooltip="View controls which identities appear in your feeds and searches.">ⓘ</span>
                </label>
                <label className="identity-card-act">
                  <input type="radio" name="acting" checked={isActing} onChange={() => setActingPubkey(pk)} />
                  Act
                  <span className="info-icon" tabIndex={0} data-tooltip="Act sets the identity used for posting, replying, liking, and zapping.">ⓘ</span>
                </label>
                {identities.length > 1 && (
                  <button type="button" className="identity-card-remove" onClick={async () => {
                    try {
                      await deleteIdentityMaterial(id);
                    } catch (error) {
                      onStatus("Identity removal failed; protected credential was not deleted: " + (error instanceof Error ? error.message : String(error)));
                      return;
                    }
                    const remaining = identities.filter((identity) => identity.id !== id.id);
                    setIdentities(remaining);
                    setViewingPubkeys((previous) => { const next = new Set(previous); next.delete(pk); return next; });
                    setRevealedSecrets((previous) => { const next = { ...previous }; delete next[id.id]; return next; });
                    if (showNsecFor === id.id) setShowNsecFor(null);
                    if (isActing && remaining[0]) setActingPubkey(identityPublicKey(remaining[0]));
                    onStatus("Identity and protected credential removed");
                  }} title="Remove identity">Remove</button>
                )}
              </div>
              <div className="identity-card-pubkey">
                <span className="pubkey-copy" title="Click to copy npub" onClick={async () => { await navigator.clipboard.writeText(Nostr.nip19.npubEncode(pk)); onStatus("Copied!"); setTimeout(() => onStatus(""), 1500); }}>{Nostr.nip19.npubEncode(pk)}</span>
                <span className="info-icon" tabIndex={0} data-tooltip="Your public key (npub). Safe to share. Click it to copy.">ⓘ</span>
              </div>
              <div className="identity-card-nsec">
                <button type="button" className="identity-show-nsec-btn" onClick={async () => {
                  if (showNsecFor === id.id) {
                    setShowNsecFor(null);
                    setRevealedSecrets((previous) => { const next = { ...previous }; delete next[id.id]; return next; });
                    return;
                  }
                  try {
                    const nsec = await exportIdentitySecret(id);
                    setRevealedSecrets((previous) => ({ ...previous, [id.id]: nsec }));
                    setShowNsecFor(id.id);
                  } catch (error) {
                    onStatus("Secret-key export failed: " + (error instanceof Error ? error.message : String(error)));
                  }
                }}>
                  {showNsecFor === id.id ? "Hide exported secret" : "Export secret key"}
                </button>
                {showNsecFor === id.id && revealedSecrets[id.id] && (
                  <div className="identity-nsec-reveal">
                    <p className="nsec-warning">Keep this secret! Anyone with this key controls this identity. Save it to restore this identity later.</p>
                    <code className="nsec-value">{revealedSecrets[id.id]}</code>
                    <button
                      type="button"
                      className="nsec-copy-btn"
                      onClick={async () => {
                        await navigator.clipboard.writeText(revealedSecrets[id.id]);
                        onStatus("Secret key copied!");
                        setTimeout(() => onStatus(""), 2000);
                      }}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
              <div className="identity-card-category">
                <span className="identity-category-badge" data-category={category}>{category === "nostr" ? "Nostr" : "Local"}</span>
                <button
                  type="button"
                  className="identity-convert-btn"
                  onClick={() => {
                    const nextCat = category === "nostr" ? "local" : "nostr";
                    const msg = nextCat === "local"
                      ? "Convert to Local? Your profile data from relays won't be deleted, but this identity will stop syncing with the network."
                      : "Convert to Nostr? When Network is ON, this identity will publish to relays. If a profile already exists on Nostr for this key, it will be used.";
                    if (!window.confirm(msg)) return;
                    setIdentities((prev) => prev.map((i) => (i.id === id.id ? { ...i, category: nextCat } : i)));
                    if (nextCat === "nostr" && networkEnabled && relayRef.current) {
                      relayRef.current.requestProfiles([pk]);
                      relayRef.current.requestAuthor(pk);
                    }
                    onStatus(nextCat === "local" ? "Identity is now Local (steganographic only)" : "Identity is now Nostr (will sync when Network ON)");
                  }}
                  title={category === "nostr" ? "Convert to Local (data only in images)" : "Convert to Nostr (publish to relays when Network ON)"}
                >
                  {category === "nostr" ? "Convert to Local" : "Convert to Nostr"}
                </button>
                <span className="identity-convert-info" title={categoryExplainer} aria-label="Info">ⓘ</span>
                <label className="identity-card-private">
                  <input type="checkbox" checked={!!id.isPrivate} onChange={() => setIdentities((prev) => prev.map((i) => (i.id === id.id ? { ...i, isPrivate: !i.isPrivate } : i)))} />
                  Private
                  <span className="info-icon" tabIndex={0} data-tooltip="Private hides your profile by default (follow approvals coming later).">ⓘ</span>
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      {identities.some((i) => i.isPrivate) && (
        <div className="identity-follow-requests">
          <h3 className="profile-section-title">Follow requests</h3>
          <p className="muted">When your profile is private, only approved followers can view. Follow requests will appear here when a NIP for follow requests is supported.</p>
        </div>
      )}
    </section>
  );
}
