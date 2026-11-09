"""Lifecycle for the local FairPlay service instance.

fairplay_decrypter launches the user's own local service install (staged by
``fairplay-decrypt setup``) with its own base dir and ports. The child is
started in its own process group so ``stop()`` takes the inner service down
too (killing only the launcher orphans the port holder).
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
from pathlib import Path

from . import config


def _port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def pidfile() -> Path:
    return config.data_dir() / "service.pid"


def logfile() -> Path:
    return config.data_dir() / "service.log"


def is_running() -> bool:
    try:
        pid = int(pidfile().read_text().strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    p = config.ports()
    return _port_open(p["decrypt"]) or _port_open(p["manifest"])


def start(creds: str | None = None, extra_args: list[str] | None = None,
          timeout: int = 120) -> subprocess.Popen:
    """Launch the service; wait for decrypt+manifest ports. ``creds`` is
    ``user:password`` for ``-L`` (login); otherwise the stored session is
    reused (no 2FA once the device is trusted)."""
    inst = config.service_dir()
    if inst is None:
        raise RuntimeError("no service install found -- run: fairplay-decrypt setup")
    if is_running():
        raise RuntimeError("service already running (fairplay-decrypt status / stop)")
    p = config.ports()
    base = config.device_base()
    base.mkdir(parents=True, exist_ok=True)
    config.data_dir().mkdir(parents=True, exist_ok=True)
    args = ["sudo", "-n", "./wrapper", "-H", "127.0.0.1",
            "-D", str(p["decrypt"]), "-M", str(p["manifest"]),
            "-A", str(p["account"]), "-K", str(p["key"]),
            "-B", str(base)]
    if os.environ.get("FPDECRYPT_NO_SUDO") == "1":
        # Hosts with unprivileged user namespaces can run the wrapper
        # directly; the mounts it needs do not require root there.
        args.pop(0)
        args.pop(0)
    if creds:
        args += ["-L", creds]
    args += ["-F"]
    if extra_args:
        args += extra_args
    log = open(logfile(), "ab")
    proc = subprocess.Popen(args, cwd=str(inst), stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)
    pidfile().write_text(str(proc.pid))
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"service exited early (see {logfile()})")
        if _port_open(p["decrypt"]) and _port_open(p["manifest"]):
            return proc
        time.sleep(1)
    stop()
    raise RuntimeError(f"service ports never came up (see {logfile()})")


def stop() -> None:
    """Kill the whole process group (launcher + inner service)."""
    try:
        pid = int(pidfile().read_text().strip())
    except (OSError, ValueError):
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        pidfile().unlink()
    except OSError:
        pass
