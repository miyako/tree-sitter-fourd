#!/usr/bin/env python3
"""Prove that every row of src/builtins.h can actually be found.

``src/scanner.c`` looks names up with ``fourd_lower_bound()``, a binary search
over ``FOURD_BUILTINS``. That makes the order a correctness property rather
than a cosmetic one: a table that is not sorted in ``fourd_stricmp`` order does
not fail loudly, it just stops finding names. 401 of the 3944 rows in the
historically committed table were unreachable for exactly that reason.

This is the independent check, deliberately written from the C side's
semantics rather than from ``generate_builtins.py``: it re-reads the header
from disk, re-implements ``fourd_stricmp``, and simulates the search. It runs
anywhere Python runs, so CI on Windows can gate on it without a C compiler.
``tools/check_builtins.c`` remains the same check against the real inline
functions, for machines that do have one.

Usage::

    tools/check_builtins.py                     # src/builtins.h
    tools/check_builtins.py other/builtins.h    # exit 1 on any violation
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROW_RE = re.compile(
    r'^    \{ "(?P<name>(?:[^"\\]|\\.)*)", '
    r"(?P<kind>FOURD_COMMAND|FOURD_CONSTANT|FOURD_SYSVAR) \},?$"
)
DEFINE_RE = re.compile(r"^#define (FOURD_MAX_BUILTIN_WORDS|FOURD_MAX_BUILTIN_LEN) (\d+)$")

REPORT_LIMIT = 10


def fourd_stricmp(a: str, b: str) -> int:
    """Compare as the C side does: UTF-8 bytes, ASCII letters folded."""
    ba, bb = a.encode("utf-8"), b.encode("utf-8")
    for x, y in zip(ba, bb):
        if 0x41 <= x <= 0x5A:
            x += 0x20
        if 0x41 <= y <= 0x5A:
            y += 0x20
        if x != y:
            return x - y
    return len(ba) - len(bb)


def lower_bound(names: list[str], key: str) -> int:
    """First index whose name compares >= key, i.e. fourd_lower_bound()."""
    lo, hi = 0, len(names)
    while lo < hi:
        mid = (lo + hi) // 2
        if fourd_stricmp(names[mid], key) < 0:
            lo = mid + 1
        else:
            hi = mid
    return lo


def words(name: str) -> int:
    return len(name.split())


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path("src/builtins.h")
    if not path.is_file():
        print(f"error: no such header: {path}", file=sys.stderr)
        return 2

    names: list[str] = []
    kinds: list[str] = []
    defines: dict[str, int] = {}
    problems: list[str] = []

    def complain(message: str) -> None:
        if len(problems) < REPORT_LIMIT:
            problems.append(message)
        elif len(problems) == REPORT_LIMIT:
            problems.append("... further problems suppressed")

    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        define = DEFINE_RE.match(line)
        if define:
            defines[define.group(1)] = int(define.group(2))
            continue
        row = ROW_RE.match(line)
        if not row:
            continue
        name = row.group("name")
        if "\\" in name or '"' in name:
            # Rows must hold the name verbatim; an escape means the row is not
            # what the table writes, so the search would compare other bytes.
            complain(f"line {number}: escaped characters in {name!r}")
        if names and fourd_stricmp(names[-1], name) >= 0:
            complain(f"line {number}: not ascending: {names[-1]!r} then {name!r}")
        names.append(name)
        kinds.append(row.group("kind"))

    if not names:
        print(f"error: {path} has no table rows", file=sys.stderr)
        return 1

    unreachable = [n for n in names if lower_bound(names, n) >= len(names)
                   or names[lower_bound(names, n)] != n]
    for name in unreachable[: max(0, REPORT_LIMIT - len(problems))]:
        complain(f"unreachable by binary search: {name!r}")
    if len(unreachable) > REPORT_LIMIT - len(problems):
        problems.append(f"... {len(unreachable)} unreachable rows in total")

    longest = max(len(n.encode("utf-8")) for n in names)
    widest = max(words(n) for n in names)

    for key, actual in (("FOURD_MAX_BUILTIN_WORDS", widest), ("FOURD_MAX_BUILTIN_LEN", 64)):
        declared = defines.get(key)
        if declared is None:
            continue
        if key == "FOURD_MAX_BUILTIN_WORDS" and declared != actual:
            complain(f"{key} is {declared} but the longest name has {actual} words")
        if key == "FOURD_MAX_BUILTIN_LEN" and declared < longest:
            complain(f"{key} is {declared} but the longest name needs {longest} bytes")

    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        print(
            f"error: {len(unreachable)} of {len(names)} rows unreachable, "
            f"{path} cannot be used as a lookup table",
            file=sys.stderr,
        )
        return 1

    counts = {kind: kinds.count(kind) for kind in ("FOURD_COMMAND", "FOURD_CONSTANT", "FOURD_SYSVAR")}
    summary = ", ".join(f"{n} {k.split('_', 1)[1].lower()}" for k, n in counts.items())
    print(
        f"{len(names)} builtins ({summary}), ordered and reachable, "
        f"max words {widest}, longest name {longest} bytes"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
