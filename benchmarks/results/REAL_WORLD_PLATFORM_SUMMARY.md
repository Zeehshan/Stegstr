# Real-world platform evidence

This summary classifies only the observations in
`real-world-platform-results.json`. A decode counts as confirmed only when the
returned payload maps to the expected manifest test ID. A file-size match alone
is not proof that two returned artifacts are byte-identical.

## WhatsApp normal-image mode

| Test | Carrier | Payload | Result | Evidence classification |
|---|---|---:|---|---|
| `rw-bright-photo-32b` | Bright photo | 32 B | Exact match | Confirmed returned-file test |
| `rw-bright-photo-128b` | Bright photo | 128 B | Exact match | Confirmed returned-file test |
| `rw-low-detail-photo-32b` | Low-detail photo | 32 B | Exact match | Confirmed returned-file test |
| `rw-low-detail-photo-128b` | Low-detail photo | 128 B | Exact match | Confirmed returned-file test |
| `rw-normal-photo-32b` | Normal photo | 32 B | Wrong test ID | Excluded; mismatched/reused-file attempt |
| `rw-normal-photo-128b` | Normal photo | 128 B | Wrong test ID | Excluded; mismatched/reused-file attempt |
| `rw-detailed-photo-32b` | Detailed photo | 32 B | Wrong test ID | Excluded; mismatched/reused-file attempt |
| `rw-detailed-photo-128b` | Detailed photo | 128 B | Wrong test ID | Excluded; mismatched/reused-file attempt |

Confirmed independent evidence is therefore **4/4 exact matches among four
usable returned artifacts**, not 8/8. The four excluded rows all recorded a
383,381-byte artifact and report `decode_success=true`, `exact_match=false`.
That pattern is consistent with the bright-photo 32-byte return being checked
under additional test IDs. The returned artifact is no longer present, so this
cannot be confirmed by SHA-256 retroactively.

## Untested cases

- WhatsApp normal image: dark photo 32/128 B and screenshot 32/128 B.
- WhatsApp document/file: all 12 kit cases.
- Telegram compressed photo: all 12 kit cases.
- Telegram uncompressed file: all 12 kit cases.
- Instagram: no confirmed returned-file observations.

Future recorder runs include the returned-file SHA-256 and recovered test ID so
artifact reuse is visible without exposing payload bytes.
