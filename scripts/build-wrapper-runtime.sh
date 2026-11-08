#!/bin/bash
# Build the wrapper files shipped inside the Windows installer.
#
# Those files are the Android/Linux FairPlay client the wrapper chroots into. The
# account database (rootfs/data) is deliberately left out: it holds MUSIC_TOKEN,
# cookies and the account link for whoever built the payload.
set -euo pipefail

SOURCE=${1:-$HOME/.lidra-wrapper/extracted}
OUT=${2:-build/wrapper}
STAGE=$(mktemp -d)

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

[ -x "$SOURCE/wrapper" ] || { echo "no wrapper at $SOURCE/wrapper" >&2; exit 1; }
[ -d "$SOURCE/rootfs/system" ] || { echo "no rootfs at $SOURCE/rootfs/system" >&2; exit 1; }

install -m 0755 "$SOURCE/wrapper" "$STAGE/wrapper"
mkdir -p "$STAGE/rootfs"
cp -a "$SOURCE/rootfs/system" "$STAGE/rootfs/system"
# The wrapper creates these at start-up; they must exist and be empty.
mkdir -p "$STAGE/rootfs/dev" "$STAGE/rootfs/proc"
mkdir -p "$STAGE/rootfs/data/data/com.apple.android.music/files"

# Refuse to ship anyone's session if the source tree ever grows one back.
if [ -n "$(find "$STAGE/rootfs/data" -type f -print -quit)" ]; then
  echo "refusing to package account data from $SOURCE/rootfs/data" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT/wrapper-rootfs.tar.gz"
tar -C "$STAGE" -czf "$OUT/wrapper-rootfs.tar.gz" .
ls -la "$OUT/wrapper-rootfs.tar.gz" | awk '{print "payload:", $5, "bytes"}'
