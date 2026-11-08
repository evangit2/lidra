# The wrapper

Lidra's lossless and Dolby tiers need FairPlay keys, and Apple only issues
those to its own clients. The wrapper is that client: an authenticated Apple
Music session running as a local service that Lidra asks for decryption and
manifests. Keys never reach Lidra — only ciphertext goes out and plaintext
comes back.

## What it is

An Android/Linux FairPlay client (the reference downloader family) that Lidra
runs beside itself: a small launcher binary plus an Android userspace it
chroots into (`rootfs/system`, with the Apple Music app's libraries). It signs
in with your Apple Music account, holds the session (`MUSIC_TOKEN`, cookies,
storefront), derives per-song key contexts, and serves two TCP/Unix sockets.

The wrapper's code is not in this repository. The launcher binary comes from
your own machine (`~/.lidra-wrapper/extracted`); `scripts/build-wrapper-runtime.sh`
packs it with its rootfs into `build/wrapper/wrapper-rootfs.tar.gz` (account
data is refused at pack time), which ships inside the app's releases.

## What it does

1. Signs in once (Settings → Audio). The signed-in web player adopts the
   wrapper's session, so one sign-in covers both.
2. Serves manifests for masters the account API omits (hi-res top renditions).
3. Decrypts audio fragments on request, per song, for the lifetime of its
   process.

## The two sockets

| Socket | Setting | Default | Protocol |
| --- | --- | --- | --- |
| Decrypt | `LIDRA_DECRYPTOR` / Settings → Audio → Wrapper decrypt socket | `127.0.0.1:10020` | below |
| Manifest | `LIDRA_MANIFEST_SERVICE` | `127.0.0.1:20020` | `[len]adamId` → one line with the master `.m3u8` URL |

Setting the decrypt socket switches the pipeline to wrapper mode for every
track. If the wrapper is down, the track falls back to the key source (which
reaches the AAC 256 kbps web-playback asset). If the manifest socket fails, the
pipeline falls back to the API's `enhancedHls`.

The service may move to a free port pair when the configured one is taken, so
Lidra re-reads both addresses per track. `unix:/path` addresses work for both.

The wrapper binary actually listens on four ports (`--help` lists them all);
Lidra only uses two:

| Port | Flag | Used by Lidra |
| --- | --- | --- |
| 10020 | `--decrypt-port` | yes — fragment decryption |
| 20020 | `--m3u8-port` | yes — master manifests |
| 40020 | `--key-port` | no |
| 30020 | `--account-port` | no |

## Decrypt wire protocol

Little-endian, matching the wrapper family of services. `len` is one byte:

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

A wrapper process derives one key context per song and pins it until it exits.
Apple's playlists open with the placeholder key and switch to the song's real
key before the second segment, so the first arm has to take the prefetch path
(id `0`). Arming it with the real id leaves the real key unreachable — and the
service answers with noise rather than an error. That is why the pipeline
verifies every fragment's frame headers (ALAC header repetition, `0x0b77` for
AC-3/EC-3) and restarts the wrapper once when they do not match
(`restartDecryptor`). A restart is recoverable; a second failure surfaces as a
named playback error.

## Session and sign-in

The wrapper writes its session inside its Android data directory. Lidra reads
it from both there and next to the launcher (older layouts), parsing the
launch line through its shell quoting, and shows the effective command in
Settings once the runtime is ready. A command is only accepted if the OS can
actually start it — anything else triggers automatic runtime setup instead of
a dead `exited 4294967295`.

Windows runs the wrapper under WSL1, which is a one-time prerequisite
(admin PowerShell, then sign out and back in):

```
wsl --install --no-distribution
wsl --set-default-version 1
```

## Limits

- One process, one key context per song: concurrent tracks arm independently,
  but a restart interrupts whatever is decrypting.
- The wrapper holds your signed-in session. Treat its data directory like a
  login cookie: it is never packaged, logged, or transmitted anywhere but
  loopback.
- Radio, previews, videos and library-only items never touch the wrapper —
  the bridge only redirects catalog-id manifests.
