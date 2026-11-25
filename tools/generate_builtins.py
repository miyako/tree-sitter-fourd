#!/usr/bin/env python3
"""Render src/builtins.h from the 4D command/constant dump.

The dump is produced by ``tools/4dproject/Sources/Methods/generate_builtins_dump.4dm``
running under tool4d and looks like::

    {
      "version": "21 R5",
      "build": "21R5.100186",
      "commands":  ["ABORT", "ABORT PROCESS BY ID", ...],
      "constants": ["ak background color", ...]
    }

This script owns *presentation*: ordering, escaping and the two computed
``#define`` lines. 4D owns *content*: which names exist in a given release.

Invariants enforced (each is a hard error, never a silent fix):

* a name is non-empty UTF-8 with no control characters, contains no ``"`` or
  backslash, and is at most ``FOURD_MAX_BUILTIN_LEN`` bytes. A handful of
  constant names carry a degree sign (``Orientation 0°``); ``fourd_stricmp``
  compares those bytes verbatim, so they are kept as UTF-8;
* no name appears twice within one namespace;
* the command and constant namespaces are disjoint -- the header explains
  why one table with a kind mask can only work while that holds;
* every line of the table is ``{ "name", FOURD_KIND },`` in exactly that
  shape.

Ordering is ``fourd_stricmp`` order, i.e. byte-wise ASCII with ``A-Z`` folded
to lower case, so space (0x20) precedes digits and letters, and ``4`` (0x34)
precedes ``_`` (0x5F). ``FOURD_ASSERT_SORTED`` in the header enforces the
same rule in debug builds.

Usage::

    tools/generate_builtins.py --dump builtins.json --write src/builtins.h
    tools/generate_builtins.py --dump builtins.json --build 21R5.100186 --write
    tools/generate_builtins.py --dump builtins.json --check   # CI: exit 1 if stale
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

COMMAND = "FOURD_COMMAND"
CONSTANT = "FOURD_CONSTANT"
SYSVAR = "FOURD_SYSVAR"

ROW_RE = re.compile(r'^    \{ "(?P<name>(?:[^"\\]|\\.)*)", (?P<kind>FOURD_COMMAND|FOURD_CONSTANT|FOURD_SYSVAR) \},?$')
TABLE_START = re.compile(r"^static const FourdBuiltin FOURD_BUILTINS\[\] = \{\n", re.M)
TABLE_END = re.compile(r"^\};\n", re.M)
WORDS_RE = re.compile(r"^#define FOURD_MAX_BUILTIN_WORDS (\d+)$", re.M)
LEN_RE = re.compile(r"^#define FOURD_MAX_BUILTIN_LEN(\s+)(\d+)$", re.M)
STAMP_RE = re.compile(r"^// Source release: tool4d .*$", re.M)

# Buffer size for a builtin name, including the NUL. Raised only by hand:
# a name longer than this is a deliberate decision, not something CI guesses.
MAX_LEN = 64


class DumpError(Exception):
    pass


def sort_key(name: str) -> bytes:
    """Byte string folding A-Z to a-z, matching fourd_stricmp().

    Non-ASCII bytes (a few constant names carry a degree sign) pass through
    unfolded, exactly as fourd_tolower() leaves them.
    """
    return bytes(c + 32 if 0x41 <= c <= 0x5A else c for c in name.encode("utf-8"))


def escape(name: str) -> str:
    return name.replace("\\", "\\\\").replace('"', '\\"')


def validate_names(names: list[str], namespace: str) -> None:
    seen: dict[str, str] = {}
    for name in names:
        if not name:
            raise DumpError(f"{namespace}: empty name")
        try:
            raw = name.encode("utf-8")
        except UnicodeEncodeError:
            raise DumpError(f"{namespace}: name is not valid UTF-8: {name!r}") from None
        if any(ord(c) < 0x20 or ord(c) == 0x7F for c in name):
            raise DumpError(f"{namespace}: control character in {name!r}")
        if '"' in name or "\\" in name:
            raise DumpError(f"{namespace}: quote or backslash in {name!r}")
        if len(raw) > MAX_LEN - 1:
            raise DumpError(
                f"{namespace}: {name!r} is {len(raw)} bytes, over FOURD_MAX_BUILTIN_LEN-1={MAX_LEN - 1}"
            )
        folded = name.lower()
        if folded in seen:
            raise DumpError(f"{namespace}: duplicate {name!r} (also {seen[folded]!r})")
        seen[folded] = name


def load_dump(path: Path, build: str = "") -> tuple[list[str], list[str], str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("commands", "constants"):
        if key not in data:
            raise DumpError(f"{path}: missing {key!r}")
    commands = [str(n) for n in data["commands"]]
    constants = [str(n) for n in data["constants"]]
    validate_names(commands, "commands")
    validate_names(constants, "constants")

    overlap = {c.lower() for c in commands} & {c.lower() for c in constants}
    if overlap:
        sample = ", ".join(sorted(overlap)[:5])
        raise DumpError(
            f"command and constant namespaces overlap ({len(overlap)} names, e.g. {sample}); "
            "the single-table design in builtins.h cannot represent that"
        )

    # Application version may already carry "build ..."; the CLI stamp is the
    # authoritative one and is appended below.
    label = re.sub(r"\s*build\s+.*$", "", str(data.get("version", "unknown")), flags=re.I)
    build = build or data.get("build", "")
    if build:
        label = f"{label} (build {build})"
    return commands, constants, label


def parse_existing(header: str) -> list[tuple[str, str]]:
    start = TABLE_START.search(header)
    end = TABLE_END.search(header, start.end()) if start else None
    if not start or not end:
        raise DumpError("no FOURD_BUILTINS table found in the current header")
    body = header[start.end() : end.start()]
    rows: list[tuple[str, str]] = []
    for line in body.split("\n"):
        if not line.strip():
            continue
        match = ROW_RE.match(line)
        if not match:
            raise DumpError(f"unrecognised table line: {line!r}")
        rows.append((match.group("name"), match.group("kind")))
    return rows


def collect_sysvars(rows: list[tuple[str, str]]) -> list[str]:
    """System variables have no 4D-side enumeration API, so they are carried over."""
    return [name for name, kind in rows if kind == SYSVAR]


def render(header: str, commands: list[str], constants: list[str], label: str) -> str:
    rows = parse_existing(header)
    sysvars = collect_sysvars(rows)

    # A dump that is *smaller* than the table it replaces is a red flag, not a
    # release: a truncated XLF parse, a tool4d that could not read its own
    # resources, or a --startup-method that never ran all look like this.
    # 4D has never removed names in bulk, so refuse rather than open a PR that
    # guts the table.
    for kind, new_count in (
        (COMMAND, len(commands)),
        (CONSTANT, len(constants)),
    ):
        old_count = sum(1 for _, row_kind in rows if row_kind == kind)
        if old_count and new_count < old_count * 0.9:
            raise DumpError(
                f"{kind}: dump has {new_count} names but the header has {old_count} "
                f"({100 * new_count / old_count:.0f}% of it); refusing to shrink the table"
            )

    table = sorted(
        [(name, COMMAND) for name in commands]
        + [(name, CONSTANT) for name in constants]
        + [(name, SYSVAR) for name in sysvars],
        key=lambda row: sort_key(row[0]),
    )

    # The committed table omits the comma on its last row; keep that shape so a
    # no-op regeneration stays a no-op.
    lines = [f'    {{ "{escape(name)}", {kind} }}' + ("," if i < len(table) - 1 else "") for i, (name, kind) in enumerate(table)]

    start = TABLE_START.search(header)
    end = TABLE_END.search(header, start.end())
    out = header[: start.end()] + "\n".join(lines) + "\n" + header[end.start() :]

    max_words = max(len(name.split()) for name, _ in table)
    out = WORDS_RE.sub(f"#define FOURD_MAX_BUILTIN_WORDS {max_words}", out)

    declared = LEN_RE.search(out)
    if declared and int(declared.group(2)) < MAX_LEN:
        raise DumpError(
            f"header declares FOURD_MAX_BUILTIN_LEN {declared.group(2)}, "
            f"below the {MAX_LEN} this generator assumes"
        )

    # Keep the provenance of the table reviewable in the diff itself.
    stamp = f"// Source release: tool4d {label}."
    if STAMP_RE.search(out):
        out = STAMP_RE.sub(stamp, out, count=1)
    else:
        first_nl = out.index("\n")
        out = out[: first_nl + 1] + stamp + "\n" + out[first_nl + 1 :]

    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dump", required=True, type=Path, help="JSON produced by generate_builtins_dump.4dm")
    parser.add_argument("--header", type=Path, default=Path("src/builtins.h"))
    parser.add_argument("--build", default="", help="exact build stamp, e.g. from tool4d --version")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="rewrite --header in place")
    mode.add_argument("--check", action="store_true", help="exit 3 if --header is out of date")
    args = parser.parse_args(argv)

    try:
        commands, constants, label = load_dump(args.dump, args.build)
        before = args.header.read_text(encoding="utf-8")
        after = render(before, commands, constants, label)
    except (OSError, json.JSONDecodeError, DumpError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.check:
        if before != after:
            print(f"{args.header} is out of date; run tools/generate_builtins.py --dump ... --write", file=sys.stderr)
            return 3
        print(f"{args.header} is up to date ({len(commands)} commands, {len(constants)} constants)")
        return 0

    print(
        f"{len(commands)} commands + {len(constants)} constants "
        f"= {len(commands) + len(constants)} entries from {label}"
    )

    if args.write:
        if before == after:
            print("no change")
            return 0
        args.header.write_text(after, encoding="utf-8")
        print(f"wrote {args.header}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
