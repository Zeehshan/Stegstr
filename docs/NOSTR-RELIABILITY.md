# Nostr reliability architecture

## Flow

At startup `App.tsx` restores the bounded event/profile cache and relay list
without waiting for the network. Turning Network on creates one `RelayManager`.
The manager validates and normalizes relay URLs, then owns one independent
state machine per relay:

`Disconnected → Connecting → Connected → Subscribed`

Failures move through `Error/Retrying` and reconnect with jittered exponential
backoff. A connection that does not open within eight seconds is closed. Stable
connections reset their retry attempt after ten seconds.

The manager owns reusable subscription definitions. The initial feed and DM
subscriptions are permanent for the manager lifetime; bounded dynamic requests
have stable identifiers and ten-second lifetimes. All active definitions are
resent after reconnect.

## Incoming events

Relay messages are capped at 1,000,000 characters and parsed defensively.
Events are accepted only after verifying field types/sizes, limits, the NIP-01
serialized SHA-256 event ID, and the BIP-340 Schnorr signature. A bounded shared
ID set removes cross-relay duplicates before React receives an event. React's
batch merge independently deduplicates and applies Nostr replaceable-event
ordering, including parameterized `d` tags.

The event buffer accepts at most 500 events per 120 ms flush. React keeps at
most 10,000 events, while the restart cache keeps the newest 2,000 valid events
and 1,000 profiles.

## Synchronization

EOSE is tracked per relay for the permanent initial feed subscription:

- `Synced`: every configured relay completed initial sync.
- `Partially synced`: at least one relay completed while another is pending,
  disconnected, or failed.
- `Connecting`: usable sync has not completed yet.
- `Offline`: no usable relay and no active connection attempt.

The application displays connected/configured relay counts and pending/failed
publish counts. One failing relay never blocks healthy relays.

## Publishing

Publishing uses existing managed connections; it never creates one-shot relay
sockets. Signed events enter a 100-item bounded outbox, including while sockets
are connecting or the operating system is temporarily offline. Pending events
are persisted in profile-scoped localStorage and restored after restart.

Each relay independently records `pending`, `sent`, `accepted`, `rejected`, or
`timed_out`. An OK acceptance from one relay makes the overall publish
successful. Explicit relay rejection is permanent for that relay. Missing OK
responses retry at most three sends; accepted and permanently rejected records
are removed from persistent retry state. A full unresolved outbox rejects new
work explicitly instead of silently discarding older events.

Browser online/offline and visibility recovery reconnects sockets, restores
subscriptions, and flushes the outbox. Cleanup closes sockets and cancels
connection, retry, subscription, and acknowledgement timers.

## Offline and security boundaries

Network state does not gate local event creation, the event cache, steganography
encoding/decoding, or cached browsing. The relay manager receives signed public
events and public keys only; it never receives private keys.

Desktop private keys are referenced by opaque handles and stored in the native
OS credential store. Browser builds retain the explicitly weaker localStorage
fallback. The platform boundary and migration are documented in
`NATIVE-KEY-STORAGE.md` and `SECURITY-NOTES.md`.
