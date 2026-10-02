# Dictionaries

The website serves **no dictionary data**. Each user downloads a package from the
[`dictionaries-2026.10` GitHub release](https://github.com/carloscn/BookHill/releases/tag/dictionaries-2026.10)
and installs it from the file in **设置 → 本地词典 → 从文件安装**. The dictionary
Worker streams the file (gunzip in the browser), imports it into OPFS with
sqlite-wasm, then checks `schema_version`, `dictionary_id` and `PRAGMA quick_check`.
Nothing is uploaded; the installed database stays in that browser.

| Package | Entries | File | Installed | License |
| --- | --- | --- | --- | --- |
| `ecdict.sqlite.gz` (ECDICT 英汉) | 770,611 | 71,124,602 B | 178,720,768 B | MIT ([ecdict/LICENSE](ecdict/LICENSE)) |
| `spanish-wiktionary.sqlite.gz` (Kaikki/Wiktionary, English glosses) | 770,716 | 70,438,772 B | 437,243,904 B | CC BY-SA 4.0 ([spanish-wiktionary/LICENSE](spanish-wiktionary/LICENSE)) |

SHA-256 of the release files:

- `ecdict.sqlite.gz`: `3873c59041b76bbf2766006777ff84738527b0a9ac2897f9896b2c93694fc5d4`
- `spanish-wiktionary.sqlite.gz`: `ca547e7179d951b88dd7bb97623befe9a1bb5556b061c2346ca03d212033ba26`

The Spanish package embeds the word-frequency ranks used by the Spanish 词库
categories (`langlsrw_frequency` table, `frequency_version` 2026.09.28, 17,458
lemmas from doozan/spanish_data, CC BY-SA 3.0), so no rank file is fetched at runtime.

The metadata shown in Settings (version, sizes, entry counts) lives in
`src/dictionary/dictionary-service.js`; update it together with a new release.

## Building

Sources stay outside the repository (`../third-party/`). Outputs go to the
git-ignored `build/dictionaries/`:

```text
npm run build:dictionary      # tools/build-ecdict.py      (ECDICT_SOURCE_DIR overrides ../third-party/ECDICT-master)
npm run build:dictionary:es   # build-spanish-dictionary.py + build-spanish-frequency.py + embed-spanish-frequency.py
```

Publish the `.sqlite.gz` files as assets of a release whose tag does **not** start
with `v` (e.g. `dictionaries-YYYY.MM`). Only `v*` releases deploy the site.

`../third-party/Spanish/spa-eng/spa.txt` is not a dictionary source; it is a
Tatoeba sentence list and belongs to sentence-library tooling.
