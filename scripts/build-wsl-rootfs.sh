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

OUT=${1:-build/fairplay-tar/fairplay-rootfs.tar.gz}
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
cp -a "$ROOT/vendor/fairplay-runtime/opt/lidra" "$WORK/root/opt/lidra"
mkdir -p "$WORK/root/lib64" "$WORK/root/lib/x86_64-linux-gnu"
cp "$ROOT/vendor/fairplay-runtime/lib64/ld-linux-x86-64.so.2" "$WORK/root/lib64/ld-linux-x86-64.so.2"
cp "$ROOT/vendor/fairplay-runtime/lib/x86_64-linux-gnu/libc.so.6" "$WORK/root/lib/x86_64-linux-gnu/libc.so.6"
chmod 755 "$WORK/root/lib64/ld-linux-x86-64.so.2" "$WORK/root/lib/x86_64-linux-gnu/libc.so.6"

# Python for the vendored fairplay-decrypter backend. Alpine minirootfs ships
# none, and apk needs a live system, so resolve exact .apk files from APKINDEX
# and unpack them (an .apk is a gzip tarball; .PKGINFO/.SIGN are harmless).
# Only the libraries the backend's stdlib use needs: TLS (urllib to Apple),
# zlib (zipfile), expat, ffi.
echo "fetching APKINDEX for python3"
curl -fsSL -o "$WORK/APKINDEX.tar.gz" \
  "https://dl-cdn.alpinelinux.org/alpine/v${VERSION}/main/x86_64/APKINDEX.tar.gz"
mkdir -p "$WORK/apkindex" && tar xzf "$WORK/APKINDEX.tar.gz" -C "$WORK/apkindex"
apk_file() {
  local pkg="$1" ver
  ver=$(grep -A1 "^P:${pkg}$" "$WORK/apkindex/APKINDEX" | grep "^V:" | head -n1 | cut -d: -f2)
  if [ -z "$ver" ]; then echo "APKINDEX has no $pkg" >&2; exit 1; fi
  echo "${pkg}-${ver}.apk"
}
mkdir -p "$WORK/apk"
for pkg in python3 libssl3 libcrypto3 zlib libexpat libffi; do
  file=$(apk_file "$pkg") || exit 1
  echo "fetching $file"
  curl -fsSL -o "$WORK/apk/$file" \
    "https://dl-cdn.alpinelinux.org/alpine/v${VERSION}/main/x86_64/$file"
  tar xzf "$WORK/apk/$file" -C "$WORK/root" --exclude='.PKGINFO' --exclude='.SIGN.*'
done

# The vendored backend supervises the service from inside the distro.
mkdir -p "$WORK/root/opt/lidra/fairplay"
cp -a "$ROOT/vendor/fairplay/fairplay_decrypter" "$WORK/root/opt/lidra/fairplay/fairplay_decrypter"
mkdir -p "$WORK/root/opt/python"
ln -sfn /usr/bin/python3 "$WORK/root/opt/python/python3"

# Logins run as root; Alpine already ships the account, and the wrapper needs
# /root to exist as a home directory.
mkdir -p "$WORK/root/root"
chmod 755 "$WORK/root/opt/lidra/wrapper"
# The wrapper writes into its own rootfs at startup (`mkdir ./rootfs/dev`) and
# stops if it cannot. Ship the directories it expects, owned by root.
mkdir -p "$WORK/root/opt/lidra/rootfs/dev" "$WORK/root/opt/lidra/rootfs/proc" "$WORK/root/opt/lidra/rootfs/tmp"
chmod 1777 "$WORK/root/opt/lidra/rootfs/tmp"
chmod 755 "$WORK/root/opt/lidra/rootfs/dev" "$WORK/root/opt/lidra/rootfs/proc"
# The wrapper opens rootfs/dev/urandom and dies with Permission denied
# without it. WSL1 cannot create device nodes, so bake the real ones here —
# the service runs from this image in place.
if ! sudo -n true 2>/dev/null; then
  echo "need passwordless sudo (mknod for the runtime device nodes)" >&2
  exit 1
fi
sudo -n mknod -m 666 "$WORK/root/opt/lidra/rootfs/dev/null" c 1 3
sudo -n mknod -m 666 "$WORK/root/opt/lidra/rootfs/dev/zero" c 1 5
sudo -n mknod -m 666 "$WORK/root/opt/lidra/rootfs/dev/random" c 1 8
sudo -n mknod -m 666 "$WORK/root/opt/lidra/rootfs/dev/urandom" c 1 9

mkdir -p "$(dirname "$OUT")"
tar czf "$OUT" -C "$WORK/root" .
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
