#!/bin/bash
# Build the Linux environment Lidra imports on Windows.
#
# The environment is a real Alpine minirootfs with the wrapper dropped into
# /opt/lidra. Hand-rolling a root from just a shell and the wrapper was not
# enough: WSL needs a normal userland (mount, /etc/passwd, a working /bin/sh) or
# every command fails before it starts.
#
# Usage: scripts/build-wsl-rootfs.sh [output.tar.gz]
set -euo pipefail

OUT=${1:-build/wrapper-tar/wrapper-rootfs.tar.gz}
VERSION=${ALPINE_VERSION:-3.20}
RELEASE=${ALPINE_RELEASE:-3.20.3}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "fetching alpine-minirootfs $RELEASE"
curl -fsSL -o "$WORK/alpine.tar.gz" \
  "https://dl-cdn.alpinelinux.org/alpine/v${VERSION}/releases/x86_64/alpine-minirootfs-${RELEASE}-x86_64.tar.gz"

mkdir -p "$WORK/root"
tar xzf "$WORK/alpine.tar.gz" -C "$WORK/root"

# WSL should not touch the Windows drives or the Windows PATH inside this
# environment; it exists to run one program.
cat > "$WORK/root/etc/wsl.conf" <<'EOF'
[automount]
enabled=false

[interop]
enabled=false
appendWindowsPath=false

[boot]
systemd=false
EOF

# The wrapper plus the Android image it chroots into, and the loader and libc
# its binary was linked against (Alpine is musl, so these ship alongside).
mkdir -p "$WORK/root/opt"
cp -a "$ROOT/vendor/wrapper/opt/lidra" "$WORK/root/opt/lidra"
install -D -m 0755 "$ROOT/vendor/wrapper/lib64/ld-linux-x86-64.so.2" \
  "$WORK/root/lib64/ld-linux-x86-64.so.2"
install -D -m 0755 "$ROOT/vendor/wrapper/lib/x86_64-linux-gnu/libc.so.6" \
  "$WORK/root/lib/x86_64-linux-gnu/libc.so.6"

# Logins run as root; Alpine already ships the account, and the wrapper needs
# /root to exist as a home directory.
mkdir -p "$WORK/root/root"
chmod 755 "$WORK/root/opt/lidra/wrapper"

mkdir -p "$(dirname "$OUT")"
tar czf "$OUT" -C "$WORK/root" .
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
