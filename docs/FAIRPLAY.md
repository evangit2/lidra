# FairPlay

Lidra's lossless and Dolby tiers need FairPlay keys, and Apple only issues
those to its own clients. The FairPlay backend is that client: an
authenticated Apple Music session running as a local service that Lidra asks
for decryption and manifests. Keys never reach Lidra — only ciphertext goes
out and plaintext comes back.

## What it is

An Android/Linux FairPlay client that Lidra runs beside itself: a small
launcher binary plus an Android userspace it chroots into (`rootfs/system`,
with the Apple Music app's libraries). It signs in with your Apple Music
account, holds the session (`MUSIC_TOKEN`, cookies, storefront), derives
per-song key contexts, and serves its ports. Lidra drives it through the
vendored `fairplay-decrypter` package (`vendor/fairplay`); the runtime payload
— launcher, userspace, provisioned device identity — lives in
`vendor/fairplay-runtime` and is staged per install (account state is never
packaged).

## What it does

1. Signs in once (Settings → Audio, or the first-run prompt). The web player
   adopts the backend's store-services session, so one sign-in covers both.
2. Serves manifests for masters the account API omits (hi-res top renditions).
3. Decrypts audio fragments on request, per song, for the lifetime of its
   process.

If Apple refuses device enrollment, sign-in reports a cooldown instead of
retrying: repeated enrollment attempts keep the server-side block alive.

## The two sockets

| Socket | Setting | Default | Protocol |
| --- | --- | --- | --- |
| Decrypt | `LIDRA_DECRYPTOR` / Settings → Audio → FairPlay decrypt socket | `127.0.0.1:10020` | below |
| Manifest | `LIDRA_MANIFEST_SERVICE` | `127.0.0.1:20020` | `[len]adamId` → one line with the master `.m3u8` URL |

Setting the decrypt socket switches the pipeline to FairPlay mode for every
track. If the backend is down, the track falls back to the key source (which
reaches the AAC 256 kbps web-playback asset). If the manifest socket fails, the
pipeline falls back to the API's `enhancedHls`.

The service may move to a free port pair when the configured one is taken, so
Lidra re-reads both addresses per track. `unix:/path` addresses work for both.

The launcher binary actually listens on four ports (`--help` lists them all);
Lidra only uses two:

| Port | Flag | Used by Lidra |
| --- | --- | --- |
| 10020 | `--decrypt-port` | yes — fragment decryption |
| 20020 | `--m3u8-port` | yes — master manifests |
| 40020 | `--key-port` | no |
| 30020 | `--account-port` | no |

## Decrypt wire protocol

Little-endian, matching the FairPlay family of services. `len` is one byte:

```
select:  00 00 00 00 | [len]id | [len]skd://-URI
decrypt: [u32le length][ciphertext]  →  exactly `length` plaintext bytes
close:   00 00 00 00 00
```

The id is the song's `adamId`, except for the playlist's opening placeholder
key (`skd://…/P000000000/s1/e1`), which must be armed with the literal id `0`.
Only complete 16-byte blocks are sent — SAMPLE-AES audio leaves a trailing
partial block in the clear, so it is never sent. Lidra re-arms at every
fragment boundary (per-fragment state goes stale otherwise) and decrypts each
fragment in one pipelined batch with at most 256 KiB of unread plaintext in
flight.

## The key-context quirk

A backend process derives one key context per song and pins it until it exits.
Apple's playlists open with the placeholder key and switch to the song's real
key before the second segment, so the first arm has to take the prefetch path
(id `0`). Arming it with the real id leaves the real key unreachable — and the
service answers with noise rather than an error. That is why the pipeline
verifies every fragment's frame headers (ALAC header repetition, `0x0b77` for
AC-3/EC-3) and restarts the backend once when they do not match
(`restartDecryptor`). A restart is recoverable; a second failure surfaces as a
named playback error.

## Session and sign-in

The backend writes its session inside its Android data directory. Lidra adopts
the store-services session for the web player and shows backend status in
Settings once the runtime is ready. A stale backend triggers automatic runtime
setup instead of a dead process.

Windows runs the backend inside a private WSL2 distro (`LidraFairplay`),
imported from the `fairplay-rootfs.tar.gz` archive the installer ships — a
one-time, minutes-long step on first launch. The pre-rename `LidraWrapper`
distro is removed automatically after migration.

## Limits

- One process, one key context per song: concurrent tracks arm independently,
  but a restart interrupts whatever is decrypting.
- The backend holds your signed-in session. Treat its data directory like a
  login cookie: it is never packaged, logged, or transmitted anywhere but
  loopback.
- Radio, previews, videos and library-only items never touch the backend —
  the bridge only redirects catalog-id manifests.
