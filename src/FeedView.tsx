import type React from "react";
import { NoteThread } from "./NoteCard";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import type { NostrEvent, ProfileData, View } from "./types";
import { MAX_NOTE_USER_CONTENT } from "./constants";

export type FeedItem = { type: "note"; note: NostrEvent; sortAt: number } | { type: "repost"; repost: NostrEvent; note: NostrEvent; sortAt: number };

export interface FeedViewProps {
  // Compose
  myPicture: string | null;
  myName: string;
  newPost: string;
  setNewPost: React.Dispatch<React.SetStateAction<string>>;
  postMediaUrls: string[];
  setPostMediaUrls: React.Dispatch<React.SetStateAction<string[]>>;
  uploadingMedia: boolean;
  postMediaInputRef: React.RefObject<HTMLInputElement | null>;
  handlePostMediaUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handlePost: () => void;
  // Feed filter
  feedFilter: "global" | "following";
  setFeedFilter: React.Dispatch<React.SetStateAction<"global" | "following">>;
  // Notes
  notesEmpty: boolean;
  feedItems: FeedItem[];
  // Search
  searchTrim: string;
  searchLower: string;
  searchNoSpaces: string;
  searchPubkeyHex: string | null;
  npubStr: string | null;
  networkEnabled: boolean;
  profiles: Record<string, ProfileData>;
  pubkey: string | null;
  // Focus
  focusedNoteId: string | null;
  prioritizedEventIds: string[];
  feedSectionRef: React.RefObject<HTMLElement | null>;
  notes: NostrEvent[];
  // Note rendering
  getRepliesTo: (noteId: string) => NostrEvent[];
  noteCardState: NoteCardState;
  noteCardActions: NoteCardActions;
  replyingTo: NostrEvent | null;
  replyContent: string;
  onReplyContentChange: React.Dispatch<React.SetStateAction<string>>;
  handleReply: () => void;
  handleReplyCancel: () => void;
  // Infinite scroll
  loadingMore: boolean;
  loadMoreSentinelRef: React.RefObject<HTMLDivElement | null>;
  // Navigation
  setViewingProfilePubkey: React.Dispatch<React.SetStateAction<string | null>>;
  setView: React.Dispatch<React.SetStateAction<View>>;
}

export function FeedView({
  myPicture, myName, newPost, setNewPost, postMediaUrls, setPostMediaUrls,
  uploadingMedia, postMediaInputRef, handlePostMediaUpload, handlePost,
  feedFilter, setFeedFilter,
  notesEmpty, feedItems,
  searchTrim, searchLower, searchNoSpaces, searchPubkeyHex, npubStr, networkEnabled,
  profiles, pubkey,
  focusedNoteId, prioritizedEventIds, feedSectionRef, notes,
  getRepliesTo, noteCardState, noteCardActions,
  replyingTo, replyContent, onReplyContentChange, handleReply, handleReplyCancel,
  loadingMore, loadMoreSentinelRef,
  setViewingProfilePubkey, setView,
}: FeedViewProps) {
  return (
    <>
      <section className="compose-section">
        <div className="compose-avatar">
          {myPicture ? <img src={myPicture} alt="" /> : <span>{myName.slice(0, 1)}</span>}
        </div>
        <div className="compose-body">
          <textarea
            placeholder="What's happening?"
            value={newPost}
            onChange={(e) => setNewPost(e.target.value)}
            rows={3}
            className="wide"
            maxLength={MAX_NOTE_USER_CONTENT}
          />
          {postMediaUrls.length > 0 && (
            <div className="post-media-preview">
              {postMediaUrls.map((url, i) => (
                <span key={i} className="post-media-item">
                  {url.match(/\.(gif|jpg|jpeg|png|webp)(\?|$)/i) ? (
                    <img src={url} alt="" />
                  ) : (
                    <a href={url} target="_blank" rel="noreferrer">{url.slice(0, 40)}…</a>
                  )}
                  <button type="button" className="btn-remove muted" onClick={() => setPostMediaUrls((p) => p.filter((_, j) => j !== i))}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="compose-actions">
            <input ref={postMediaInputRef} type="file" accept="image/*,video/*" multiple className="hidden-input" onChange={handlePostMediaUpload} />
            <button type="button" className="btn-secondary" onClick={() => postMediaInputRef.current?.click()} disabled={uploadingMedia} title="Add photo or video">
              {uploadingMedia ? "Uploading…" : "Attach"}
            </button>
            <button type="button" onClick={handlePost} className="btn-primary" disabled={(!newPost.trim() && postMediaUrls.length === 0) || uploadingMedia}>Post</button>
          </div>
          <p className="muted char-counter">{newPost.length}/{MAX_NOTE_USER_CONTENT} (appends &quot; Sent by Stegstr.&quot;)</p>
        </div>
      </section>

      <section className="feed-section" ref={feedSectionRef}>
        <div className="feed-header-row">
          <h2 className="feed-title">Feed</h2>
          <div className="feed-filter-tabs">
            <button type="button" className={feedFilter === "global" ? "active" : ""} onClick={() => setFeedFilter("global")}>Global</button>
            <button type="button" className={feedFilter === "following" ? "active" : ""} onClick={() => setFeedFilter("following")}>Following</button>
          </div>
        </div>
        {notesEmpty && (
          <p className="muted">No notes yet. Turn Network ON for relay feed, or load from image.</p>
        )}
        {searchTrim && (
          <>
            {(() => {
              const profileMatches = Object.entries(profiles).filter(
                ([pk, p]) => pk !== pubkey &&
                  ((searchPubkeyHex && pk === searchPubkeyHex) ||
                    p?.name?.toLowerCase().includes(searchLower) ||
                    (typeof p?.nip05 === "string" && p.nip05.toLowerCase().includes(searchLower)) ||
                    pk.toLowerCase().includes(searchNoSpaces.toLowerCase()))
              );
              if (searchPubkeyHex && profileMatches.length === 0 && feedItems.length === 0 && !profiles[searchPubkeyHex]) {
                return (
                  <div className="profile-result-card">
                    <p className="muted">No notes from this pubkey. View profile to follow.</p>
                    <button type="button" className="btn-primary" onClick={() => { setViewingProfilePubkey(searchPubkeyHex); setView("profile"); }}>
                      View profile ({searchPubkeyHex.slice(0, 12)}…)
                    </button>
                  </div>
                );
              }
              if (profileMatches.length > 0) {
                return (
                  <div className="search-profiles-section">
                    <h3 className="search-section-title">Profiles</h3>
                    <ul className="profile-result-list">
                      {profileMatches.slice(0, 10).map(([pk, p]) => (
                        <li key={pk} className="profile-result-item">
                          {p?.picture ? <img src={p.picture} alt="" className="contact-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span className="contact-avatar placeholder">{(p?.name ?? pk).slice(0, 2)}</span>}
                          <div className="profile-result-info">
                            <strong>{p?.name ?? `${pk.slice(0, 12)}…`}</strong>
                            {p?.nip05 && <span className="muted"> {p.nip05}</span>}
                          </div>
                          <button type="button" className="btn-primary" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>View profile</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              }
              if (feedItems.length === 0) {
                return (
                  <p className="muted">
                    {searchPubkeyHex || npubStr
                      ? networkEnabled
                        ? "No notes from this pubkey yet. If we just fetched, wait a moment; otherwise they may have no public notes on these relays."
                        : "Turn Network ON to fetch this pubkey's notes from relays, or load an image that contains their posts."
                      : "No notes match your search."}
                  </p>
                );
              }
              return null;
            })()}
          </>
        )}
        <ul className="note-list">
          {(() => {
            const rootIdForFocus = focusedNoteId
              ? (() => {
                  const n = notes.find((n) => n.id === focusedNoteId);
                  if (n) {
                    const eTag = n.tags.find((t) => t[0] === "e");
                    return eTag?.[1] ?? n.id;
                  }
                  return focusedNoteId;
                })()
              : null;
            const priorityIndex = new Map(prioritizedEventIds.map((id, index) => [id, index]));
            const itemPriority = (item: FeedItem): number => {
              const ids = item.type === "repost" ? [item.repost.id, item.note.id] : [item.note.id];
              return Math.min(...ids.map((id) => priorityIndex.get(id) ?? Number.MAX_SAFE_INTEGER));
            };
            const feedItemsSorted: FeedItem[] = !rootIdForFocus && prioritizedEventIds.length === 0
              ? feedItems
              : [...feedItems].sort((a, b) => {
                  const aPriority = itemPriority(a);
                  const bPriority = itemPriority(b);
                  if (aPriority !== bPriority) return aPriority - bPriority;
                  const aId = a.type === "note" ? a.note.id : a.note.id;
                  const bId = b.type === "note" ? b.note.id : b.note.id;
                  if (aId === rootIdForFocus) return -1;
                  if (bId === rootIdForFocus) return 1;
                  return b.sortAt - a.sortAt;
                });
            return feedItemsSorted.map((item) => {
              const ev = item.type === "note" ? item.note : item.note;
              const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
              const isFocused = !!(rootIdForFocus && ev.id === rootIdForFocus);
              const isDetected = prioritizedEventIds.includes(ev.id) || (item.type === "repost" && prioritizedEventIds.includes(item.repost.id));
              return (
                <NoteThread
                  key={item.type === "repost" ? item.repost.id : ev.id}
                  event={ev}
                  state={noteCardState}
                  actions={noteCardActions}
                  replies={replies}
                  repostEvent={item.type === "repost" ? item.repost : undefined}
                  isFocused={isFocused}
                  isDetected={isDetected}
                  showReplyActions={true}
                  replyingTo={replyingTo}
                  replyContent={replyContent}
                  onReplyContentChange={onReplyContentChange}
                  onReplySend={handleReply}
                  onReplyCancel={handleReplyCancel}
                />
              );
            });
          })()}
          {loadingMore && (
            <li key="loading-more" className="loading-more-indicator">
              <p className="muted">Loading more…</p>
            </li>
          )}
          <li key="load-more-sentinel" aria-hidden="true">
            <div ref={loadMoreSentinelRef} style={{ height: 1, visibility: "hidden" }} />
          </li>
        </ul>
      </section>
    </>
  );
}
