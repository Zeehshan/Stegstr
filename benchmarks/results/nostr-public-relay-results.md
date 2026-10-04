# Nostr public relay soak

Run: 2026-08-09T12:13:04.194Z to 2026-08-09T12:33:29.037Z (20.41 minutes observed; 20 minute steady-state target).

The identity was generated only for this run. Its private key remained in memory and was neither printed nor recorded. Two harmless, clearly labeled events were published.

| Relay | Connected | Connect ms | ACK | Publish ms | Received | Reconnected | Outbox flushed |
|---|---:|---:|---|---:|---:|---:|---:|
| wss://relay.damus.io | true | 830 | accepted | 391 | true | true | false |
| wss://nos.lol | true | 505 | accepted | 193 | true | true | true |
| wss://relay.nostr.band | false | — | pending | — | false | false | false |

Shared-path receive count for the first event: **1**. Accepted relay count: **2**. A read-only follow-up after the propagation window confirmed the same event on both Damus and nos.lol, so shared-path cross-relay deduplication succeeded.

Offline restart/outbox: persisted=true, accepted after restart=true, removed=true.

Failure scenarios:

- One unavailable: 1/3 connected, state syncing.
- Two unavailable: 0/3 connected, state syncing.

## Sleep/wake manual procedure

1. Launch the desktop app with a disposable Nostr identity and Network ON.
2. Wait for at least one relay to complete EOSE and note the connected count.
3. Put macOS to sleep from the Apple menu; wait at least 60 seconds.
4. Wake and unlock the Mac.
5. Confirm relays reconnect, subscriptions return, and a queued disposable event is accepted once.
6. Leave the app open for five minutes and confirm relay/socket counts remain bounded and no duplicate subscriptions or retry storms appear.

## Notes

- Public relay behavior is policy-dependent; a missing or rejected ACK is recorded rather than treated as an architectural failure.
- Automated system sleep was not attempted because suspending the host during an unattended tool run is unsafe.
