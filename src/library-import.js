// Parsing imported sentence files and merging them into libraries. Pure
// functions (no DOM), loaded by the page and by node tests
// (tests/library-import.test.js).
//
// Accepted text formats, detected per file:
//   pipe   "sentence | translation" per line (the recommended format)
//   tsv    "sentence<TAB>translation" or "id<TAB>sentence<TAB>translation"
//   lrc    lyrics with [mm:ss] timestamps
//   lines  one sentence per line; a Chinese line right after a sentence is
//          taken as its translation; "a => 中文" style pairs also work
// Lines starting with "#" are comments in pipe and lines files.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.langLSRWLibraryImport = api;
})(typeof self !== "undefined" ? self : this, function () {
  const TRANSLATION_SEPARATOR = " / ";

  // Two sentences are duplicates when they differ only in case or spacing.
  function sentenceKey(text) {
    return String(text || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function splitTranslations(translation) {
    return String(translation || "").split(TRANSLATION_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  }

  function mergeTranslations(current, incoming) {
    const merged = splitTranslations(current);
    splitTranslations(incoming).forEach((part) => {
      if (!merged.includes(part)) merged.push(part);
    });
    return merged.join(TRANSLATION_SEPARATOR);
  }

  // Merge incoming sentences into existing ones. On a duplicate sentence:
  //   merge   – add the new translation(s) to the existing ones (default)
  //   keep    – keep the existing item unchanged
  //   replace – use the new translation when it is not empty
  // New sentences are appended in order and get the next numeric id.
  function mergeItems(existing, incoming, { duplicates = "merge" } = {}) {
    const items = (existing || []).map((item) => ({ ...item }));
    const byKey = new Map(items.map((item) => [sentenceKey(item.text), item]));
    let nextId = items.reduce((max, item) => Math.max(max, /^\d+$/.test(item.id || "") ? Number(item.id) : 0), 0) + 1;
    const report = { added: 0, duplicates: 0, translationsUpdated: 0 };

    (incoming || []).forEach((item) => {
      const text = String(item?.text || "").trim();
      if (!text) return;
      const translation = String(item.translation || "").trim();
      const key = sentenceKey(text);
      const current = byKey.get(key);
      if (!current) {
        const created = { id: String(nextId), text, translation };
        nextId += 1;
        items.push(created);
        byKey.set(key, created);
        report.added += 1;
        return;
      }
      report.duplicates += 1;
      const updated = duplicates === "replace"
        ? (translation || current.translation)
        : duplicates === "merge" ? mergeTranslations(current.translation, translation) : current.translation;
      if (updated !== current.translation) {
        current.translation = updated;
        report.translationsUpdated += 1;
      }
    });
    return { items, ...report };
  }

  function stripBom(text) {
    return String(text || "").replace(/^﻿/, "");
  }

  function nonEmptyLines(text) {
    return stripBom(text).split(/\r?\n/).filter((line) => line.trim());
  }

  function hasCjk(text) {
    return /[㐀-鿿]/.test(text || "");
  }

  function cleanSentenceLine(line) {
    return line.replace(/^\s*\d+[\).]\s+/, "").trim();
  }

  function cleanLrcLine(line) {
    const trimmed = line.trim();
    if (!trimmed || /^\[(ti|ar|al|by|offset|length|re):/i.test(trimmed)) return "";
    return trimmed
      .replace(/(?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+/g, "")
      .replace(/^\s*[-–—]\s*/, "")
      .trim();
  }

  // "sentence | translation" — splits at the first "|" (or "||"); more "|" stay
  // in the translation.
  function splitPipe(line) {
    const index = line.indexOf("|");
    if (index < 0) return null;
    const text = line.slice(0, index).trim();
    const translation = line.slice(index + (line[index + 1] === "|" ? 2 : 1)).trim();
    return text ? { text, translation } : null;
  }

  function splitInlineTranslation(line) {
    const patterns = [
      /^(.+?)\s*(?:\t|=>|->|：|:)\s*([㐀-鿿].*)$/,
      /^(.+?)\s{2,}([㐀-鿿].*)$/
    ];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && match[1].trim() && match[2].trim()) return { text: match[1].trim(), translation: match[2].trim() };
    }
    return null;
  }

  // Tab-separated. hasIdColumn: true for our own Drive files (never guessed, so
  // a download round-trips exactly); undefined for imports, where it is detected.
  function parseTsvLibrary(text, { hasIdColumn } = {}) {
    const rows = nonEmptyLines(text)
      .map((line) => line.split("\t").map((column) => column.trim()))
      .filter((columns) => columns.length >= 2 && columns.some(Boolean));
    const withId = hasIdColumn ?? detectIdColumn(rows);
    const byText = new Map();
    rows.forEach((columns) => {
      const [id, sentence, translation] = withId ? columns : ["", columns[0], columns[1]];
      if (!sentence) return;
      const existing = byText.get(sentence);
      if (!existing) byText.set(sentence, { id: id || "", text: sentence, translation: translation || "" });
      else existing.translation = mergeTranslations(existing.translation, translation);
    });
    return [...byText.values()];
  }

  function detectIdColumn(rows) {
    const sample = rows.slice(0, 200);
    const numericFirst = sample.filter((columns) => columns.length >= 3 && /^\d+$/.test(columns[0])).length;
    return sample.length > 0 && numericFirst >= sample.length * 0.8;
  }

  function detectFormat(text, filename = "") {
    const lines = nonEmptyLines(text).filter((line) => !line.trim().startsWith("#")).slice(0, 300);
    if (!lines.length) return "lines";
    if (lines.filter((line) => line.includes("\t")).length >= lines.length * 0.8) return "tsv";
    if (lines.filter((line) => line.includes("|")).length >= lines.length * 0.5) return "pipe";
    if (/\.lrc$/i.test(filename) || lines.some((line) => /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(line))) return "lrc";
    return "lines";
  }

  function parseLines(text, format) {
    const items = [];
    let skipped = 0;
    nonEmptyLines(text).forEach((raw) => {
      if (format !== "lrc" && raw.trim().startsWith("#")) return;
      const line = format === "lrc" ? cleanLrcLine(raw) : cleanSentenceLine(raw);
      if (!line) return;
      const pair = format === "pipe" ? splitPipe(line) : (splitPipe(line) || splitInlineTranslation(line));
      if (pair) {
        items.push(pair);
        return;
      }
      if (line.startsWith("|")) {
        // "| translation" with no sentence: nothing to practise.
        skipped += 1;
        return;
      }
      if (format === "pipe") {
        // A line without "|" in a pipe file is a sentence with no translation.
        items.push({ text: line, translation: "" });
        return;
      }
      if (hasCjk(line)) {
        const previous = items[items.length - 1];
        if (previous && !previous.translation) previous.translation = line;
        else skipped += 1;
        return;
      }
      items.push({ text: line, translation: "" });
    });
    return { items, skipped };
  }

  // Parse an imported file. Duplicates inside the file are merged (their
  // translations combined) so the preview already shows unique sentences.
  function parseImport(text, filename = "") {
    const format = detectFormat(text, filename);
    const parsed = format === "tsv" ? { items: parseTsvLibrary(text), skipped: 0 } : parseLines(text, format);
    const merged = mergeItems([], parsed.items, { duplicates: "merge" });
    return {
      format,
      items: merged.items,
      duplicatesInFile: merged.duplicates,
      skipped: parsed.skipped,
      translated: merged.items.filter((item) => item.translation).length
    };
  }

  // Swap practice sentence and translation (e.g. practise Spanish from an
  // English | Spanish file). Items without a translation cannot be swapped.
  function swapColumns(items) {
    return items
      .filter((item) => item.translation)
      .map((item) => ({ ...item, text: item.translation, translation: item.text }));
  }

  // Export in the recommended pipe format; "|" inside a sentence becomes "｜"
  // so the file re-imports cleanly.
  function toPipeText(items) {
    const clean = (value) => String(value || "").replace(/[\r\n]+/g, " ").replace(/\|/g, "｜").trim();
    return items.map((item) => (item.translation ? `${clean(item.text)} | ${clean(item.translation)}` : clean(item.text))).join("\n") + "\n";
  }

  // ---- Spreadsheets (Google Sheets rows) ----------------------------------
  const HEADER_WORDS = /^(english|spanish|español|french|german|italian|portuguese|chinese|中文|汉语|英文|英语|西语|西班牙语|法语|德语|日语|翻译|译文|中文翻译|句子|原文|例句|单词|短语|意思|释义|sentence|sentences|translation|meaning|front|back|word|phrase|text|source|target|en|es|zh|fr|de|it|pt)$/i;

  // Pick the two fullest columns and guess whether row 1 is a header.
  function guessSheetLayout(rows) {
    const width = Math.max(0, ...rows.map((row) => row.length));
    const filled = Array.from({ length: width }, (_, column) => ({
      column,
      count: rows.filter((row) => String(row[column] ?? "").trim()).length
    })).filter((entry) => entry.count > 0);
    const [first, second] = filled.slice().sort((a, b) => b.count - a.count || a.column - b.column);
    const columns = [first?.column ?? 0, second?.column ?? -1].sort((a, b) => (a < 0) - (b < 0) || a - b);
    // Only the two chosen columns decide: other columns (notes…) can say anything.
    const header = columns
      .filter((column) => column >= 0)
      .map((column) => String(rows[0]?.[column] ?? "").trim())
      .filter(Boolean);
    return {
      textColumn: columns[0],
      translationColumn: columns[1],
      hasHeader: header.length > 0 && header.every((cell) => HEADER_WORDS.test(cell))
    };
  }

  // Rows -> library items. translationColumn -1 means "no translation".
  function rowsToItems(rows, { textColumn = 0, translationColumn = 1, hasHeader = false } = {}) {
    let skipped = 0;
    const items = [];
    (rows || []).slice(hasHeader ? 1 : 0).forEach((row) => {
      const text = String(row?.[textColumn] ?? "").replace(/\s+/g, " ").trim();
      if (!text) {
        if ((row || []).some((cell) => String(cell ?? "").trim())) skipped += 1;
        return;
      }
      const translation = translationColumn >= 0 ? String(row?.[translationColumn] ?? "").replace(/\s+/g, " ").trim() : "";
      items.push({ text, translation });
    });
    const merged = mergeItems([], items, { duplicates: "merge" });
    return {
      format: "sheet",
      items: merged.items,
      duplicatesInFile: merged.duplicates,
      skipped,
      translated: merged.items.filter((item) => item.translation).length
    };
  }

  // https://docs.google.com/spreadsheets/d/<id>/edit?gid=<gid>#gid=<gid>, or a bare id.
  function parseSheetUrl(value) {
    const text = String(value || "").trim();
    const id = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] || (/^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : "");
    const gid = text.match(/[#?&]gid=(\d+)/)?.[1] ?? "";
    return id ? { id, gid } : null;
  }

  // A library's sheet link, compact enough for a Drive appProperty (124 bytes).
  function encodeSheetLink(sheet) {
    if (!sheet?.id) return "";
    return [sheet.id, sheet.gid ?? "", sheet.textColumn ?? 0, sheet.translationColumn ?? 1, sheet.hasHeader ? 1 : 0].join("|");
  }

  function decodeSheetLink(value) {
    const [id, gid, textColumn, translationColumn, hasHeader] = String(value || "").split("|");
    if (!id) return null;
    return { id, gid: gid || "", textColumn: Number(textColumn) || 0, translationColumn: Number(translationColumn ?? 1), hasHeader: hasHeader === "1" };
  }

  return {
    guessSheetLayout,
    rowsToItems,
    parseSheetUrl,
    encodeSheetLink,
    decodeSheetLink,
    sentenceKey,
    mergeTranslations,
    mergeItems,
    parseTsvLibrary,
    detectFormat,
    parseImport,
    swapColumns,
    toPipeText
  };
});
