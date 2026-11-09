"""Wire clients for the local FairPlay runtime.

Manifest port: binary-framed ``[len]adamId`` -> master .m3u8 URL; media
playlists are plain HTTPS. Decrypt port: select (arm) + per-sample
``u32le(n) + n bytes`` round trips. Key port: one-shot license blobs.
"""

from __future__ import annotations

import json
import re
import socket
import struct
import urllib.parse
import urllib.request
from urllib.parse import urljoin

UA = {"User-Agent": "fairplay_decrypter/0.1.0"}


def wire_string(value: str) -> bytes:
    raw = value.encode()
    return bytes([len(raw)]) + raw


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    out = bytearray()
    while len(out) < n:
        part = sock.recv(n - len(out))
        if not part:
            raise ConnectionError("service closed mid-response")
        out.extend(part)
    return bytes(out)


def manifest_master(adam: str, manifest_port: int, timeout: int = 15) -> str:
    """Return the master .m3u8 URL for an adamId (newline-terminated)."""
    with socket.create_connection(("127.0.0.1", manifest_port), timeout=timeout) as s:
        s.sendall(wire_string(adam))
        raw = bytearray()
        while len(raw) < 4096:
            part = s.recv(4096 - len(raw))
            if not part:
                break
            raw.extend(part)
            if b"\n" in raw:
                break
    master = bytes(raw).decode().strip()
    if not master.startswith("https://"):
        raise ValueError("manifest service did not return a URL")
    return master


def fetch(url: str, span=None, timeout: int = 30) -> bytes:
    """HTTPS GET, optionally ``span=(offset, length)`` via Range."""
    req = urllib.request.Request(url, headers=UA)
    if span:
        off, length = span
        req.add_header("Range", f"bytes={off}-{off + length - 1}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def rendition_url(master: str, needle: str) -> str:
    """Pick a rendition playlist URL from the master by filename match."""
    text = fetch(master).decode()
    cands = re.findall(r'(?:URI=")?([^\s"=,]+\.m3u8(?:\?[^\s"]*)?)', text)
    hits = [u for u in cands if needle in u]
    if not hits:
        raise ValueError(f"rendition {needle!r} unavailable")
    return urljoin(master, hits[0])


def media_entries(media_text: str, media_url: str):
    """Return {"init": (url, span_or_None), "segments": [(url, (off, len), key)]}."""
    lines = media_text.splitlines()
    base = media_url.rsplit("/", 1)[0] + "/"
    curkey = None
    resource = None
    init = None
    segments = []
    pending_span = None
    for line in lines:
        if line.startswith("#EXT-X-KEY"):
            m = re.search(r'URI="([^"]+)"', line)
            curkey = m.group(1) if m else None
        elif line.startswith("#EXT-X-MAP"):
            m = re.search(r'URI="([^"]+)"', line)
            assert m, "MAP line without URI"
            m2 = re.search(r'BYTERANGE="(\d+)@(\d+)"', line)
            init = (urljoin(base, m.group(1)),
                    (int(m2.group(2)), int(m2.group(1))) if m2 else None)
            resource = init[0]
        elif line.startswith("#EXT-X-BYTERANGE:"):
            m = re.match(r"#EXT-X-BYTERANGE:(\d+)@(\d+)", line)
            assert m, "bad BYTERANGE line"
            pending_span = (int(m.group(2)), int(m.group(1)))
        elif line and not line.startswith("#"):
            if pending_span and resource:
                segments.append((urljoin(base, line.strip()), pending_span, curkey))
                pending_span = None
    return {"init": init, "segments": segments}


class Decryptor:
    """One decrypt-port connection: arm once, then per-sample round trips."""

    def __init__(self, port: int, timeout: int = 60):
        self.port = port
        self.timeout = timeout
        self.sock: socket.socket | None = None

    def __enter__(self):
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=self.timeout)
        self.sock.settimeout(self.timeout)
        return self

    def __exit__(self, *exc):
        assert self.sock is not None
        try:
            self.sock.sendall(b"\0" * 4 + bytes([0]))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
        self.sock = None
        return False

    def arm(self, adam: str, uri: str, switch: bool):
        """Select a key context. ``switch`` only when re-arming a live
        connection (placeholder -> real key); never on a fresh one."""
        assert self.sock is not None
        if switch:
            self.sock.sendall(b"\0" * 4)
        self.sock.sendall(wire_string(adam) + wire_string(uri))

    def decrypt_run(self, data: bytes) -> bytes:
        """Decrypt one byte run; trailing partial block stays clear."""
        assert self.sock is not None
        usable = len(data) & ~15
        if not usable:
            raise ValueError("run too short")
        self.sock.sendall(struct.pack("<I", usable) + data[:usable])
        return _recv_exact(self.sock, usable)


def fetch_key(adam: str, uri: str, key_port: int, timeout: int = 20) -> dict:
    """GET /?adamId=..&uri=.. -> license blob dict (base64 fields)."""
    qs = urllib.parse.urlencode({"adamId": adam, "uri": uri})
    req = f"GET /?{qs} HTTP/1.0\r\n\r\n".encode()
    with socket.create_connection(("127.0.0.1", key_port), timeout=timeout) as s:
        s.sendall(req)
        out = bytearray()
        while True:
            part = s.recv(65536)
            if not part:
                break
            out.extend(part)
            if len(out) > 4_000_000:
                raise ValueError("key response too large")
    body = bytes(out).split(b"\r\n\r\n", 1)[1]
    return json.loads(body)
