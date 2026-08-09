# Manual platform procedures

Use a fresh copy of every file in `encoded/`. Do not edit, preview-export, or
resave it before sending. For each mode, run all twelve manifest tests (six
carriers × 32/128 bytes). Do not infer a platform transformation: measure the
downloaded artifact with the recorder.

## WhatsApp

### Normal image

1. In a private test chat, choose the photo/image attachment flow.
2. Select one encoded JPEG and send with HD disabled unless the mode name records otherwise.
3. On the receiving device/client, download the received image at original available quality.
4. Save it under a unique name; do not take a screenshot.
5. Run `verify-and-record.mjs` with `--platform whatsapp --mode normal-image` and its manifest test ID.
6. Repeat for all twelve tests. Record a separate named mode for HD if tested.

### Document/file

1. Choose WhatsApp's document/file attachment flow, not the gallery/photo flow.
2. Send the same clean encoded file.
3. Download the received file, preserving its supplied extension.
4. Run the recorder with `--platform whatsapp --mode document-file`.
5. Repeat for all twelve tests.

## Telegram

### Compressed photo

1. In a private test chat, choose the gallery/photo flow and send as a compressed photo.
2. Download the received photo rather than taking a screenshot.
3. Run the recorder with `--platform telegram --mode compressed-photo`.
4. Repeat for all twelve tests.

### Uncompressed file

1. Choose Telegram's file/uncompressed flow.
2. Send and then download the exact received file.
3. Run the recorder with `--platform telegram --mode uncompressed-file`.
4. Repeat for all twelve tests.

## Instagram

Instagram flows must remain separate because processing may differ.

### Direct message

1. Send one encoded image through a private direct-message image attachment.
2. Obtain the actual received media file where the client permits it; a screenshot is not equivalent.
3. Run the recorder with `--platform instagram --mode direct-message`.
4. Repeat all twelve cases only if the received artifacts can be retrieved consistently.

### Feed or story (optional)

Use a private/test account and a distinct `feed` or `story` mode. Publish only
with the account owner's approval. Retrieve the processed media artifact, run
the same twelve-case matrix, and keep these observations separate. If a client
does not permit artifact retrieval, record no result and do not claim support.

## Interpretation

- `PASS`: robust-v2 decoded and the recovered SHA-256 maps to the expected test ID.
- `FAIL`: a payload was detected but it does not exactly match the expected test.
- `NO STEGSTR PAYLOAD`: no sync candidate crossed the decoder threshold.
- `CORRUPTED / UNRECOVERABLE`: synchronization was found but header/FEC/integrity recovery failed.

The empty checked-in result files intentionally mean “not measured,” not zero
success. Platform claims require actual returned files and repeated observations.
