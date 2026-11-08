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
| binaural spatial render (separate `mp4a` rendition) | fMP4 → fMP4, stream copy | unchanged stereo; only selected when quality is `atmos` and spatial is `binaural` |

Dolby Atmos object metadata is not reconstructed — the E-AC-3 core is decoded and
its channels are passed through. Spatial rendering then depends on the OS and
output device.

## Latency

The pipeline is built around never waiting for a whole track:

1. Resolution starts on `nowPlayingItemDidChange`, before the player asks for a
   manifest, so the catalog round trip overlaps the click.
2. The player's manifest request is **held** via the bridge (`waitForCurrent`,
   up to ~20 s) until the pipeline is ready — i.e. the first fragment is
   decrypted and muxed — not failed or served empty. Before the playlist file
   exists the loopback server answers 503 with `Retry-After: 1`, so the player
   retries instead of erroring. Expect a few seconds (network + first decrypt),
   typically a few hundred milliseconds of hold after resolution.
3. ffmpeg writes HLS segments of 2 seconds (`HLS_SEGMENT_SECONDS`) as fragments arrive, so audio starts
   after roughly one segment of decode instead of after the whole download. A
   hi-res track is 100 MB+; that difference is the whole point.
4. Completed tracks are cached under `userData/audio-cache/<id>/`; replaying one
   skips download, decryption and muxing entirely.
5. Conversion only happens when the codec needs it. AAC costs no transcode.

## Which DRM system a stream uses

Apple's master playlist advertises **every** system it can serve for an asset, in
`#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.AudioSessionKeyInfo"`. A live dump of a
Dolby Atmos title shows all three side by side:

```
"com.microsoft.playready":            data:text/plain;base64,vgEAAA…
"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"  (Widevine)
                                      data:;base64,AAAOHA…  ← pssh box
"com.apple.streamingkeydelivery":     skd://itunes.apple.com/p1419383922/c24
```

Which one ends up in the media playlist's `EXT-X-KEY` depends on which master the
rendition came from:

| Master | `EXT-X-KEY` in the media playlist | Key comes from |
| --- | --- | --- |
| Catalog `enhancedHls` (all lossless/Atmos/AAC renditions) | `skd://itunes.apple.com/…` (FairPlay) | wrapper decrypt socket or key service |
| `webPlayback` fallback asset (`28:ctrp256`, AAC 256) | `data:` URI carrying a **Widevine** `pssh` | Widevine licence exchange (`LIDRA_WIDEVINE_DEVICE`) |

Lidra's signed-in page is a web session, and every lossless and Atmos rendition in
the catalog's `enhancedHls` master declares FairPlay (`skd://itunes.apple.com/…`)
— even to a web session, including with a Safari user agent. No CDM key exchange
opens those renditions; the reference downloader works the same way. A Widevine
`data:` PSSH appears only on the older `webPlayback` fallback asset (flavour
`28:ctrp256`, AAC 256), which is the honest ceiling of the Widevine path. `skd://`
in older wrapper/video paths is unrelated to this audio pipeline.

## Key sources

Lidra contains no key extraction and bundles no CDM. It either performs the
Widevine licence exchange with a device you supply, or asks a service you run for
keys (or for decryption itself). Priority in `src/main.ts`: wrapper decrypt
socket when `LIDRA_DECRYPTOR` is set (mode `wrapper`), otherwise the key cache
backed by the Widevine device when `LIDRA_WIDEVINE_DEVICE` is set, otherwise the
configured key service, otherwise an unconfigured provider that fails loudly.
All of it is configured, never bundled.

Ceilings: the wrapper and key-service paths open every tier (lossless/Atmos
verified end-to-end on Linux via the wrapper); the Widevine-device path alone
opens only the AAC 256 kbps `webPlayback` fallback, because every
`enhancedHls` lossless/Atmos rendition is FairPlay-only.

### Object audio and spatial presentation

Atmos is delivered as E-AC-3 with Joint Object Coding: the manifest advertises
`CHANNELS="16/JOC"`, while the decoded core is 5.1. Lidra offers two presentations,
because a browser has no Atmos renderer and FLAC cannot carry objects:

| `LIDRA_SPATIAL` | What plays | Measured |
| --- | --- | --- |
| `bed` (default) | the 5.1 E-AC-3 core, repackaged to 5.1 FLAC | 48 kHz, 6 channels, 768 kbps (or 448 for the lower tier) |
| `binaural` | Apple's own spatial render folded to stereo (`...-binaural`) | 48 kHz stereo, 259 kbps AAC |

`binaural` only changes the answer when the quality preference is `atmos`; `auto`,
`hi-res` and `lossless` keep the fidelity-first ordering. Object metadata is not
extracted in either mode — heights and head-tracked rendering are not reproduced.

### Verified quality

Every pipeline inspects the clear initialisation segment before decrypting
anything and records what the stream really is (codec, bit depth, sample rate,
channels, bitrate, Atmos bed). That measurement drives the in-app badge and the
mismatch warning; see [QUALITY.md](QUALITY.md).

### ffmpeg

ALAC and E-AC-3 cannot be decoded by Chromium, so lossless and Dolby playback go
through ffmpeg. The release builds bundle a platform binary (`ffmpeg-static`,
unpacked out of the asar) rather than depending on the machine having one:
`LIDRA_FFMPEG` > bundled binary > `PATH`.

### Widevine licence (built in, `LIDRA_WIDEVINE_DEVICE`)

Point `LIDRA_WIDEVINE_DEVICE` at a `.wvd` file, or at a directory containing
`client_id.bin` and `private_key.pem`. Lidra then requests the licence itself:

Apple does not always offer a Widevine `data:` PSSH in the media playlist. Some
renditions declare FairPlay (`skd://itunes.apple.com/P000000000/s1/e1`) even to a
web session — verified on a 24-bit/192 kHz Atmos-era master. Lidra therefore
follows the reference client: when the key URI is not a Widevine PSSH it
synthesizes the CENC header (AESCTR + a stable KID derived from the song) and
sends that. The licence is scoped to `adamId`, so the KID only has to be stable.

The request shape is verified against the live endpoint with a throwaway device:

```
HTTP 200  {"status": -1003}      # device not authorised
```

That is a licence-level answer, not a schema error — headers, challenge encoding
and `adamId` are all accepted.

**`-1003` is caused by the `uri` field, not by the device.** Apple keys the
licence on the exact key URI the manifest declared. Sending a rebuilt CENC header
(`data:;base64,<32 filler bytes + WidevineCencHeader>`) is refused even with a
valid device; sending the manifest's own `data:;base64,<kid>` URI returns a
licence. Verified with a real L3 device: the response decodes to a 16-byte
content key, and ffmpeg decrypts the stream cleanly with it (and fails with
`channel element not allocated` without it). The challenge still carries a CENC
header built the way the reference client builds it (AESCTR + the same KID), so
the CDM and the licence agree on the track.

Quality ceiling of this path: Apple only advertises a Widevine key on the
`28:ctrp256` web-playback flavour. Every rendition in the catalog's `enhancedHls`
master — ALAC 24/192, ALAC 24/48, Atmos E-AC-3, and even AAC — declares
`skd://` FairPlay only, and `webPlayback` serves its lossless flavours the same
way. So the built-in Widevine route reaches AAC 256 kbps, not lossless; lossless
and Atmos need the FairPlay path (see the wrapper sections below).

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

### Web-playback fallback (Widevine, 256 kbps)

Every lossless and Atmos rendition is FairPlay-only, so a Widevine device alone
cannot open them. Apple's older `webPlayback` endpoint still serves one rendition
keyed with Widevine — flavour `28:ctrp256`, AAC 256 — so when the chosen
rendition declares `skd://` and a device is configured, the pipeline switches to
that asset instead of failing at the first segment.

```
enhancedHls master ──► best variant ──► key URI skd:// ? ──► webPlayback
                                                             28:ctrp256
                                       └── else: stream the chosen variant
```

Measured on a 9:08 track with a real device: prepared in 545 ms, first playable
segment at 1.15 s, whole track decrypted in 2.7 s. The playlist ffmpeg writes is
`#EXT-X-ELIST`-style `event`, so playback starts on the first segment rather than
waiting for the download to finish.

`cenc` (AES-CTR) streams decrypt with the keystream positioned per sample, which
is why unaligned AAC frames decrypt correctly; `cbcs` keeps its block-aligned
path. Without a device or wrapper the track still fails, and the UI says so.

### Key service (`LIDRA_KEY_SERVICE`, `LIDRA_KEY_TRANSPORT`)

Newline-delimited JSON over TCP, a Unix socket, or HTTP POST:

```json
{"adamId":"1440833098","keyUri":"skd://itunes.apple.com/P000000000/s1/e1","kid":"…"}
→ {"key":"<base64 of 16 bytes>"}     or    {"error":"not entitled"}
```

Keys are cached per (song, key URI) for the process lifetime. HTTP adds an
optional `Authorization: Bearer $LIDRA_KEY_TOKEN`.

### Wrapper decrypt socket (`LIDRA_DECRYPTOR`)

How the wrapper itself works — session, wire protocol, the key-context quirk —
is documented in [WRAPPER.md](WRAPPER.md).

Compatibility with the wrapper-style decryptor used by the reference downloader.
Set it in Settings → Audio → *Wrapper decrypt socket* (`host:port`), and
optionally *Wrapper manifest socket* for a wrapper that serves the playlist
itself. Setting the decrypt socket switches the pipeline to wrapper mode; the
key never reaches Lidra, it only sees ciphertext in and plaintext out.
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

### The wrapper's key context

A wrapper process derives one key context per song and pins it until it exits.
Apple's media playlists begin with a placeholder key
(`skd://itunes.apple.com/P000000000/s1/e1`) and switch to the song's real key
before the second segment, so the first arm has to address the placeholder the
way the reference client does: with the literal song id `0`. Arming it with the
real id leaves the real key unreachable, and the service then answers with noise
rather than an error — which is why the pipeline verifies every fragment's frame
headers (ALAC header repetition, `0x0b77` for AC-3/EC-3) and restarts the
wrapper once when they do not match.

Fragments are decrypted in one pipelined batch with a bounded in-flight window
(256 KiB of unread plaintext). Round-tripping per sample costs about a
millisecond each, which on a 15 s fragment dominated start-up.

## Verification status

Covered by automated tests in this repository:

- MP4 decryption round trips: cbcs full-sample, cbcs subsample, cenc 8/16-byte
  IVs, multi-`moof` chunks, non-aligned cbcs tails, init rewriting, tampered
  input (`test/audio-mp4.test.ts`).
- Master/media playlist parsing, ranking and preference fallback
  (`test/audio-hls.test.ts`).
- Key service transports and caching (`test/audio-keys.test.ts`).
- Wrapper decrypt and manifest sockets, including wire framing, the
  placeholder-key arm id, batched decryption and plaintext verification
  (`test/audio-legacy.test.ts`).
- Loopback HLS server: playlists, ranges, CORS, retry semantics
  (`test/audio-server.test.ts`).
- Real end-to-end decode: ALAC 24-bit/96 kHz → decrypt/mux path → HLS/FLAC →
  Chromium `MediaSource` plays and advances
  (`test/e2e/audio-playback.cjs`).
- Init-level quality across 22 renditions (1 hi-res, 11 lossless, 10 Atmos,
  2 AAC) plus Atmos frame integrity (1,404 frames at 768 kbps, 448 kbps tier)
  — see [QUALITY.md](QUALITY.md).

Confirmed tiers (what actually plays, and where):

| Tier | Linux | macOS | Windows |
| --- | --- | --- | --- |
| AAC 256 (stream copy) | yes, wrapper + key + Widevine paths | same code, not live-run here | same code, not live-run here |
| ALAC lossless / hi-res (FLAC repack) | yes, wrapper path decrypt-to-audible | same code + bundled ffmpeg, not live-run here | same code + bundled ffmpeg, not live-run here |
| Atmos bed 5.1 FLAC | yes, wrapper path (768 + 448 kbps frame-checked) | same code + bundled ffmpeg, not live-run here | same code + bundled ffmpeg, not live-run here |
| Binaural AAC stereo | selected only for quality `atmos` + spatial `binaural`; stream copy, no ffmpeg | same logic, not live-run here | same logic, not live-run here |
| Dolby Audio AC-3 | code path identical to Atmos; no live AC-3 master measured | — | — |

Not verifiable in CI, and therefore not claimed: the exact shape of a
subscriber's `enhancedHls` for every storefront, and any key service you connect.
`test/e2e/apple-probe.cjs` reports both against a signed-in session without
copying credentials.

## Limits worth knowing

- Chromium resamples to the output device's rate; the pipeline is lossless up to
  Chromium, not bit-perfect to the DAC.
- Radio, previews, music videos and library-only items without a catalog id keep
  the page's own playback path (the bridge only redirects catalog-id manifests)
  and therefore still need a CDM. Lidra deliberately does not touch them.
- Without a wrapper or key service, lossless/Atmos fall back to the AAC 256 kbps
  web-playback asset when a Widevine device is configured, and fail with a named
  error otherwise.
- `ffmpeg` is required for lossless and Dolby renditions; AAC (including the
  binaural render) plays without it. Resolution order: `LIDRA_FFMPEG` > bundled
  binary > `PATH`.
- Object metadata (heights, head-tracking) is not reproduced in either spatial
  mode; `bed` keeps the 5.1 core, `binaural` plays Apple's stereo render.
