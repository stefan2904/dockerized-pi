#!/usr/bin/env python3
"""Host-side cmux bridge for Dockerized Pi.

This small loopback HTTP server lets a Linux container run a mounted `cmux`
shim which forwards commands to the real host cmux CLI. It is intentionally
single-purpose for Pi's cmux hook integration.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MAX_BODY_BYTES = 16 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 130


def _load_json(data: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(data.decode("utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


class BridgeState:
    def __init__(self, token: str, cmux_bin: str) -> None:
        self.token = token
        self.cmux_bin = cmux_bin
        self.base_env = os.environ.copy()


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "cmux-pi-bridge/1"

    @property
    def state(self) -> BridgeState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("CMUX_BRIDGE_DEBUG") == "1":
            super().log_message(fmt, *args)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/run":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {self.state.token}":
            self._send_json(403, {"ok": False, "error": "forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "bad_length"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "error": "body_too_large"})
            return
        request = _load_json(self.rfile.read(length))
        if request is None:
            self._send_json(400, {"ok": False, "error": "bad_json"})
            return

        args = request.get("args", [])
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
            self._send_json(400, {"ok": False, "error": "bad_args"})
            return
        stdin = request.get("stdin", "")
        if not isinstance(stdin, str):
            self._send_json(400, {"ok": False, "error": "bad_stdin"})
            return
        cwd = request.get("cwd")
        if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
            cwd = None
        overlay_env = request.get("env", {})
        if not isinstance(overlay_env, dict):
            overlay_env = {}
        env = self.state.base_env.copy()
        for key, value in overlay_env.items():
            if not isinstance(key, str) or not isinstance(value, str):
                continue
            if key == "CMUX_SOCKET_PATH" or key == "CMUX_SOCKET":
                continue
            if key in {
                "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_PANEL_ID",
                "CMUX_TAB_ID", "CMUX_WINDOW_ID", "CMUX_AGENT_HOOK_STATE_DIR",
            } or key.startswith("CMUX_AGENT_LAUNCH_"):
                env[key] = value

        timeout = request.get("timeout", DEFAULT_TIMEOUT_SECONDS)
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            timeout = DEFAULT_TIMEOUT_SECONDS
        timeout = min(float(timeout), DEFAULT_TIMEOUT_SECONDS)

        try:
            completed = subprocess.run(
                [self.state.cmux_bin, *args],
                input=stdin,
                text=True,
                capture_output=True,
                cwd=cwd,
                env=env,
                timeout=timeout,
            )
            self._send_json(200, {
                "ok": True,
                "status": completed.returncode,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
            })
        except subprocess.TimeoutExpired as exc:
            self._send_json(200, {
                "ok": True,
                "status": 124,
                "stdout": exc.stdout if isinstance(exc.stdout, str) else "",
                "stderr": "cmux bridge command timed out\n",
            })
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": str(exc)})


def serve(args: argparse.Namespace) -> None:
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    server.state = BridgeState(args.token, args.cmux_bin)  # type: ignore[attr-defined]
    host, port = server.server_address[:2]
    if args.ready_file:
        with open(args.ready_file, "w", encoding="utf-8") as f:
            json.dump({"host": host, "port": port}, f)
            f.write("\n")
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    parser.add_argument("--cmux-bin", default="cmux")
    parser.add_argument("--ready-file")
    args = parser.parse_args(argv)
    serve(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
