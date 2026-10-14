"""Version order and update channels for Gateway self-updates.

The same rules the device firmware and Hub use (VersionCompare.cpp /
UpdateChannel.h in NewHorizonsOS-OTA), checked against the shared vectors in
NewHorizonsOS-OTA/spec/fixtures/versions.json:

- versions are ``vMAJOR.MINOR.PATCH`` with an optional prerelease
  (``v0.7.0-beta.1``), and a prerelease sorts *below* its release;
- the ``stable`` channel reads ``gateway-latest.json`` (the only manifest
  older Gateways know), ``beta`` reads ``gateway-beta.json``;
- leaving beta never downgrades: an older stable is simply "not newer".
"""
from __future__ import annotations

import re

UPDATE_CHANNELS = ("stable", "beta")
DEFAULT_UPDATE_CHANNEL = "stable"
MANIFEST_BASE_URL = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/gateway"

_VERSION_RE = re.compile(r"^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?[^-+]*(?:-([^+]*))?(?:\+.*)?$")


def normalize_channel(value: object) -> str:
    """Unknown or missing channels fall back to stable, never to beta."""
    channel = str(value or "").strip().lower()
    return channel if channel in UPDATE_CHANNELS else DEFAULT_UPDATE_CHANNEL


def manifest_url_for(channel: object, base_url: str = MANIFEST_BASE_URL) -> str:
    suffix = "-beta.json" if normalize_channel(channel) == "beta" else "-latest.json"
    return f"{base_url}{suffix}"


def _parse(version: object) -> tuple[tuple[int, int, int], list[str]]:
    match = _VERSION_RE.match(str(version or ""))
    if not match:
        return (0, 0, 0), []
    core = tuple(int(part or 0) for part in match.group(1, 2, 3))
    pre = match.group(4)
    return core, (pre.split(".") if pre else [])  # type: ignore[return-value]


def _compare_identifier(a: str, b: str) -> int:
    a_num, b_num = a.isdigit(), b.isdigit()
    if a_num and b_num:
        return (int(a) > int(b)) - (int(a) < int(b))
    if a_num != b_num:
        return -1 if a_num else 1
    return (a > b) - (a < b)


def compare_versions(a: object, b: object) -> int:
    """<0 if a is older than b, 0 if equal, >0 if a is newer."""
    a_core, a_pre = _parse(a)
    b_core, b_pre = _parse(b)
    if a_core != b_core:
        return 1 if a_core > b_core else -1
    if not a_pre or not b_pre:
        return (not a_pre) - (not b_pre)
    for left, right in zip(a_pre, b_pre):
        result = _compare_identifier(left, right)
        if result:
            return result
    return (len(a_pre) > len(b_pre)) - (len(a_pre) < len(b_pre))


def is_newer_version(candidate: object, current: object) -> bool:
    return compare_versions(candidate, current) > 0


def is_prerelease(version: object) -> bool:
    return bool(_parse(version)[1])
