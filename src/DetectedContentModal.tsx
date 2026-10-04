import { useEffect, useRef } from "react";
import type { NostrEvent, ProfileData } from "./types";

export interface DetectedContentResult {
  events: NostrEvent[];
  newCount: number;
  knownCount: number;
}

export interface DetectedContentModalProps {
  result: DetectedContentResult;
  profiles: Record<string, ProfileData>;
  onClose: () => void;
  onViewInFeed: () => void;
}

export function detectedFeedEventIds(events: NostrEvent[]): string[] {
  const deletedIds = new Set(
    events
      .filter((event) => event.kind === 5)
      .flatMap((event) => event.tags.filter((tag) => tag[0] === "e" && tag[1]).map((tag) => tag[1])),
  );
  return [...new Set(
    events
      .filter((event) => (event.kind === 1 && !deletedIds.has(event.id)) || event.kind === 6)
      .map((event) => event.id),
  )];
}

export function emptyDetectionMessage(parsedCount: number): string {
  return parsedCount === 0
    ? "Image decoded, but its Stegstr payload contains no events."
    : `Image decoded, but none of its ${parsedCount} event record(s) passed Nostr validation.`;
}

export function DetectedContentModal({ result, profiles, onClose, onViewInFeed }: DetectedContentModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const feedEventIds = detectedFeedEventIds(result.events);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal detected-content-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detected-content-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="detected-content-title">Stegstr Content Detected</h3>
        <p>
          Recovered events: <strong>{result.events.length}</strong>
          {result.knownCount > 0 && (
            <span className="muted"> · {result.knownCount} already known and refreshed</span>
          )}
        </p>
        <div className="detected-content-list" aria-label="Recovered Stegstr content">
          {result.events.map((event) => (
            <article className="detected-content-item" key={event.id}>
              <div className="detected-content-meta">
                <strong>{profiles[event.pubkey]?.name ?? `${event.pubkey.slice(0, 8)}…`}</strong>
                <time dateTime={new Date(event.created_at * 1000).toISOString()}>
                  {new Date(event.created_at * 1000).toLocaleString()}
                </time>
              </div>
              <p>{humanReadableEvent(event)}</p>
            </article>
          ))}
        </div>
        {feedEventIds.length === 0 && (
          <p className="detected-content-notice" role="status">
            The recovered records do not contain a visible Feed post. They may represent deleted or unsupported content.
          </p>
        )}
        <div className="row modal-actions">
          <button type="button" ref={closeButtonRef} onClick={onClose}>Close</button>
          <button type="button" className="btn-primary" onClick={onViewInFeed} disabled={feedEventIds.length === 0}>
            View in Feed
          </button>
        </div>
      </div>
    </div>
  );
}

function humanReadableEvent(event: NostrEvent): string {
  if (event.kind === 1) return event.content.trim() || "Empty post recovered.";
  if (event.kind === 4) return "Encrypted direct message recovered.";
  if (event.kind === 5) return "Deletion record recovered.";
  if (event.kind === 6) {
    try {
      const reposted = JSON.parse(event.content) as Partial<NostrEvent>;
      if (typeof reposted.content === "string" && reposted.content.trim()) return `Repost: ${reposted.content.trim()}`;
    } catch { /* Show the readable fallback below. */ }
    return "Repost recovered.";
  }
  if (event.kind === 0) {
    try {
      const profile = JSON.parse(event.content) as ProfileData;
      const readable = [profile.name, profile.about].filter((value): value is string => typeof value === "string" && !!value.trim());
      if (readable.length > 0) return `Profile: ${readable.join(" — ")}`;
    } catch { /* Show the readable fallback below. */ }
    return "Profile information recovered.";
  }
  const content = event.content.trim();
  if (content && !content.startsWith("{") && !content.startsWith("[")) return content;
  return `Nostr event recovered (kind ${event.kind}).`;
}
