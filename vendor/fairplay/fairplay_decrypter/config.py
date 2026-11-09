"""Paths, ports, and session state. No secrets live in this repo; tokens and
device identity live under the user's data dir (created by ``login``)."""

from __future__ import annotations

import json
import os
from pathlib import Path

APP = "fairplay-decrypter"

DEFAULT_PORTS = {"decrypt": 10120, "manifest": 20120, "account": 30120, "key": 40120}

FILES_DIR = Path("rootfs/data/data/com.apple.android.music/files")


def config_dir() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / APP


def data_dir() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / APP


def device_base() -> Path:
    """Service base dir owned by fairplay_decrypter (fresh device identity)."""
    return data_dir() / "device"


def session_files() -> Path:
    return device_base() / FILES_DIR


def load_config() -> dict:
    cfg = config_dir() / "config.json"
    try:
        return json.loads(cfg.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    path = config_dir() / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2) + "\n")
    os.chmod(path, 0o600)


def ports() -> dict:
    p = dict(DEFAULT_PORTS)
    p.update(load_config().get("ports", {}))
    for k in p:
        env = os.environ.get(f"FPDECRYPT_PORT_{k.upper()}")
        if env:
            p[k] = int(env)
    return p


def service_dir() -> Path | None:
    """Install dir of the local FairPlay service (launcher + rootfs).

    Resolution order: ``FPDECRYPT_SERVICE`` (alias ``FPDECRYPT_WRAPPER``),
    the ``service_dir`` written by ``setup``, then the default staged copy
    under the data dir.
    """
    from . import libs

    cands: list[Path] = []
    env = os.environ.get("FPDECRYPT_SERVICE") or os.environ.get("FPDECRYPT_WRAPPER")
    if env:
        cands.append(Path(env).expanduser())
    configured = load_config().get("service_dir")
    if configured:
        cands.append(Path(configured).expanduser())
    cands.append(libs.install_dir(data_dir()))
    for c in cands:
        if libs.is_install(c):
            return c
    return None


def set_service_dir(path: Path) -> None:
    cfg = load_config()
    cfg["service_dir"] = str(path)
    save_config(cfg)


def runtime_url() -> str | None:
    return load_config().get("runtime_url")


def set_runtime_url(url: str) -> None:
    cfg = load_config()
    cfg["runtime_url"] = url
    save_config(cfg)


def music_token() -> str | None:
    try:
        return (session_files() / "MUSIC_TOKEN").read_text().strip()
    except OSError:
        return None


def storefront() -> str | None:
    try:
        return (session_files() / "STOREFRONT_ID").read_text().strip()
    except OSError:
        return None
