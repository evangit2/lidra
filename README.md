<h1 align="center">
  <img src="build/icon.png" width="128" height="128" alt="Lidra">
  <br />
  Lidra
</h1>

<p align="center"><b>Apple Music as a proper desktop app for Linux, macOS and Windows.</b></p>

<p align="center">Made with 💝 for 🐧🍏🪟</p>

Lidra wraps `music.apple.com` directly: Apple owns the interface and keeps it current, while Lidra wires it into each platform's native media subsystem (media keys, MPRIS, Now Playing, taskbar controls) instead of bolting on a custom player. An Apple Music subscription is required for playback.

> **Fork note:** Lidra is a fork of [wimpysworld/sidra](https://github.com/wimpysworld/sidra) (Blue Oak 1.0.0, © Martin Wimpress). UI, theming, and sign-in flow are unchanged from upstream; audio stays as licensed in-app playback — no download pipeline.

<p align="center">
  <a href="assets/sidra-screenshot.png"><img src="assets/sidra-screenshot.png" alt="Lidra playing music with Settings open" width="100%"></a>
</p>

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
