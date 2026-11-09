#!/bin/bash
# Build the wrapper files shipped inside the Windows installer.
#
# Those files are the Android/Linux FairPlay client the wrapper chroots into,
# laid out as the root of the Linux environment Lidra imports on first run:
#
#   /bin/busybox, /bin/sh      a shell, because the imported root is otherwise empty
#   /lib64, /lib/x86_64-linux-gnu  the loader and libc the launcher links against
#   /opt/lidra/wrapper         the launcher
#   /opt/lidra/rootfs/system   the Android userspace it runs
#
# The account database (rootfs/data) is deliberately left out: it holds
# MUSIC_TOKEN, cookies and the account link for whoever built it.
set -euo pipefail

SOURCE=${1:-$HOME/.lidra-wrapper/extracted}
OUT=${2:-build/wrapper}
STAGE=$(mktemp -d)

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

[ -x "$SOURCE/wrapper" ] || { echo "no wrapper at $SOURCE/wrapper" >&2; exit 1; }
[ -d "$SOURCE/rootfs/system" ] || { echo "no rootfs at $SOURCE/rootfs/system" >&2; exit 1; }
command -v busybox >/dev/null || { echo "busybox is required for the shell" >&2; exit 1; }
file "$(command -v busybox)" | grep -q "statically linked" || {
  echo "busybox must be static: install busybox-static" >&2
  exit 1
}

install -d "$STAGE/bin" "$STAGE/opt/lidra" "$STAGE/etc" "$STAGE/root"
# An imported root needs an account database: without /etc/passwd WSL cannot
# resolve `-u root`, and every launch fails with WSL_E_USER_NOT_FOUND.
printf 'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/bin/false\n' > "$STAGE/etc/passwd"
printf 'root:x:0:\nnogroup:x:65534:\n' > "$STAGE/etc/group"
printf '127.0.0.1\tlocalhost\n' > "$STAGE/etc/hosts"
install -m 0755 "$(command -v busybox)" "$STAGE/bin/busybox"
ln -sf busybox "$STAGE/bin/sh"

install -m 0755 "$SOURCE/wrapper" "$STAGE/opt/lidra/wrapper"
# The launcher is a dynamically linked glibc binary and the imported root is
# otherwise empty, so its loader and libc travel with it. It needs no symbol
# newer than GLIBC_2.34.
LOADER=$(ldd "$SOURCE/wrapper" | awk '/ld-linux/ {print $1}' | head -1)
LIBC=$(ldd "$SOURCE/wrapper" | awk '/libc\.so\.6/ {print $3}' | head -1)
[ -x "$LOADER" ] && [ -f "$LIBC" ] || { echo "cannot resolve the launcher's loader/libc" >&2; exit 1; }
install -D -m 0755 "$LOADER" "$STAGE/lib64/$(basename "$LOADER")"
install -D -m 0755 "$LIBC" "$STAGE/lib/x86_64-linux-gnu/$(basename "$LIBC")"
[ -f /usr/share/doc/libc6/copyright ] && install -D -m 0644 /usr/share/doc/libc6/copyright \
  "$STAGE/usr/share/doc/libc6/copyright"
install -d "$STAGE/opt/lidra/rootfs"
cp -a "$SOURCE/rootfs/system" "$STAGE/opt/lidra/rootfs/system"
# The wrapper creates these at start-up; they must exist and be empty.
install -d "$STAGE/opt/lidra/rootfs/dev" "$STAGE/opt/lidra/rootfs/proc"
install -d "$STAGE/opt/lidra/rootfs/data/data/com.apple.android.music/files"

# Refuse to ship anyone's session if the source tree ever grows one back.
if [ -n "$(find "$STAGE/opt/lidra/rootfs/data" -type f -print -quit)" ]; then
  echo "refusing to package account data from $SOURCE/rootfs/data" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT/wrapper-rootfs.tar.gz"
tar -C "$STAGE" -czf "$OUT/wrapper-rootfs.tar.gz" --owner=0 --group=0 .
ls -la "$OUT/wrapper-rootfs.tar.gz" | awk '{print "runtime archive:", $5, "bytes"}'
tar tzf "$OUT/wrapper-rootfs.tar.gz" | head -6 || true
