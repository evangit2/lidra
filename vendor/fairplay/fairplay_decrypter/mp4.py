"""MP4 box walk, init-segment protection defaults, fragment sample layout.

Source-only port of the CENC layout logic (ISO/IEC 23001-7 ``senc`` order:
IV first, then the subsample table; IV length comes from ``tenc``).

Only metadata is ever returned. Callers keep media bytes in memory.
"""

from __future__ import annotations

import struct


def read_boxes(buf: bytes, start: int, end: int):
    """Yield (type, box_start, payload_off, box_end) for top-level boxes."""
    out = []
    off = start
    while off + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, off)
        typ = typ.decode("latin1")
        header = 8
        if size == 1:
            if off + 16 > end:
                break
            size = struct.unpack_from(">Q", buf, off + 8)[0]
            header = 16
        elif size == 0:
            size = end - off
        if size < header or off + size > end:
            break
        payload = off + header
        if typ == "uuid":
            payload += 16
        out.append((typ, off, payload, off + size))
        off += size
    return out


def _children(buf: bytes, payload: int, end: int):
    return read_boxes(buf, payload, end)


def _find(children, typ):
    for c in children:
        if c[0] == typ:
            return c
    return None


def parse_tenc(buf: bytes) -> dict:
    """Return protection defaults from the init segment.

    Result: is_protected, default_iv_size, constant_iv (or None),
    crypt_byte_block, skip_byte_block, codec.
    """
    top = read_boxes(buf, 0, len(buf))
    moov = _find(top, "moov")
    if not moov:
        raise ValueError("no moov in init segment")
    for trak in [c for c in _children(buf, moov[2], moov[3]) if c[0] == "trak"]:
        mdia = _find(_children(buf, trak[2], trak[3]), "mdia")
        if not mdia:
            continue
        minf = _find(_children(buf, mdia[2], mdia[3]), "minf")
        if not minf:
            continue
        stbl = _find(_children(buf, minf[2], minf[3]), "stbl")
        if not stbl:
            continue
        stsd = _find(_children(buf, stbl[2], stbl[3]), "stsd")
        if not stsd:
            continue
        entries = read_boxes(buf, stsd[2] + 8, stsd[3])
        for entry in entries:
            if entry[0] not in ("enca", "encv", "enac"):
                continue
            sinf = _find(_children(buf, entry[2] + 28, entry[3]), "sinf")
            if not sinf:
                continue
            kids = _children(buf, sinf[2], sinf[3])
            frma = _find(kids, "frma")
            schi = _find(kids, "schi")
            if not schi:
                continue
            tenc = _find(_children(buf, schi[2], schi[3]), "tenc")
            if not tenc:
                continue
            p = tenc[2]
            # tenc: FullBox(4), crypt(1), skip(1), is_protected(1),
            # iv_size(1), kid(16), [iv_len(1) + iv] when protected and
            # iv_size == 0. Consumed exactly; misaligned guesses are skipped.
            ver_flags = struct.unpack_from(">I", buf, p)[0]
            p += 4
            crypt = buf[p]
            p += 1
            skip = buf[p]
            p += 1
            is_protected = buf[p]
            p += 1
            iv_size = buf[p]
            p += 1
            kid = buf[p:p + 16]
            p += 16
            const_iv = None
            if is_protected and iv_size == 0 and p < tenc[3]:
                iv_len = buf[p]
                p += 1
                const_iv = bytes(buf[p:p + iv_len])
                p += iv_len
            if p != tenc[3]:
                continue
            return {
                "tenc_version": ver_flags >> 24,
                "is_protected": is_protected,
                "default_iv_size": iv_size,
                "constant_iv": const_iv,
                "crypt_byte_block": crypt,
                "skip_byte_block": skip,
                "default_kid": kid,
                "codec": frma and buf[frma[2]:frma[2] + 4].decode("latin1"),
            }
    raise ValueError("no enca/encv entry with tenc found")


def sample_layout(segment: bytes, per_sample_iv_size: int = 0):
    """Return list of dicts: offset, size, iv (or None), subsamples list.

    tfhd base + trun sizes; senc entries are IV first then subsample table;
    an senc entry count matching the sample count is consumed (Apple repeats
    it; ISO does not). Raises ValueError on truncation so callers never send
    short spans (a short send hangs the service).
    """
    samples = []
    for moof in [b for b in read_boxes(segment, 0, len(segment)) if b[0] == "moof"]:
        for traf in [b for b in _children(segment, moof[2], moof[3]) if b[0] == "traf"]:
            kids = _children(segment, traf[2], traf[3])
            tfhd = _find(kids, "tfhd")
            trun = _find(kids, "trun")
            senc = _find(kids, "senc")
            if not tfhd or not trun:
                continue
            tfhd_flags = struct.unpack_from(">I", segment, tfhd[2])[0] & 0xFFFFFF
            cur = tfhd[2] + 4
            _track = struct.unpack_from(">I", segment, cur)[0]
            cur += 4
            base = moof[1]
            if tfhd_flags & 0x000001:
                base = struct.unpack_from(">Q", segment, cur)[0]
                cur += 8
            if tfhd_flags & 0x000002:
                cur += 4
            if tfhd_flags & 0x000008:
                cur += 4
            default_size = 0
            if tfhd_flags & 0x000010:
                default_size = struct.unpack_from(">I", segment, cur)[0]
                cur += 4
            if tfhd_flags & 0x000020:
                cur += 4
            trun_flags = struct.unpack_from(">I", segment, trun[2])[0] & 0xFFFFFF
            tc = trun[2] + 4
            count = struct.unpack_from(">I", segment, tc)[0]
            tc += 4
            data_offset = 0
            if trun_flags & 0x000001:
                data_offset = struct.unpack_from(">i", segment, tc)[0]
                tc += 4
            if trun_flags & 0x000004:
                tc += 4
            senc_cur = senc[2] + 4 if senc else 0
            senc_flags = (struct.unpack_from(">I", segment, senc[2])[0] & 0xFFFFFF) if senc else 0
            if senc and senc_cur + 4 <= len(segment):
                if struct.unpack_from(">I", segment, senc_cur)[0] == count:
                    senc_cur += 4
            off = base + data_offset
            for _i in range(count):
                size = default_size
                if trun_flags & 0x000100:
                    tc += 4
                if trun_flags & 0x000200:
                    size = struct.unpack_from(">I", segment, tc)[0]
                    tc += 4
                if trun_flags & 0x000400:
                    tc += 4
                if trun_flags & 0x000800:
                    tc += 4
                iv = None
                subs = None
                if senc:
                    if per_sample_iv_size > 0:
                        iv = segment[senc_cur:senc_cur + per_sample_iv_size]
                        senc_cur += per_sample_iv_size
                    if senc_flags & 0x000002:
                        nsub = struct.unpack_from(">H", segment, senc_cur)[0]
                        senc_cur += 2
                        if nsub:
                            subs = []
                            for _e in range(nsub):
                                clear = struct.unpack_from(">H", segment, senc_cur)[0]
                                prot = struct.unpack_from(">I", segment, senc_cur + 2)[0]
                                senc_cur += 6
                                subs.append((clear, prot))
                if size <= 0:
                    raise ValueError("trun declared a zero-sized sample")
                if off < 0 or off + size > len(segment):
                    raise ValueError("sample span outside fragment")
                samples.append({"offset": off, "size": size, "iv": iv, "subsamples": subs})
                off += size
    return samples
