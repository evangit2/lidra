# Delivered quality

Lidra's claim is not "the manifest offers lossless". It is "the audio you are
playing *is* lossless, at this bit depth and this sample rate". That claim is
checked against the stream itself, not against the manifest that advertises it.

## How the check works

Apple's `enhancedHls` media playlists carry an initialisation segment
(`EXT-X-MAP`). It is **not encrypted** — only the media fragments are — and it
contains the codec configuration the decoder will actually be set up with:

| Codec | Where the truth lives |
| --- | --- |
| ALAC | the `alac` magic cookie inside the `enca` sample entry: bit depth, channels, average bitrate, sample rate. Apple wraps the real entry in `enca`, so the codec is resolved through `sinf`/`frma`. |
| AAC | `esds` → DecoderConfigDescriptor (average bitrate) and the AudioSpecificConfig (rate, channels) |
| Dolby Atmos / E-AC-3 | `dec3`: data rate, channel layout from `acmod` + `lfeon`, whether dependent substreams are present |
| Dolby Audio / AC-3 | `dac3`: bit-rate code, channel layout |

So every tier can be verified before a single key is fetched. `src/audio/quality.ts`
does the parsing; the pipeline runs it on every track and logs the result, and the
in-app badge shows it.

Manifest attributes are treated as claims to be checked, not facts. Two real
examples from a live account:

- a `CHANNELS="16/JOC"` Atmos group whose actual E-AC-3 core is 5.1 with 768 kbps;
- ALAC groups labelled by sample rate and depth, where a 24-bit/44.1 kHz stream is
  lossless-with-24-bit-depth, **not** the hi-res tier (Apple reserves that name for
  above 48 kHz). Lidra labels what it measured and keeps the depth visible.

## Measured results

Live account, 22 renditions across 9 songs, real Apple CDN, read from the streams'
own codec configuration:

| Tier | Manifest said | Stream configuration said | Verdict |
| --- | --- | --- | --- |
| Hi-res | ALAC 24-bit/192 kHz | ALAC 24-bit/192 kHz stereo, 9216 kbps | PASS |
| Lossless | ALAC 24-bit/48 kHz | ALAC 24-bit/48 kHz stereo, 2304 kbps | PASS |
| Lossless | ALAC 24-bit/44.1 kHz | ALAC 24-bit/44.1 kHz stereo, 2117 kbps | PASS |
| Lossless | ALAC 16-bit/44.1 kHz | ALAC 16-bit/44.1 kHz stereo, 1411 kbps | PASS |
| Atmos | Dolby Atmos 768 kbps | E-AC-3 48 kHz 5.1, 768 kbps (16/JOC in manifest) | PASS |
| AAC | AAC 256 kbps | AAC 44.1 kHz stereo, 255–258 kbps | PASS |

Counts: 1 hi-res, 11 lossless, 10 Atmos, 2 AAC — 22 of 22 PASS. The AAC figures
land 1–2 kbps either side of the nominal 256 kbps because that is what the
encoder's own average-bitrate field says; the check allows 15 % before it calls
a mismatch.

Atmos integrity is checked frame by frame, not just at the codec level: 1,404
frames across 44.93 s of the 768 kbps rendition, each exactly 3,072 bytes, offsets
contiguous, every subsample split covering its frame; the 448 kbps rendition is
1,792 bytes per frame. `LIDRA_SPATIAL=binaural` selects Apple's spatial render
instead, measured at 48 kHz stereo 259 kbps.

AAC alone was also checked on both a 24/44.1 and a 16/44.1 title, so the tier
ladder is verified on quiet and loud masters.

## Reproduce it

```bash
npm run build
# with Lidra signed in (the report reuses the app's session, no credentials copied)
LIDRA_REPORT_MAX=10 npx electron test/e2e/quality-report.cjs "billie eilish" "miles davis"
# a specific song, and include the AAC tiers
LIDRA_REPORT_IDS=268443097 LIDRA_REPORT_AAC=1 npx electron test/e2e/quality-report.cjs
```

Each inspected rendition prints one JSON line with `declared`, `actual` (codec,
rate, depth, channels, bitrate, Atmos flag) and a `verdict` of `PASS`, `MISMATCH`
or `ERROR`. Anything that differs from the manifest is listed in `mismatches`
with both numbers.

## Multichannel playback

Atmos and Dolby Audio arrive as E-AC-3, which Chromium cannot decode. Lidra
remuxes to multi-channel FLAC and the browser does decode that: the multichannel
test appends 6 seconds of 5.1 FLAC through Media Source Extensions and Chromium
reports `readyState 4` with ~210 KB decoded.

```bash
npm run test:multichannel
```

## What a mismatch means

The pipeline logs `quality mismatch for <song>: <details>` and the badge turns
amber with the measured value. In practice a mismatch means one of:

- Apple served a lower rendition than the master advertised (regional catalogue,
  or a track that was re-mastered between catalogue and CDN);
- a key/wrapper service returned a stream for a different rendition than the one
  requested;
- the manifest's descriptor is stale.

None of these are silently ignored: the measured numbers are in the log.
