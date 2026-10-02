"""Embed the Spanish frequency ranks into the Spanish dictionary package.

Input:  build/dictionaries/spanish-wiktionary/spanish-wiktionary.sqlite.gz (tools/build-spanish-dictionary.py)
        build/dictionaries/spanish-wiktionary/frequency.tsv              (tools/build-spanish-frequency.py)
Output: the same .sqlite.gz, now with a `langlsrw_frequency` table and `frequency_version` in dictionary_meta.

The site serves no dictionary data, so users install one file they download themselves; the dictionary Worker
uses an embedded `langlsrw_frequency` table directly instead of fetching ranks from the server.
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "build" / "dictionaries" / "spanish-wiktionary"
TABLE = "langlsrw_frequency"


def read_ranks(path: Path) -> list[tuple[str, int, int]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:
        rank, word, *rest = line.split("\t")
        if word and rank.isdigit() and int(rank) > 0:
            occurrences = int(rest[0]) if rest and rest[0].isdigit() else 0
            rows.append((word, int(rank), occurrences))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--package", type=Path, default=DEFAULT_DIR / "spanish-wiktionary.sqlite.gz")
    parser.add_argument("--frequency", type=Path, default=DEFAULT_DIR / "frequency.tsv")
    parser.add_argument("--version", required=True, help="Frequency version, e.g. 2026.09.28")
    parser.add_argument("--output", type=Path, help="Defaults to overwriting --package")
    args = parser.parse_args()
    output = args.output or args.package
    database_path = output.with_suffix(".building")
    with gzip.open(args.package, "rb") as source, database_path.open("wb") as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
    ranks = read_ranks(args.frequency)
    with sqlite3.connect(database_path) as db:
        db.execute(f"DROP TABLE IF EXISTS {TABLE}")
        db.execute(f"CREATE TABLE {TABLE} (word TEXT PRIMARY KEY COLLATE NOCASE, frequency_rank INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 0)")
        db.executemany(f"INSERT OR IGNORE INTO {TABLE} (word, frequency_rank, occurrences) VALUES (?, ?, ?)", ranks)
        db.execute(f"CREATE INDEX {TABLE}_rank ON {TABLE} (frequency_rank)")
        db.execute("INSERT OR REPLACE INTO dictionary_meta (key, value) VALUES ('frequency_version', ?)", (args.version,))
    with sqlite3.connect(database_path) as db:
        db.execute("VACUUM")
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    temporary = output.with_suffix(".gz.building")
    with database_path.open("rb") as source, temporary.open("wb") as target:
        with gzip.GzipFile(filename=output.with_suffix("").name, mode="wb", fileobj=target, compresslevel=9, mtime=0) as zipped:
            shutil.copyfileobj(source, zipped, 1024 * 1024)
    temporary.replace(output)
    database_path.unlink()
    print(f"Embedded {len(ranks):,} ranks (v{args.version}) into {output}")


if __name__ == "__main__":
    main()
