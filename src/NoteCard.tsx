import { extractImageUrls, mediaUrlsFromTags, isVideoUrl, contentWithoutImages } from "./utils";
import { MAX_NOTE_USER_CONTENT } from "./constants";
import type { NostrEvent, ProfileData } from "./types";

/** Callbacks the NoteCard may invoke. All are optional — omit to hide that action. */
export interface NoteCardActions {
  onNavigateProfile?: (pubkey: string) => void;
  onReply?: (ev: NostrEvent) => void;
  onLike?: (ev: NostrEvent) => void;
  onRepost?: (ev: NostrEvent) => void;
  onZap?: (ev: NostrEvent) => void;
  onBookmark?: (ev: NostrEvent) => void;
  onUnbookmark?: (ev: NostrEvent) => void;
  onDelete?: (ev: NostrEvent) => void;
}

/** Read-only helpers for rendering state. */
export interface NoteCardState {
  profiles: Record<string, ProfileData>;
  selfPubkeys: string[];
  getIdentityLabels?: (pubkey: string) => string[];
  hasLiked: (noteId: string) => boolean;
  hasBookmarked: (noteId: string) => boolean;
  getLikeCount: (noteId: string) => number;
  getZapCount: (noteId: string) => number;
}

export interface NoteCardProps {
  event: NostrEvent;
  state: NoteCardState;
  actions: NoteCardActions;
  /** Extra text shown in note-meta after the timestamp (e.g. " · 5 likes"). */
  metaSuffix?: React.ReactNode;
  /** If true, show full action bar. If false or omitted in compact mode, hide actions. */
  showActions?: boolean;
  /** If true, the author name is a clickable link. Default true. */
  authorClickable?: boolean;
  /** Show identity tags for own notes. Default true. */
  showIdentityTags?: boolean;
  /** Show media (images/videos) in content. Default true. */
  showMedia?: boolean;
  /** CSS class applied to the outer note-card div. */
  className?: string;
  /** Click handler for the entire card. */
  onClick?: () => void;
  /** Inline style for the outer card div. */
  style?: React.CSSProperties;
  /** Truncate content to this many chars (for previews). 0 = no truncation. */
  contentMaxChars?: number;
}

/** Renders a single note card (avatar + meta + content + actions). */
export function NoteCard({
  event: ev,
  state,
  actions,
  metaSuffix,
  showActions = true,
  authorClickable = true,
  showIdentityTags = true,
  showMedia = true,
  className,
  onClick,
  style,
  contentMaxChars = 0,
}: NoteCardProps) {
  const { profiles, selfPubkeys, getIdentityLabels, hasLiked, hasBookmarked, getLikeCount, getZapCount } = state;
  const profile = profiles[ev.pubkey];
  const displayName = profile?.name ?? `${ev.pubkey.slice(0, 8)}…`;
  const likeCount = getLikeCount(ev.id);

  const textContent = contentWithoutImages(ev.content).trim() || ev.content.trim();
  const displayText = contentMaxChars > 0 && textContent.length > contentMaxChars
    ? textContent.slice(0, contentMaxChars) + "…"
    : textContent;

  return (
    <div className={`note-card${className ? ` ${className}` : ""}`} onClick={onClick} style={style}>
      <div className="note-avatar">
        {profile?.picture ? (
          <img src={profile.picture} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        ) : (
          <span>{(profile?.name || ev.pubkey).slice(0, 1)}</span>
        )}
      </div>
      <div className="note-body">
        <div className="note-meta">
          <strong>
            {authorClickable && actions.onNavigateProfile ? (
              <button type="button" className="link-like" onClick={(e) => { e.stopPropagation(); actions.onNavigateProfile!(ev.pubkey); }}>
                {displayName}
              </button>
            ) : (
              displayName
            )}
            {showIdentityTags && selfPubkeys.includes(ev.pubkey) && getIdentityLabels?.(ev.pubkey).map((l) => (
              <span key={l} className="event-identity-tag">{l}</span>
            ))}
          </strong>
          <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
          {metaSuffix}
        </div>
        <div className={`note-content${contentMaxChars > 0 ? " note-content-preview" : ""}`}>
          {displayText && <p>{displayText}</p>}
          {showMedia && <NoteMedia event={ev} />}
        </div>
        {showActions && (
          <NoteActions
            event={ev}
            actions={actions}
            likeCount={likeCount}
            zapCount={getZapCount(ev.id)}
            liked={hasLiked(ev.id)}
            bookmarked={hasBookmarked(ev.id)}
            isOwn={selfPubkeys.includes(ev.pubkey)}
          />
        )}
      </div>
    </div>
  );
}

/** Media (images + videos) extracted from event content and tags. */
function NoteMedia({ event: ev }: { event: NostrEvent }) {
  const tagMedia = mediaUrlsFromTags(ev.tags);
  const contentUrls = extractImageUrls(ev.content);
  const urls = tagMedia.length > 0 ? tagMedia : contentUrls;
  if (urls.length === 0) return null;
  return (
    <div className="note-images">
      {urls.slice(0, 4).map((url, i) =>
        isVideoUrl(url) ? (
          <video key={i} src={url} controls className="note-img note-video" />
        ) : (
          <img key={i} src={url} alt="" className="note-img" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        )
      )}
    </div>
  );
}

interface NoteActionsProps {
  event: NostrEvent;
  actions: NoteCardActions;
  likeCount: number;
  zapCount: number;
  liked: boolean;
  bookmarked: boolean;
  isOwn: boolean;
}

/** Action bar (Reply, Like, Repost, Zap, Bookmark, Delete). */
function NoteActions({ event: ev, actions, likeCount, zapCount, liked, bookmarked, isOwn }: NoteActionsProps) {
  return (
    <div className="note-actions">
      {actions.onReply && (
        <button type="button" className="note-action-btn" onClick={() => actions.onReply!(ev)} title="Reply">
          Reply
        </button>
      )}
      {actions.onLike && (
        <button
          type="button"
          className={`note-action-btn${liked ? " is-active" : ""}`}
          onClick={() => !liked && actions.onLike!(ev)}
          title="Like"
          disabled={liked}
        >
          {liked ? "Liked" : "Like"} <span className="action-count">{likeCount}</span>
        </button>
      )}
      {actions.onRepost && (
        <button type="button" className="note-action-btn" onClick={() => actions.onRepost!(ev)} title="Repost">
          Repost
        </button>
      )}
      {actions.onZap && (
        <button type="button" className="note-action-btn" onClick={() => actions.onZap!(ev)} title="Zap">
          Zap <span className="action-count">{zapCount}</span>
        </button>
      )}
      {(actions.onZap || actions.onRepost) && (
        <span
          className="info-icon"
          tabIndex={0}
          data-tooltip="Zaps use Nostr. If Network is OFF, your zap is queued and sent once Network is ON."
        >
          i
        </span>
      )}
      {(actions.onBookmark || actions.onUnbookmark) && (
        <button
          type="button"
          className={`note-action-btn${bookmarked ? " is-active" : ""}`}
          onClick={() => bookmarked ? actions.onUnbookmark?.(ev) : actions.onBookmark?.(ev)}
          title={bookmarked ? "Remove bookmark" : "Bookmark"}
        >
          {bookmarked ? "Unbookmark" : "Bookmark"}
        </button>
      )}
      {isOwn && actions.onDelete && (
        <button type="button" className="btn-delete muted" onClick={() => actions.onDelete!(ev)} title="Delete">Delete</button>
      )}
    </div>
  );
}

/** Reply list — compact note cards without full actions. */
export interface NoteReplyListProps {
  replies: NostrEvent[];
  state: NoteCardState;
  actions: NoteCardActions;
  /** Max replies to show before "... and N more". 0 = show all. */
  maxVisible?: number;
  /** If true, show full actions on each reply. Default false. */
  showReplyActions?: boolean;
  /** Currently replying-to event (to show inline reply box). */
  replyingTo?: NostrEvent | null;
  replyContent?: string;
  onReplyContentChange?: (content: string) => void;
  onReplySend?: () => void;
  onReplyCancel?: () => void;
}

export function NoteReplyList({
  replies,
  state,
  actions,
  maxVisible = 0,
  showReplyActions = false,
  replyingTo,
  replyContent = "",
  onReplyContentChange,
  onReplySend,
  onReplyCancel,
}: NoteReplyListProps) {
  if (replies.length === 0) return null;
  const { profiles } = state;
  const visible = maxVisible > 0 ? replies.slice(0, maxVisible) : replies;
  return (
    <ul className="note-replies">
      {visible.map((reply) => (
        <li key={reply.id} className="note-card note-reply">
          <NoteCard
            event={reply}
            state={state}
            actions={showReplyActions ? actions : { onNavigateProfile: actions.onNavigateProfile }}
            showActions={showReplyActions}
            showIdentityTags={showReplyActions}
            className=""
          />
          {replyingTo?.id === reply.id && onReplyCancel && onReplySend && onReplyContentChange && (
            <div className="reply-box reply-box-inline">
              <p className="muted">Replying to {(profiles[replyingTo.pubkey]?.name ?? replyingTo.pubkey.slice(0, 8))}…</p>
              <textarea value={replyContent} onChange={(e) => onReplyContentChange(e.target.value)} placeholder="Write a reply…" rows={2} className="wide" maxLength={MAX_NOTE_USER_CONTENT} />
              <p className="muted char-counter">{replyContent.length}/{MAX_NOTE_USER_CONTENT}</p>
              <div className="row">
                <button type="button" onClick={onReplyCancel}>Cancel</button>
                <button type="button" onClick={onReplySend} className="btn-primary">Reply</button>
              </div>
            </div>
          )}
        </li>
      ))}
      {maxVisible > 0 && replies.length > maxVisible && (
        <p className="muted">… and {replies.length - maxVisible} more replies</p>
      )}
    </ul>
  );
}

/** Full note thread: optional repost label + note card + reply box + reply list. */
export interface NoteThreadProps {
  event: NostrEvent;
  state: NoteCardState;
  actions: NoteCardActions;
  replies: NostrEvent[];
  /** Repost event, if this is a repost. */
  repostEvent?: NostrEvent;
  /** If true, add "focused" class. */
  isFocused?: boolean;
  /** If true, temporarily highlight content selected from image detection. */
  isDetected?: boolean;
  /** Extra text in note-meta. */
  metaSuffix?: React.ReactNode;
  /** Max replies to show. 0 = all. */
  maxReplies?: number;
  /** Show full actions on replies. */
  showReplyActions?: boolean;
  /** Reply state for inline reply box. */
  replyingTo?: NostrEvent | null;
  replyContent?: string;
  onReplyContentChange?: (content: string) => void;
  onReplySend?: () => void;
  onReplyCancel?: () => void;
}

export function NoteThread({
  event: ev,
  state,
  actions,
  replies,
  repostEvent,
  isFocused,
  isDetected,
  metaSuffix,
  maxReplies = 0,
  showReplyActions = false,
  replyingTo,
  replyContent = "",
  onReplyContentChange,
  onReplySend,
  onReplyCancel,
}: NoteThreadProps) {
  const { profiles } = state;
  return (
    <li
      className={`note-thread${isFocused ? " focused" : ""}${isDetected ? " detected" : ""}`}
      tabIndex={isDetected ? -1 : undefined}
    >
      {repostEvent && (
        <p className="repost-label muted">
          <button type="button" className="link-like" onClick={() => actions.onNavigateProfile?.(repostEvent.pubkey)}>
            {(profiles[repostEvent.pubkey]?.name ?? `${repostEvent.pubkey.slice(0, 8)}…`)}
          </button>
          {" reposted"}
        </p>
      )}
      <NoteCard event={ev} state={state} actions={actions} metaSuffix={metaSuffix} />
      {replyingTo?.id === ev.id && onReplyCancel && onReplySend && onReplyContentChange && (
        <div className="reply-box">
          <p className="muted">Replying to {(profiles[replyingTo.pubkey]?.name ?? replyingTo.pubkey.slice(0, 8))}…</p>
          <textarea value={replyContent} onChange={(e) => onReplyContentChange(e.target.value)} placeholder="Write a reply…" rows={2} className="wide" maxLength={MAX_NOTE_USER_CONTENT} />
          <p className="muted char-counter">{replyContent.length}/{MAX_NOTE_USER_CONTENT}</p>
          <div className="row">
            <button type="button" onClick={onReplyCancel}>Cancel</button>
            <button type="button" onClick={onReplySend} className="btn-primary">Reply</button>
          </div>
        </div>
      )}
      <NoteReplyList
        replies={replies}
        state={state}
        actions={showReplyActions ? actions : { onNavigateProfile: actions.onNavigateProfile }}
        maxVisible={maxReplies}
        showReplyActions={showReplyActions}
        replyingTo={replyingTo}
        replyContent={replyContent}
        onReplyContentChange={onReplyContentChange}
        onReplySend={onReplySend}
        onReplyCancel={onReplyCancel}
      />
    </li>
  );
}
