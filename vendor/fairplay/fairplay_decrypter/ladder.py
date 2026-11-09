"""Quality-tier ladder parsed from the master playlist.

Tier ids come from rendition filenames (``gr256_mp4a-40-2`` -> ``aac256``)
with a codec+bandwidth fallback for future names.
"""

from __future__ import annotations

import re
from urllib.parse import urljoin

from . import wire

CODECS = {"mp4a.40.2": "AAC-LC", "mp4a.40.5": "HE-AAC", "alac": "ALAC", "ec-3": "Atmos"}

KNOWN = [
    ("gr9216_alac", "hirez192", "ALAC 192kHz/24-bit"),
    ("gr2304_alac", "alac48", "ALAC 48kHz/24-bit"),
    ("gr2768_mp4a-A6", "atmos768", "Atmos 768kbps"),
    ("gr2448_mp4a-A6", "atmos448", "Atmos 448kbps"),
    ("gr256_mp4a-40-2", "aac256", "AAC 256kbps"),
    ("gr128_mp4a-40-2", "aac128", "AAC 128kbps"),
    ("gr64_mp4a-40-2", "heaac64", "HE-AAC 64kbps"),
]


def _tier_id(filename: str, codecs: str, bw: int) -> tuple[str, str]:
    for needle, tid, label in KNOWN:
        if needle in filename:
            suffix = ""
            if filename.endswith(("_bm.m3u8", "_dm.m3u8")):
                suffix = " (binaural)" if "_bm" in filename else " (downmix)"
                tid += "-bm" if "_bm" in filename else "-dm"
            return tid, label + suffix
    codec = CODECS.get(codecs.split(",")[0], codecs)
    return filename, f"{codec} {bw // 1000}kbps"


def ladder(adam: str, manifest_port: int) -> list[dict]:
    """Return [{id, label, codecs, bandwidth, playlist}] for the song."""
    master = wire.manifest_master(adam, manifest_port)
    text = wire.fetch(master).decode()
    base = master.rsplit("/", 1)[0] + "/"
    tiers = []
    for m in re.finditer(r"#EXT-X-STREAM-INF:([^\n]*)\n(\S+\.m3u8)", text):
        attrs, fn = m.group(1), m.group(2)
        bw = int(re.search(r"BANDWIDTH=(\d+)", attrs).group(1))
        cm = re.search(r'CODECS="([^"]+)"', attrs)
        codecs = cm.group(1) if cm else ""
        tid, label = _tier_id(fn, codecs, bw)
        tiers.append({"id": tid, "label": label, "codecs": codecs,
                      "bandwidth": bw, "playlist": urljoin(base, fn)})
    tiers.sort(key=lambda t: -t["bandwidth"])
    return tiers


def describe(adam: str, manifest_port: int) -> str:
    lines = []
    for t in ladder(adam, manifest_port):
        lines.append(f'{t["id"]:12s} {t["label"]:24s} {t["bandwidth"] // 1000:5d} kbps')
    return "\n".join(lines)
