# Lidra's audio pipeline

This document describes how Lidra plays Apple Music audio without Chromium's DRM
stack, and what you have to provide for it to work.

Sidra wraps `music.apple.com` and lets the page play. That requires a Widevine
CDM, which requires a castLabs Electron build signed with production VMP keys —
the reason Sidra's releases need EVS credentials. Lidra keeps the same page and
the same UI, but takes over the audio path.

## Data flow

```
 music.apple.com (unchanged UI)
        │  nowPlayingItemDidChange  ──────────────►  engine.markCurrent(id)
        │                                              │
        │  GET …/playlist.m3u8 (held open)             │  Apple Music API
        │◄──────────── redirect ───────────────────────┤  /v1/catalog/{sf}/songs/{id}
        │                                              │      ?extend=extendedAssetUrls
        │  GET master.m3u8 / media.m3u8 / segN.m4s      │            │
        │◄──────────── 127.0.0.1 (loopback HLS) ────────┤      enhancedHls
                                                       │            │
                            ┌──────────────────────────┴────────────▼─────────┐
                            │ 1. parse master, rank renditions, pick quality   │
                            │ 2. fetch media playlist: EXT-X-MAP + segments    │
                            │ 3. fetch fragments as byte ranges                │
                            │ 4. AES-128-CBC decrypt (cbcs / cenc)             │
                            │ 5. mux to fMP4 HLS (copy or FLAC)                │
                            └──────────────────────────┬───────────────────────┘
                                                       │
                                    key service ◄──────┤ (key mode)
                            wrapper decrypt socket ◄───┘ (wrapper mode)
```

The page never sees encrypted bytes. Its manifest request is redirected to the
loopback server, whose playlist points at muxed, plain fMP4. EME is shimmed so
the player's capability probe succeeds; no licence request is ever made.

## Quality selection

`enhancedHls` is a master playlist with one variant per rendition. Apple encodes
the quality in the `AUDIO` attribute and the codec in `CODECS`:

```
#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="alac",AUDIO="audio-alac-stereo-192000-24"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="alac",AUDIO="audio-alac-stereo-44100-16"
#EXT-X-STREAM-INF:BANDWIDTH=768000,CODECS="ec-3",AUDIO="audio-atmos-stereo-2768"
#EXT-X-STREAM-INF:BANDWIDTH=640000,CODECS="ac-3",AUDIO="audio-dolby-stereo-640"
#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
```

Tiers, best first: `hi-res` (ALAC > 48 kHz), `lossless` (ALAC ≤ 48 kHz), `atmos`
(EC-3), `dolby-audio` (AC-3), `aac`. The preference names a floor: asking for
`hi-res` on a song mastered at 44.1/16 plays the lossless rendition, not silence.

## Codecs

Chromium decodes AAC and FLAC but **not** ALAC or E-AC-3 (verified on the
Electron build shipped here). So:

| Source | Path | Quality |
| --- | --- | --- |
| `mp4a.40.2` / `mp4a.40.5` | fMP4 → fMP4, stream copy | unchanged |
| `alac` | fMP4 → fMP4 with FLAC | lossless, bit-exact |
| `ec-3` / `ac-3` | fMP4 → fMP4 with FLAC | lossless after decode; 5.1 preserved |

Dolby Atmos object metadata is not reconstructed — the E-AC-3 core is decoded and
its channels are passed through. Spatial rendering then depends on the OS and
output device.

## Latency

The pipeline is built around never waiting for a whole track:

1. Resolution starts on `nowPlayingItemDidChange`, before the player asks for a
   manifest, so the catalog round trip overlaps the click.
2. The player's manifest request is **held** (not failed, not served empty) until
   the first muxed segment exists, typically a few hundred milliseconds.
3. ffmpeg writes HLS segments of 2 seconds as fragments arrive, so audio starts
   after roughly one segment of decode instead of after the whole download. A
   hi-res track is 100 MB+; that difference is the whole point.
4. Completed tracks are cached under `userData/audio-cache/<id>/`; replaying one
   skips download, decryption and muxing entirely.
5. Conversion only happens when the codec needs it. AAC costs no transcode.

## Why the key type depends on the client

Apple picks the DRM system from the client it believes it is talking to, not from
the account. Same subscription, same `media-user-token`, different output:

| Client the manifest is issued to | `EXT-X-KEY` | Key comes from |
| --- | --- | --- |
| Web player (Chrome/Electron session) | `data:` URI with a Widevine `pssh` | Widevine licence endpoint |
| Android/Apple device wrapper | `skd://itunes.apple.com/…` | FairPlay key service |

Lidra's signed-in page is a web session, so the `enhancedHls` it resolves
contains **Widevine** PSSH — verified against a live subscription, including with
a Safari user agent. A FairPlay-only key service therefore cannot unlock that
manifest, and a Widevine key cannot unlock an `skd://` manifest. Lidra accepts
whichever the playlist declares and sends it to the matching key source.

## Key sources

Lidra contains no key extraction and bundles no CDM. It either performs the
Widevine licence exchange with a device you supply, or asks a service you run for
keys (or for decryption itself). All of it is configured, never bundled.

### Widevine licence (built in, `LIDRA_WIDEVINE_DEVICE`)

Point `LIDRA_WIDEVINE_DEVICE` at a `.wvd` file, or at a directory containing
`client_id.bin` and `private_key.pem`. Lidra then requests the licence itself:

```
PSSH ──► SignedMessage(LicenseRequest)  signed with the device RSA key
      ──► POST play.itunes.apple.com/…/acquireWebPlaybackLicense
          authorization: Bearer <developer token>
          x-apple-music-user-token: <media user token>
      ──► SignedMessage(License) with RSA-wrapped session key
      ──► content key = AES-128-CBC⁻¹(CMAC(session key, request), key.iv)
```

`.wvd` layout: `u32be len + client_id protobuf + u32be len + RSA private key`.
The CDM is a device credential, not a secret Lidra ships or derives; a licence
issued through it is scoped to the subscriber who signed in.

### Key service (`LIDRA_KEY_SERVICE`, `LIDRA_KEY_TRANSPORT`)

Newline-delimited JSON over TCP, a Unix socket, or HTTP POST:

```json
{"adamId":"1440833098","keyUri":"skd://itunes.apple.com/P000000000/s1/e1","kid":"…"}
→ {"key":"<base64 of 16 bytes>"}     or    {"error":"not entitled"}
```

Keys are cached per (song, key URI) for the process lifetime. HTTP adds an
optional `Authorization: Bearer $LIDRA_KEY_TOKEN`.

### Wrapper decrypt socket (`LIDRA_DECRYPTOR`)

Compatibility with the wrapper-style decryptor used by the reference downloader.
Set `LIDRA_DECRYPTOR=127.0.0.1:10020` (or `unix:/path`) and Lidra sends
ciphertext instead of asking for keys:

```
select:  00 00 00 00 | [len]"1440833098" | [len]"skd://itunes.apple.com/…"
decrypt: [u32le length][ciphertext]  →  exactly `length` plaintext bytes
```

Complete 16-byte blocks are sent; cbcs leaves a trailing partial block clear, so
it is never sent.

### Wrapper manifest socket (`LIDRA_MANIFEST_SERVICE`)

For masters the account API omits, the wrapper's manifest endpoint is used:

```
[len]"1440833098"  →  one line: https://…/master.m3u8
```

If it fails, the pipeline falls back to the API's `enhancedHls` without
interrupting playback.

## Decryption

Apple Music audio is fMP4 with SAMPLE-AES (`cbcs`): AES-128-CBC per sample, the
IV from `tenc`'s constant IV, whole-sample encryption for audio, and a trailing
partial block left in the clear. Lidra also implements `cenc`/`cbc1` (per-sample
IVs from `senc`, 8-byte IVs right-padded) and subsample encryption, because the
same folders appear in Apple's other media.

`src/audio/mp4/` implements the box parser, init rewriting (strip `sinf`/`tenc`,
rename `enca` to its `frma` format) and sample-level decryption. The AES primitive
is injectable, which is what lets the wrapper socket decrypt remotely without
Lidra ever holding a key.

## Verification status

Covered by automated tests in this repository:

- MP4 decryption round trips: cbcs full-sample, cbcs subsample, cenc 8/16-byte
  IVs, multi-`moof` chunks, non-aligned cbcs tails, init rewriting, tampered
  input (`test/audio-mp4.test.ts`).
- Master/media playlist parsing, ranking and preference fallback
  (`test/audio-hls.test.ts`).
- Key service transports and caching (`test/audio-keys.test.ts`).
- Wrapper decrypt and manifest sockets, including wire framing
  (`test/audio-legacy.test.ts`).
- Loopback HLS server: playlists, ranges, CORS, retry semantics
  (`test/audio-server.test.ts`).
- Real end-to-end decode: ALAC 24-bit/96 kHz → decrypt/mux path → HLS/FLAC →
  Chromium `MediaSource` plays and advances
  (`test/e2e/audio-playback.cjs`).

Not verifiable in CI, and therefore not claimed: the exact shape of a
subscriber's `enhancedHls` for every storefront, and any key service you connect.
`test/e2e/apple-probe.cjs` reports both against a signed-in session without
copying credentials.

## Limits worth knowing

- Chromium resamples to the output device's rate; the pipeline is lossless up to
  Chromium, not bit-perfect to the DAC.
- Radio, previews and music videos keep the page's own playback path and
  therefore still need a CDM. Lidra deliberately does not touch them.
- Library-only items without a catalog id cannot be resolved through the API.
- `ffmpeg` is required for lossless and Dolby renditions; AAC plays without it.
