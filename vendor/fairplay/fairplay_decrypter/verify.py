"""Plaintext verification: prove the bytes before trusting them.

A wrong-arm or wedged service context returns noise that looks like a
successful decrypt (same lengths, no errors). Every download verifies the
first segment in source and the caller restarts + retries once on failure.

Checks are codec-structural, never "ffmpeg printed nothing":
- ec-3: every sampled frame starts with the 0x0b77 sync word.
- alac: the dominant first-4-byte header covers >90% of sampled frames.
- aac: frames are rewrapped as ADTS and decoded; output must be non-empty
  and error-free (silence with zero frames out is a failure, not a pass).
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

from . import mp4


def _sample_heads(pt: bytes, nbytes: int, want: int):
    samples = mp4.sample_layout(pt, 0)
    if not samples:
        raise ValueError("no samples parsed")
    heads = [pt[s["offset"]:s["offset"] + nbytes] for s in samples[:want]]
    return samples, Counter(heads), len(heads)


def check_ec3(pt: bytes) -> None:
    _, heads, n = _sample_heads(pt, 2, 60)
    top, cnt = heads.most_common(1)[0]
    if top != b"\x0bw" or cnt < 0.9 * n:
        raise ValueError(f"ec-3 sync missing (top={top.hex()} x{cnt}/{n})")


def check_alac(pt: bytes) -> None:
    _, heads, n = _sample_heads(pt, 4, 60)
    top, cnt = heads.most_common(1)[0]
    if cnt < 0.9 * n:
        raise ValueError(f"alac frame header unstable (top={top.hex()} x{cnt}/{n})")


def _adts(fr: bytes) -> bytes:
    ln = len(fr) + 7
    h = bytearray((0xFF, 0xF1, 0x50, 0x80, 0, 0, 0xFC))
    h[3] |= (ln >> 11) & 0x03
    h[4] = (ln >> 3) & 0xFF
    h[5] |= (ln & 0x07) << 5
    return bytes(h) + fr


def check_aac(pt: bytes) -> None:
    samples = mp4.sample_layout(pt, 0)
    if not samples:
        raise ValueError("no samples parsed")
    if shutil.which("ffmpeg") is None:
        # structural fallback: AAC-LC frames start 0x21 for stereo/48k
        _, heads, n = _sample_heads(pt, 1, 60)
        top, cnt = heads.most_common(1)[0]
        if top != b"\x21" or cnt < 0.9 * n:
            raise ValueError("aac frame headers missing")
        return
    raw = b"".join(_adts(pt[s["offset"]:s["offset"] + s["size"]]) for s in samples[:40])
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "p.aac"
        dst = Path(td) / "p.wav"
        src.write_bytes(raw)
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src),
                            "-acodec", "pcm_s16le", str(dst)],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise ValueError(f"aac decode errors: {r.stderr.decode()[:200]}")
        if dst.stat().st_size < 10000:
            raise ValueError("aac decoded zero audio (wedged context?)")


def check(pt: bytes, codecs: str) -> None:
    c = codecs.split(",")[0]
    if c == "ec-3":
        return check_ec3(pt)
    if c == "alac":
        return check_alac(pt)
    if c.startswith("mp4a"):
        return check_aac(pt)
    raise ValueError(f"no verifier for codecs {codecs!r}")
