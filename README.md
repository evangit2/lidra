<h1 align="center">
  <img src="assets/lidra-mark.png?v=2" width="128" height="128" alt="Lidra">
  <br />
  Lidra
</h1>

<p align="center"><b>Apple Music as a proper desktop app for Linux, macOS and Windows.</b></p>

<p align="center">Made with 💝 for 🐧🍏🪟</p>

Lidra wraps `music.apple.com` directly: Apple owns the interface and keeps it current, while Lidra wires it into each platform's native media subsystem (media keys, MPRIS, Now Playing, taskbar controls) instead of bolting on a custom player. An Apple Music subscription is required for playback.

> **Fork note:** Lidra is a fork of [wimpysworld/sidra](https://github.com/wimpysworld/sidra) (Blue Oak 1.0.0, © Martin Wimpress). UI, theming, sign-in flow and release infrastructure are unchanged from upstream. The playback stack is replaced: Lidra serves Apple Music's lossless, hi-res and Dolby renditions through its own audio pipeline instead of Chromium's DRM path. See [Audio pipeline](#audio-pipeline) and [docs/AUDIO-PIPELINE.md](docs/AUDIO-PIPELINE.md).

<p align="center">
  <a href="assets/lidra-screenshot.png?v=3"><img src="assets/lidra-screenshot.png?v=3" alt="Lidra playing music with Settings open" width="100%"></a>
</p>

## Audio pipeline

Lidra keeps Sidra's interface, sign-in, theming and integrations, and replaces the playback stack underneath them.

- **No Chromium DRM.** Stock Electron: no Widevine CDM, no EVS/VMP signing. The page's player is satisfied by a loopback HLS playlist instead of a protected CDN stream.
- **Quality comes from the master manifest**, not from what the web player is offered: hi-res ALAC (up to 24-bit/192 kHz), ALAC lossless, Dolby Atmos (E-AC-3), Dolby Audio (AC-3) and AAC. Lidra asks the Apple Music API for `extendedAssetUrls.enhancedHls` with the session you signed in with, ranks every rendition and plays the best one your preference allows.
- **Fragments are decrypted and muxed as they arrive.** Nothing waits for a full download: the player's manifest request is held only until the first two seconds exist, so pressing play starts audio in well under a second.
- **The page still owns playback.** Because Lidra answers the manifest request with its own playlist, the media element, transport, queue, scrubbing and player bar stay exactly as upstream — seeking included.
- **Decryption runs in the app**, driven by a key source you supply: a key service (socket or HTTP) or the wrapper decrypt socket described in [docs/AUDIO-PIPELINE.md](docs/AUDIO-PIPELINE.md).

Every track is verified after it resolves: the initialisation segment is in the
clear and states the real bit depth, sample rate, channel count and bitrate, so
Lidra checks the delivered stream against the tier it asked for and shows the
result in a badge (`ALAC 24-bit/192 kHz stereo`, `Dolby Digital Plus (Atmos) 48 kHz
6 channels 768 kbps`) instead of trusting the manifest. Live measurements and how
to reproduce them: [docs/QUALITY.md](docs/QUALITY.md) — 22 of 22 renditions across
hi-res, lossless, Atmos and AAC matched their claim.

| Source | Delivered as | Needs ffmpeg |
| --- | --- | --- |
| AAC-LC / HE-AAC | stream copy (fMP4) | no |
| ALAC lossless / hi-res | FLAC in fragmented MP4 (bit-exact) | yes |
| Dolby Atmos (E-AC-3) | 5.1 FLAC bed, or Apple's binaural render in stereo (`LIDRA_SPATIAL`) | yes |
| Dolby Audio (AC-3) | FLAC, 5.1 preserved | yes |

`ffmpeg-static` is bundled for Linux, macOS and Windows and unpacked next to the
app, so lossless and Dolby playback work on a machine with no ffmpeg installed.
`LIDRA_FFMPEG` still overrides it, and `PATH` is the last resort.

Configuration lives in the Audio section of Settings or the environment:

| Variable | Purpose |
| --- | --- |
| `LIDRA_AUDIO_ENABLED` | `0` disables the pipeline and leaves the page's own playback alone |
| `LIDRA_AUDIO_QUALITY` | `hi-res`, `lossless`, `atmos`, `dolby-audio`, `aac`, or `auto` |
| `LIDRA_KEY_SERVICE` | `host:port`, `unix:/path` or `http(s)://…` key service |
| `LIDRA_KEY_TRANSPORT` | `socket` (default) or `http` |
| `LIDRA_KEY_TOKEN` | bearer token for an HTTP key service |
| `LIDRA_DECRYPTOR` | wrapper decrypt socket; switches playback to remote decryption |
| `LIDRA_MANIFEST_SERVICE` | wrapper manifest socket, for masters the API omits |
| `LIDRA_FFMPEG` | explicit ffmpeg path |
| `LIDRA_SPATIAL` | `bed` (5.1 Atmos core, default) or `binaural` (Apple's spatial render in stereo) |
| `LIDRA_WIDEVINE_DEVICE` | `.wvd` file (or directory with `client_id.bin` + `private_key.pem`) for the built-in Widevine licence exchange |

Verify the pipeline against a live account (uses the signed-in session, prints
nothing sensitive):

```bash
npm run build
LIDRA_REPORT_MAX=10 npx electron test/e2e/quality-report.cjs "miles davis"
npm run test:multichannel   # 5.1 Atmos-shaped source through MSE, decoded by Chromium
```

### Legal

Lidra is intended as an alternative music playback client for users with
legitimate, active Apple Music subscriptions.

The project is not intended to provide unauthorized access to subscription
content, bypass payment requirements, distribute copyrighted audio, or facilitate
music piracy.

A valid subscription establishes legitimate access to a service but does not
necessarily authorize circumventing technological protection measures. Whether a
particular implementation constitutes lawful access, interoperability, or
prohibited DRM circumvention depends on its technical operation, Apple's
applicable agreements, and relevant law, including the Digital Millennium
Copyright Act (DMCA) and applicable exemptions.

The project prioritises authorized APIs, lawful interoperability, and playback
mechanisms that do not unlawfully circumvent technological protection measures.

Lidra bundles no key-extraction or DRM-circumvention tooling. Where it performs a
licence exchange, it does so with a CDM device credential **you** supply, against
the subscription **you** signed in with. Review any third-party key service or
wrapper you connect for licensing, security and legal compliance before use.

This disclaimer expresses the project's intended lawful use; it is not a
declaration that every decryption or playback technique is legally permissible.

## Features

- 🎧 Untouched audio — no `AudioContext`, DSP, or resampling of its own
- 🎨 Eight bundled themes plus a live-reloading custom colour theme
- 📊 Opt-in Last.fm scrobbling (browser approval)
- 🎮 Discord Rich Presence
- 🔔 Track and radio-song desktop notifications with playback controls
- 🌍 32 languages, Apple Music Classical support, gamepad navigation
- 🐧 Linux: MPRIS over D-Bus, Wayland + X11, tray indicator
- 🍏 macOS: Now Playing widget, Dock menu and progress, share sheet
- 🪟 Windows: GSMTC flyout, taskbar toolbar and progress
- 🔄 Auto-update on AppImage/Windows; release-page notifications elsewhere

## Releases

| Platform | Artefacts |
| --- | --- |
| Linux | AppImage, deb, rpm, Flatpak, Snap — x64 and arm64 |
| macOS | dmg — x64 on `macos-15-intel`, arm64 on `macos-15`, hardened runtime, no VMP signing |
| Windows | NSIS installer — x64 |

Builds run in CI from `.github/workflows/builder.yml` on tag `*.*.*`, with the
version gate requiring `package.json` to match the tag. Each platform bundles the
ffmpeg build for its own architecture; the macOS lanes build one architecture per
runner so the binary always matches.

Verified locally: the Linux x64 AppImage builds, launches, and resolves the bundled
ffmpeg from `app.asar.unpacked`. A Windows x64 packaging run got as far as the
NSIS installer and produced `win-unpacked/Lidra.exe` with the full resource tree;
it stops there only because wine on this machine lacks 32-bit support, which is
what the installer step needs. macOS cannot be packaged on Linux at all.

Because `ffmpeg-static` installs the *host* binary, every build now runs
`scripts/verify-packaged-ffmpeg.cjs` after packaging: it opens the bundled binary,
checks its magic bytes and file name against the target platform, and fails the
build if they disagree. Running the check against the local Windows cross-build
correctly rejects it — that package contains a Linux ELF binary, not `ffmpeg.exe`.

## Install

Grab the latest release from [GitHub Releases](https://github.com/evangit2/lidra/releases) — `Lidra-*` AppImage, `.deb`, `.rpm`, `.flatpak`, `.snap`, `.dmg`, and the Windows installer. No Snap Store release yet, so install the `.snap` file from there directly.

Unsigned macOS/Windows builds need the usual Gatekeeper/SmartScreen workaround on first launch.

## Develop

Requires Node (see `.nvmrc`).

```bash
npm ci
npm test      # unit tests; type-checks and packaging run in CI
just run      # builds and launches the app
```

Go deeper: [SPECIFICATION.md](docs/SPECIFICATION.md), [custom-theme.json](docs/custom-theme.json), [LASTFM-PRIVACY.md](docs/LASTFM-PRIVACY.md).

## Contributing

- Bugs and feature requests go in [Issues](https://github.com/evangit2/lidra/issues); pull requests welcome
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- Be kind: [Code of Conduct](CODE_OF_CONDUCT.md)
- Security issues stay private: [SECURITY.md](SECURITY.md)

## License

[Blue Oak Model License 1.0.0](LICENSE) — do almost anything, just keep this notice and don't sue over it.
