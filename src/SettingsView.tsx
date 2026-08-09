import * as Nostr from "./nostr-stub";
import type { IdentityEntry, ProfileData } from "./types";
import { normalizeRelayUrl } from "./relay";
import { identityPublicKey } from "./identity-crypto";

export interface SettingsViewProps {
  identities: IdentityEntry[];
  profiles: Record<string, ProfileData>;
  relayUrls: string[];
  setRelayUrls: React.Dispatch<React.SetStateAction<string[]>>;
  newRelayUrl: string;
  setNewRelayUrl: React.Dispatch<React.SetStateAction<string>>;
  muteInput: string;
  setMuteInput: React.Dispatch<React.SetStateAction<string>>;
  mutedPubkeys: Set<string>;
  setMutedPubkeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  mutedWords: string[];
  setMutedWords: React.Dispatch<React.SetStateAction<string[]>>;
  resolvePubkeyFromInput: (input: string) => string | null;
  onStatus: (msg: string) => void;
}

export function SettingsView({
  identities, profiles, relayUrls, setRelayUrls, newRelayUrl, setNewRelayUrl,
  muteInput, setMuteInput, mutedPubkeys, setMutedPubkeys, mutedWords, setMutedWords,
  resolvePubkeyFromInput, onStatus,
}: SettingsViewProps) {
  const handleAddRelay = () => {
    if (newRelayUrl.trim()) {
      const url = normalizeRelayUrl(newRelayUrl);
      if (url) {
        if (relayUrls.includes(url)) {
          onStatus("Relay already added.");
        } else {
          setRelayUrls((prev) => [...prev, url]);
          onStatus("Relay added.");
        }
        setNewRelayUrl("");
      } else {
        onStatus("Enter a valid ws:// or wss:// relay URL without credentials.");
      }
    }
  };

  const handleAddMute = () => {
    const pk = resolvePubkeyFromInput(muteInput.trim());
    if (pk) {
      setMutedPubkeys((prev) => new Set(prev).add(pk));
      setMuteInput("");
    } else if (muteInput.trim()) {
      setMutedWords((prev) => prev.includes(muteInput.trim().toLowerCase()) ? prev : [...prev, muteInput.trim().toLowerCase()]);
      setMuteInput("");
    }
  };

  return (
    <section className="settings-view">
      <h2>Settings</h2>
      <h3 className="settings-section">
        Identities
        <span className="info-icon" tabIndex={0} data-tooltip="Public keys (npub) are safe to share. Secret keys (nsec) should never be shared.">ⓘ</span>
      </h3>
      <p className="muted">Public keys (npub). Click to copy.</p>
      <ul className="settings-list">
        {identities.map((id) => {
          const pk = identityPublicKey(id);
          const label = profiles[pk]?.name || id.label || pk.slice(0, 8) + "…";
          return (
            <li key={id.id} className="settings-list-item settings-identity-item">
              <span className="muted">{label}</span>
              <span
                className="pubkey-copy muted"
                style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}
                title="Click to copy npub"
                onClick={async () => {
                  const npub = Nostr.nip19.npubEncode(pk);
                  await navigator.clipboard.writeText(npub);
                  onStatus("Copied!");
                  setTimeout(() => onStatus(""), 1500);
                }}
              >
                {Nostr.nip19.npubEncode(pk)}
              </span>
            </li>
          );
        })}
      </ul>
      <h3 className="settings-section">
        Relays
        <span className="info-icon" tabIndex={0} data-tooltip="Relays are Nostr servers that store and deliver events. Add your favorites here.">ⓘ</span>
      </h3>
      <p className="muted">Default is the Stegstr relay (proxy); relay path is managed by Stegstr. You can add or remove relay URLs below.</p>
      <div className="mute-add-wrap">
        <input
          type="url"
          placeholder="wss://…"
          value={newRelayUrl}
          onChange={(e) => setNewRelayUrl(e.target.value)}
          className="wide"
          onKeyDown={(e) => { if (e.key === "Enter" && newRelayUrl.trim()) handleAddRelay(); }}
        />
        <button type="button" className="btn-secondary" onClick={handleAddRelay}>Add</button>
      </div>
      <ul className="settings-list">
        {relayUrls.map((url) => (
          <li key={url} className="settings-list-item">
            <span className="muted" style={{ wordBreak: "break-all" }}>{url}</span>
            <button type="button" className="btn-delete muted" disabled={relayUrls.length <= 1} title={relayUrls.length <= 1 ? "Cannot remove last relay" : "Remove"} onClick={() => setRelayUrls((prev) => prev.filter((u) => u !== url))}>Remove</button>
          </li>
        ))}
      </ul>
      {relayUrls.length === 0 && <p className="muted">Add at least one relay (e.g. the Stegstr proxy or wss://relay.damus.io).</p>}
      <h3 className="settings-section">Mute</h3>
      <p className="muted">Muted users and words are hidden from feed and notifications.</p>
      <div className="mute-add-wrap">
        <input
          type="text"
          placeholder="npub / hex pubkey or word…"
          value={muteInput}
          onChange={(e) => setMuteInput(e.target.value)}
          className="wide"
          onKeyDown={(e) => { if (e.key === "Enter") handleAddMute(); }}
        />
        <button type="button" className="btn-secondary" onClick={handleAddMute}>Add</button>
      </div>
      {mutedPubkeys.size > 0 && (
        <>
          <p className="settings-sub">Muted users</p>
          <ul className="settings-list">
            {[...mutedPubkeys].map((pk) => (
              <li key={pk} className="settings-list-item">
                <span className="muted">{pk.slice(0, 12)}…{pk.slice(-6)}</span>
                <button type="button" className="btn-delete muted" onClick={() => setMutedPubkeys((prev) => { const s = new Set(prev); s.delete(pk); return s; })}>Remove</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {mutedWords.length > 0 && (
        <>
          <p className="settings-sub">Muted words</p>
          <ul className="settings-list">
            {mutedWords.map((w) => (
              <li key={w} className="settings-list-item">
                <span className="muted">{w}</span>
                <button type="button" className="btn-delete muted" onClick={() => setMutedWords((prev) => prev.filter((x) => x !== w))}>Remove</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="settings-section">Stego</h3>
      <p className="muted">Detect: load image to extract Nostr state. Embed: save current feed to image. When Network is OFF, use images to pass state P2P. Turn Network ON to sync local changes to relays.</p>
      <p className="muted" style={{ marginTop: "0.5rem" }}>Stegstr 0.1.0</p>
    </section>
  );
}
