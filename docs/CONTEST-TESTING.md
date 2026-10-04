# Stegstr contest testing

## Install and run

### macOS

Use `Stegstr.app` or open the DMG and drag Stegstr to Applications. The current
candidate is unsigned and not notarized. On first launch, Control-click the app,
choose **Open**, then confirm. Alternatively use **System Settings → Privacy &
Security → Open Anyway** after macOS blocks the first double-click.

### Windows

Use the MSI or NSIS artifact produced by the repository's Windows GitHub Actions
job. Windows runtime verification is still required for this candidate. Do not
describe a macOS build as Windows-compatible evidence.

### Build from source

Requirements: current Node.js/npm, stable Rust, and the platform prerequisites
listed by Tauri 2. Then run:

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
npm run tauri build
```

Linux additionally needs WebKitGTK/AppIndicator development packages at build
time and a running Secret Service/keyring implementation for protected native
identity storage.

## Core workflow

1. Open **Identity** and create a local identity or explicitly import a
   disposable Nostr identity.
2. Write a note in the feed and post it. With Network OFF it remains local.
3. Open the steganography panel and choose **Embed image**.
4. Select a cover image. On desktop, the default robust choice produces a JPEG
   using Rust robust-v2; **Dot** remains the legacy PNG option.
5. Save the result. Desktop robust-v2 performs an immediate decode self-test.
6. Choose **Detect image**, select the saved image, and confirm the note appears.

## Real WhatsApp and Telegram tests

Use only clean files from `benchmarks/real-world/encoded/`. Do not preview-export,
resave, rename one returned file as another test, or use screenshots.

For every returned image run:

```sh
node benchmarks/real-world/verify-and-record.mjs RECEIVED_IMAGE \
  --platform whatsapp --mode normal-image --test-id TEST_ID
```

Change the platform/mode to:

- `whatsapp document-file`
- `telegram compressed-photo`
- `telegram uncompressed-file`

WhatsApp normal-image cases still needed are:

- `rw-dark-photo-32b`
- `rw-dark-photo-128b`
- `rw-screenshot-32b`
- `rw-screenshot-128b`
- Fresh independent returns for the normal and detailed photo cases previously
  recorded against a mismatched artifact.

Telegram compressed-photo and uncompressed-file modes need all twelve manifest
cases. Send each encoded file in the named mode, download the actual returned
artifact, then record it against its own test ID. Instagram remains optional
because many clients do not expose the processed artifact.

No result should be described as platform support unless `exact_match=true`.

## Nostr sync, relay configuration, and offline operation

- Network OFF performs local posting, embed, and detect without relay traffic.
- Network ON connects to the configured relays, restores subscriptions, merges
  valid events, and suppresses duplicate event IDs.
- Configure relays in **Settings** using `wss://` URLs. One unavailable relay
  should not prevent successful operation through another relay.
- Signed events created while offline enter the persistent outbox and are
  retried after connectivity returns.
- Native desktop identities use OS credential storage. Browser builds retain a
  weaker localStorage fallback.

## Physical macOS sleep/wake checklist

Do not automate sleep. Use a disposable Nostr identity and harmless unique text.

1. Launch Stegstr and enable Network.
2. Wait until the header reports at least one connected relay. Record the full
   status text and take a screenshot.
3. In Terminal capture established sockets and the current application log:

   ```sh
   lsof -nP -iTCP -sTCP:ESTABLISHED | rg -i stegstr > ~/Desktop/stegstr-sockets-before.txt
   tail -n 300 ~/Library/Application\ Support/Stegstr/stegstr.log > ~/Desktop/stegstr-log-before.jsonl
   ```

4. Put the Mac to sleep from the Apple menu. Wait at least 60 seconds.
5. Wake and unlock. Wait up to 90 seconds for relay recovery.
6. Record the relay status and capture the same diagnostics as `*-after.*`.
7. Confirm one copy—not multiple copies—of a uniquely named incoming event.
8. Toggle Network OFF, publish one harmless uniquely named test note, confirm a
   pending item, then toggle Network ON and confirm it flushes once.
9. Leave the app open for five minutes. Confirm the connected count stabilizes,
   the pending count reaches zero, and CPU/log activity does not show a retry
   storm.

Record:

```text
Sleep/wake: PASS / FAIL
Before relay status:
After relay status:
Reconnect within 90 s: PASS / FAIL
Subscription/event recovery: PASS / FAIL
Duplicate delivery absent: PASS / FAIL
Socket count bounded: PASS / FAIL
Retry storm absent: PASS / FAIL
Post-wake outbox flush: PASS / FAIL
Notes:
```

## Disposable legacy migration checklist

Use a dedicated test profile and Web Inspector. Never display or copy the raw
secret. Start the development app from the repository with:

```sh
env STEGSTR_TEST_PROFILE=contest-migration npm run tauri dev
```

Open Web Inspector and first remove any automatically generated test-profile
credentials by invoking `native_key_delete` for their visible key handles.

In the Console, this setup expression returns only the public key while storing
a newly generated legacy secret under the old keys:

```js
await (async () => {
  const N = await import('/src/nostr-stub.ts');
  const idsKey = 'stegstr_test_contest-migration_stegstr_identities';
  const anonKey = 'stegstr_test_contest-migration_stegstr_anon_key';
  const old = JSON.parse(localStorage.getItem(idsKey) ?? '[]');
  await Promise.all(old.filter((item) => item.keyHandle).map((item) =>
    window.__TAURI_INTERNALS__.invoke('native_key_delete', { keyHandle: item.keyHandle })
  ));
  const secret = N.generateSecretKey();
  const privateHex = N.bytesToHex(secret);
  const publicKey = N.getPublicKey(secret);
  localStorage.setItem(idsKey, JSON.stringify([{ id: `legacy-${publicKey.slice(0, 12)}`, publicKey, privKeyHex: privateHex, label: 'Disposable legacy migration', type: 'nostr', category: 'nostr' }]));
  localStorage.setItem(anonKey, privateHex);
  return { prepared: true, publicKey };
})()
```

Save only the returned public key, quit the app, and relaunch the native
development build with the same isolated profile so Web Inspector remains
available:

```sh
env STEGSTR_TEST_PROFILE=contest-migration npm run tauri dev
```

Check migration without reading the secret:

```js
(() => {
  const idsKey = 'stegstr_test_contest-migration_stegstr_identities';
  const anonKey = 'stegstr_test_contest-migration_stegstr_anon_key';
  const identity = JSON.parse(localStorage.getItem(idsKey) ?? '[]')[0];
  return {
    publicKey: identity?.publicKey,
    hasNativeHandle: /^nostr-[0-9a-f]{64}$/.test(identity?.keyHandle ?? ''),
    plaintextFieldPresent: Object.hasOwn(identity ?? {}, 'privKeyHex'),
    legacyAnonPresent: localStorage.getItem(anonKey) !== null,
  };
})()
```

The public key must match, `hasNativeHandle` must be true, and both plaintext
booleans must be false. Verify Keychain metadata without `-w`:

```sh
security find-generic-password -s com.stegstr.stealth.nostr -a 'PASTE_KEY_HANDLE_ONLY'
```

Restart again, sign a disposable event through the UI, and validate the event
with `validateNostrEvent`. For NIP-04, use the two native handles with
`native_nip04_encrypt`/`native_nip04_decrypt`, compare the returned plaintext,
then delete the temporary peer using `native_key_delete`. Finally remove the
test identity through the UI and confirm the Keychain metadata lookup fails.

Record:

```text
Migration: PASS / FAIL
Public key unchanged: PASS / FAIL
Native handle present: PASS / FAIL
Keychain metadata present: PASS / FAIL
Plaintext fields absent: PASS / FAIL
Restart persistence: PASS / FAIL
Signed event valid: PASS / FAIL
NIP-04 round trip: PASS / FAIL
Explicit deletion removed credential: PASS / FAIL
Notes:
```

## Known limitations

- The candidate is unsigned/not notarized.
- Physical sleep/wake and interactive legacy migration require the manual checks
  above.
- Windows and Linux runtime behavior is not verified on this Mac.
- Web identity secrets remain in browser localStorage.
- A texture-free low-detail carrier fails the frozen 50% resize and 50% + JPEG75
  robust-v2 cases; carrier suitability should be respected.
- WhatsApp evidence covers four exact returned files; Telegram and Instagram
  have no recorded returned-file evidence yet.
