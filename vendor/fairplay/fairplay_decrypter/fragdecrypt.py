"""Fragment decryptor: CENC spans parsed in source, key contexts come
from the local FairPlay runtime over its decrypt port.

The service is a byte pipe: it decrypts exactly what it is sent (CBC
chained from the armed key context, cbcs/clear skipping applied
service-side from the tenc it already knows). Callers must therefore send
one whole SAMPLE per call -- never the whole fragment (headers would be
mangled) and never sub-block runs (chaining would break). Responses arrive
strictly in order.
"""

from __future__ import annotations

import struct
from concurrent.futures import ThreadPoolExecutor

from . import mp4
from . import wire


def _batch_decrypt(job: tuple[int, list[tuple[int, int]], bytes, str, str, int]
                   ) -> tuple[int, bytes]:
    index, spans, segment, adam, uri, port = job
    out = bytearray()
    with wire.Decryptor(port) as dec:
        dec.arm(adam, uri, False)
        assert dec.sock is not None
        for off, ln in spans:
            dec.sock.sendall(struct.pack("<I", ln) + segment[off:off + ln])
        for _off, ln in spans:
            out.extend(wire._recv_exact(dec.sock, ln))
    return index, bytes(out)


def decrypt_fragment(segment: bytes, adam: str, uri: str, port: int,
                     per_sample_iv_size: int = 0, batch: int = 64,
                     workers: int = 4) -> bytes:
    """Decrypt one fMP4 fragment; return full plaintext fragment bytes.

    Samples are split into fresh-arm batches (a whole large fragment on one
    connection stalls the service) spread over ``workers`` connections.
    """
    samples = mp4.sample_layout(segment, per_sample_iv_size)
    if not samples:
        raise ValueError("no samples parsed")
    spans = [(s["offset"], s["size"] & ~15) for s in samples]
    spans = [(o, ln) for o, ln in spans if ln]
    chunks = [spans[i:i + batch] for i in range(0, len(spans), batch)]
    out = bytearray(segment)
    jobs = [(i, ch, segment, adam, uri, port) for i, ch in enumerate(chunks)]
    with ThreadPoolExecutor(max_workers=min(workers, len(jobs))) as pool:
        for index, pt in pool.map(_batch_decrypt, jobs):
            # responses arrive in chunk order; slice sequentially
            cursor = 0
            for off, ln in chunks[index]:
                out[off:off + ln] = pt[cursor:cursor + ln]
                cursor += ln
    return bytes(out)
