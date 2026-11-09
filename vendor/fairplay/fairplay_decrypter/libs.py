"""Local service install staging.

``setup`` copies a working FairPlay service install (launcher + rootfs) into
the user's data dir so the CLI starts it from one known place. The copy is
local only: it lives under XDG data and is never committed.

Account state (``rootfs/data``, login DBs, tokens) is deliberately skipped.
Each machine signs in once with its own Apple ID; nothing secret is copied
from an existing install or stored in this repository.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

LIB_NAMES = (
    "libandroidappmusic.so",
    "libCoreFP.so",
    "libCoreLSKD.so",
    "libCoreADI.so",
    "libmediaplatform.so",
    "libstoreservicescore.so",
)

#: Prebuilt runtime used when no local install is present.
RUNTIME_URL = ("https://github.com/WorldObservationLog/wrapper/releases/download/"
               "wrapper.x86_64.latest/Wrapper.x86_64.latest.zip")

#: Files that make a directory a usable service install.
REQUIRED = (
    Path("wrapper"),
    Path("rootfs/system/bin/main"),
    Path("rootfs/system/bin/linker64"),
    *(Path("rootfs/system/lib64") / name for name in LIB_NAMES),
)

#: Top-level rootfs dirs never copied: runtime mounts and per-machine state.
SKIP_TOP = {"dev", "proc", "data", "home"}

_SKIP_SCAN = {".git", ".cache", "node_modules", "__pycache__", "site-packages",
              "venv", ".venv", "dist", "build"}


def install_dir(data_dir: Path) -> Path:
    return data_dir / "service"


def missing(root: Path) -> list[str]:
    """Relative paths that keep ``root`` from being a usable install."""
    out: list[str] = []
    for rel in REQUIRED:
        try:
            if not (root / rel).exists():
                out.append(str(rel))
        except OSError:
            out.append(str(rel))
    return out


def executable(root: Path) -> bool:
    return os.access(root / "wrapper", os.X_OK)


def is_install(root: Path) -> bool:
    return not missing(root)


def find_installs(roots: list[Path] | None = None, max_depth: int = 2) -> list[Path]:
    """Bounded scan for existing installs (read-only, no symlink following)."""
    if roots is None:
        home = Path.home()
        roots = [home, home / ".local/share", home / "Downloads", Path("/opt"), Path("/srv")]
    found: list[Path] = []
    visited = 0
    for root in roots:
        if not root.is_dir():
            continue
        base = len(root.parts)
        for dirpath, dirnames, _ in os.walk(root, followlinks=False,
                                            onerror=lambda _e: None):
            visited += 1
            if visited > 5000:
                break
            here = Path(dirpath)
            if len(here.parts) - base >= max_depth:
                dirnames[:] = []
            else:
                dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_SCAN)
            if is_install(here):
                found.append(here.resolve())
    return found


def _ignore(root: Path):
    def inner(dirpath: str, names: list[str]) -> set[str]:
        rel = Path(dirpath).relative_to(root)
        if rel == Path("."):
            return {n for n in names if n in ("dev", "proc")}
        if rel == Path("rootfs"):
            return {n for n in names if n in SKIP_TOP}
        return set()
    return inner


def stage(src: Path, dest: Path, force: bool = False) -> list[str]:
    """Copy a service install to ``dest``, minus account state.

    Returns the list of missing pieces (empty on success). An existing install
    is left alone unless ``force`` is passed.
    """
    if is_install(dest) and not force:
        return []
    if dest.exists() and not force and any(dest.iterdir()):
        raise FileExistsError(f"{dest} exists and is not an install; use --force")
    tmp = dest.with_name(dest.name + ".new")
    shutil.rmtree(tmp, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, tmp, symlinks=True, ignore=_ignore(src))
    # Archive extraction loses the exec bit; the launcher and Android binaries need it.
    for rel in ("wrapper", "rootfs/system/bin/main", "rootfs/system/bin/linker64"):
        p = tmp / rel
        if p.exists():
            p.chmod(p.stat().st_mode | 0o111)
    # Fresh account dir; login fills it per machine.
    (tmp / "rootfs/data/data/com.apple.android.music/files").mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    tmp.rename(dest)
    return missing(dest)


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    root = dest.resolve()
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if root not in target.parents and target != root:
            raise ValueError(f"unsafe archive member: {member.filename}")
    zf.extractall(dest)


def fetch(dest: Path, url: str | None = None, force: bool = False,
          timeout: int = 300) -> list[str]:
    """Download the prebuilt runtime, extract, and stage it at ``dest``."""
    url = url or os.environ.get("FPDECRYPT_RUNTIME_URL") or RUNTIME_URL
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent, prefix="runtime-") as tmp:
        tmpdir = Path(tmp)
        archive = tmpdir / "runtime.zip"
        req = urllib.request.Request(url, headers={"User-Agent": "fairplay-decrypter"})
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(archive, "wb") as f:
            shutil.copyfileobj(resp, f)
        unpacked = tmpdir / "unpacked"
        unpacked.mkdir()
        with zipfile.ZipFile(archive) as zf:
            _safe_extract(zf, unpacked)
        src = unpacked
        if not is_install(src) and (unpacked / "rootfs").is_dir():
            # Zip may wrap everything in one top-level directory.
            for child in unpacked.iterdir():
                if child.is_dir() and is_install(child):
                    src = child
                    break
        if not is_install(src):
            raise ValueError("downloaded runtime is incomplete: " + ", ".join(missing(src)))
        return stage(src, dest, force=force)


def sizes(root: Path) -> dict[str, int]:
    return {name: (root / "rootfs/system/lib64" / name).stat().st_size
            for name in LIB_NAMES if (root / "rootfs/system/lib64" / name).exists()}


def describe(root: Path) -> str:
    gone = missing(root)
    lines = [f"install  {root}", f"libs     {len(sizes(root))}/{len(LIB_NAMES)}"]
    lines.append("status   " + ("ready" if not gone else "missing " + ", ".join(gone)))
    return "\n".join(lines)
