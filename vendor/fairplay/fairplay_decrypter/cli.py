"""fairplay_decrypter CLI: login, ladder, dl, stream, status, doctor."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile

from . import __version__, config, ladder as ladder_mod, login as login_mod, service
from . import fragdecrypt, libs, verify, wire


def _ports():
    return config.ports()


def cmd_login(args) -> int:
    ok = login_mod.login(args.user, args.password, fresh=args.fresh)
    return 0 if ok else 1


def cmd_status(args) -> int:
    import json
    inst = config.service_dir()
    tok = config.music_token()
    state = {
        "service": "running" if service.is_running() else "stopped",
        "install": str(inst) if inst else None,
        "session": "signed in" if tok else "not signed in",
        "storefront": config.storefront(),
        "device": str(config.device_base()),
    }
    if args.json:
        print(json.dumps(state))
        return 0
    print(f"service: {state['service']}")
    inst = config.service_dir()
    print(f"install: {inst if inst else 'not set up (run: fairplay-decrypt setup)'}")
    tok = config.music_token()
    print(f"session: {'signed in' if tok else 'not signed in'}", end="")
    if tok:
        print(f" (storefront {config.storefront()})", end="")
    print()
    print(f"device: {config.device_base()}")
    return 0


def cmd_doctor(_args) -> int:
    ok = True

    def check(name, good, hint=""):
        nonlocal ok
        print(("ok  " if good else "FAIL") + f" {name}" + ("" if good else f" -- {hint}"))
        ok = ok and good

    inst = config.service_dir()
    check("service install", inst is not None, "run: fairplay-decrypt setup")
    if inst is not None:
        check(f"libs ({len(libs.sizes(inst))}/{len(libs.LIB_NAMES)})",
              len(libs.sizes(inst)) == len(libs.LIB_NAMES), "re-run: fairplay-decrypt setup --force")
        check("runtime executable", libs.executable(inst), "re-run: fairplay-decrypt setup --force")
    check("ffmpeg", shutil.which("ffmpeg") is not None, "install ffmpeg for remux/decode checks")
    r = subprocess.run(["sudo", "-n", "true"], capture_output=True)
    check("passwordless sudo (service mounts)", r.returncode == 0, "add a sudoers NOPASSWD rule")
    check("signed in", config.music_token() is not None, "run: fairplay-decrypt login")
    return 0 if ok else 1


def cmd_setup(args) -> int:
    from pathlib import Path

    dest = libs.install_dir(config.data_dir())
    explicit = bool(args.from_ or args.url)
    if libs.is_install(dest) and not (args.force or explicit):
        config.set_service_dir(dest)
        print(libs.describe(dest))
        return 0
    force = args.force or (explicit and libs.is_install(dest))

    src = Path(args.from_).expanduser() if args.from_ else None
    if src is None and not args.url:
        found = libs.find_installs()
        src = found[0] if found else None
    if src is not None and not libs.is_install(src):
        print(f"not a service install: {src}")
        print("missing: " + ", ".join(libs.missing(src)))
        return 1

    try:
        if src is not None:
            print(f"staging from {src}")
            gone = libs.stage(src, dest, force=force)
        else:
            url = args.url or config.runtime_url()
            print("no local runtime found; downloading prebuilt runtime"
                  + (f" from {url}" if url else " (~47 MB)") + "...")
            gone = libs.fetch(dest, url=url, force=force)
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        print(f"setup failed: {e}")
        return 1
    if args.url:
        config.set_runtime_url(args.url)
    if gone:
        print("staged copy is incomplete:")
        print("missing: " + ", ".join(gone))
        return 1
    config.set_service_dir(dest)
    print(libs.describe(dest))
    print("\nnext: fairplay-decrypt login")
    return 0


def _pick_tier(adam: str, want: str | None):
    tiers = ladder_mod.ladder(adam, _ports()["manifest"])
    if want:
        for t in tiers:
            if t["id"] == want:
                return t
        raise SystemExit(f"unknown tier {want!r} (see: fairplay_decrypter ladder {adam})")
    return tiers[0]


def cmd_ladder(args) -> int:
    import json
    tiers = ladder_mod.ladder(args.adam, _ports()["manifest"])
    if args.json:
        print(json.dumps(tiers))
    else:
        for t in tiers:
            print(f'{t["id"]:12s} {t["label"]:24s} {t["bandwidth"] // 1000:5d} kbps')
    return 0


def _segments(tier: dict, seg: str):
    text = wire.fetch(tier["playlist"]).decode()
    entries = wire.media_entries(text, tier["playlist"])
    segs = entries["segments"]
    if seg == "all":
        return entries["init"], segs
    try:
        i = int(seg)
        return entries["init"], [segs[i]]
    except (ValueError, IndexError):
        raise SystemExit(f"bad segment {seg!r} (0..{len(segs) - 1} or 'all')")


def _download(adam: str, tier: dict, segs, workers: int, log=print):
    """Fetch + decrypt each segment with its own playlist key URI."""
    p = _ports()
    blobs = []
    external = bool(os.environ.get("FPDECRYPT_EXTERNAL"))
    for n, (url, span, key_uri) in enumerate(segs):
        ct = wire.fetch(url, span)
        attempt = 0
        while True:
            pt = fragdecrypt.decrypt_fragment(ct, adam, key_uri, p["decrypt"], workers=workers)
            try:
                if n == 0:
                    verify.check(pt, tier["codecs"])
                break
            except ValueError as e:
                attempt += 1
                if attempt > 1 or external:
                    raise SystemExit(f"verify failed ({e}); refusing to save noise")
                log("  verify failed, restarting service and retrying once...")
                service.stop()
                service.start()
        blobs.append(pt)
        log(f"  [{n + 1}/{len(segs)}] {len(pt) // 1024} KiB")
    return blobs


def cmd_dl(args) -> int:
    tier = _pick_tier(args.adam, args.tier)
    init_e, segs = _segments(tier, args.seg)
    keys = sorted({k.split("/")[-1] for _, _, k in segs})
    print(f"{tier['label']} -- {len(segs)} segment(s), keys {keys}")
    init_bytes = b""
    if init_e:
        u, sp = init_e
        init_bytes = wire.fetch(u, sp) if sp else wire.fetch(u)
    blobs = _download(args.adam, tier, segs, args.workers)
    out = args.o or f"{args.adam}-{tier['id']}.m4a"
    with open(out, "wb") as f:
        f.write(init_bytes)
        for b in blobs:
            f.write(b)
    print(f"wrote {out} ({(len(init_bytes) + sum(map(len, blobs))) // 1024} KiB)")
    return 0


def cmd_stream(args) -> int:
    """Decrypt to stdout (init + segments) for piping into a player."""
    tier = _pick_tier(args.adam, args.tier)
    init_e, segs = _segments(tier, args.seg)
    out = sys.stdout.buffer
    if init_e:
        u, sp = init_e
        out.write(wire.fetch(u, sp) if sp else wire.fetch(u))
    def logs(m):
        print(m, file=sys.stderr)
    for blob in _download(args.adam, tier, segs, args.workers, log=logs):
        out.write(blob)
        out.flush()
    return 0


def cmd_stop(_args) -> int:
    service.stop()
    print("stopped")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="fairplay-decrypt", description="Apple Music FairPlay decrypter")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("login", help="sign in with an Apple ID (stores session, no 2FA next time)")
    p.add_argument("--user")
    p.add_argument("--password")
    p.add_argument("--fresh", action="store_true", help="wipe device identity and start over")
    p.set_defaults(fn=cmd_login)

    p = sub.add_parser("ladder", help="list quality tiers for a song")
    p.add_argument("adam", help="song id (e.g. 268443097)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.set_defaults(fn=cmd_ladder)

    p = sub.add_parser("dl", help="download a song (default: best tier, all segments)")
    p.add_argument("adam")
    p.add_argument("--tier", default=None)
    p.add_argument("--seg", default="all", help="segment index or 'all'")
    p.add_argument("-o", default=None)
    p.add_argument("--workers", type=int, default=2)
    p.set_defaults(fn=cmd_dl)

    p = sub.add_parser("stream", help="decrypt to stdout for piping into a player")
    p.add_argument("adam")
    p.add_argument("--tier", default=None)
    p.add_argument("--seg", default="all")
    p.add_argument("--workers", type=int, default=2)
    p.set_defaults(fn=cmd_stream)

    p = sub.add_parser("status", help="service + session state")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("doctor", help="environment checks")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("stop", help="stop the local service instance")
    p.set_defaults(fn=cmd_stop)

    p = sub.add_parser("setup", help="stage a local FairPlay service install (one command)")
    p.add_argument("--from", dest="from_", default=None,
                   help="install dir containing the launcher and rootfs/ (auto-detected if omitted)")
    p.add_argument("--url", default=None,
                   help="runtime bundle (zip) to install from instead; recorded for later re-stages")
    p.add_argument("--force", action="store_true", help="replace an existing staged copy")
    p.set_defaults(fn=cmd_setup)
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if (args.cmd in ("ladder", "dl", "stream") and not service.is_running()
            and not os.environ.get("FPDECRYPT_EXTERNAL")):
        print("starting service...")
        try:
            service.start()
        except RuntimeError as e:
            print(f"cannot start service: {e}")
            return 1
    try:
        return args.fn(args)
    except (ConnectionError, TimeoutError, ValueError) as e:
        print(f"error: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
