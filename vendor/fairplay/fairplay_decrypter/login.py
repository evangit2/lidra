"""Apple ID login through the local FairPlay runtime.

First login provisions the device identity and caches MUSIC_TOKEN; later
starts reuse it with no 2FA while the device stays trusted. The runtime
reads the 2FA code from ``2fa.txt`` under the session files dir (``-F``).
"""

from __future__ import annotations

import getpass
import shutil
import time

from . import config, service


def _token_path():
    return config.session_files() / "MUSIC_TOKEN"


def _code_path():
    return config.session_files() / "2fa.txt"


def _code_paths() -> list:
    from pathlib import Path
    paths = [_code_path()]
    try:
        inst = config.service_dir()
    except Exception:
        inst = None
    if inst is not None:
        # The service reads rootfs/<files>/2fa.txt relative to its install
        # dir (credentialHandler), not relative to the device base.
        paths.append(Path(inst) / config.FILES_DIR / "2fa.txt")
    return paths


def _wait_token(deadline: float) -> bool:
    while time.time() < deadline:
        try:
            if _token_path().stat().st_size > 0:
                return True
        except OSError:
            pass
        time.sleep(2)
    return False


def login(user: str | None = None, password: str | None = None, fresh: bool = False) -> bool:
    """Run the login flow. Returns True once MUSIC_TOKEN exists."""
    if fresh:
        service.stop()
        shutil.rmtree(config.device_base(), ignore_errors=True)
    if _token_path().exists() and _token_path().stat().st_size and not (user or password):
        print("already signed in (use --fresh to start over)")
        return True
    user = user or input("Apple ID: ").strip()
    password = password or getpass.getpass("Password: ")
    if service.is_running():
        service.stop()
    print("starting service and signing in (this can take a minute)...")
    service.start(creds=f"{user}:{password}")
    try:
        if _wait_token(time.time() + 90):
            print("signed in; device trusted for future starts")
            return True
        print("waiting on two-factor approval...")
        code = input("2FA code: ").strip()
        for p in _code_paths():
            try:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(code)
            except OSError:
                pass
        if _wait_token(time.time() + 120):
            print("signed in; device trusted for future starts")
            return True
        print("login did not complete; check fairplay-decrypt status / service log")
        return False
    finally:
        for p in _code_paths():
            try:
                p.unlink()
            except OSError:
                pass
