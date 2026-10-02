const assert = require("node:assert/strict");
const { test } = require("node:test");
const lib = require("../src/library-import.js");

const pairs = (items) => items.map((item) => [item.text, item.translation]);

test("pipe format: one sentence per line, | separates the two languages", () => {
  const result = lib.parseImport([
    "# my deck",
    "Hello | 你好",
    "  ¿Qué es eso?|那是什么？  ",
    "Good night || 晚安",
    "a | b | c",
    "No translation here",
    "| orphan translation",
    ""
  ].join("\n"), "deck.txt");
  assert.equal(result.format, "pipe");
  assert.deepEqual(pairs(result.items), [
    ["Hello", "你好"],
    ["¿Qué es eso?", "那是什么？"],
    ["Good night", "晚安"],
    ["a", "b | c"],
    ["No translation here", ""]
  ]);
  assert.equal(result.translated, 4);
});

test("duplicates inside one file are merged, ignoring case and spacing", () => {
  const result = lib.parseImport("Go. | Ve.\ngo.  | Vete.\nGo. | Ve.\nRun! | ¡Corre!", "x.txt");
  assert.deepEqual(pairs(result.items), [["Go.", "Ve. / Vete."], ["Run!", "¡Corre!"]]);
  assert.equal(result.duplicatesInFile, 2);
});

test("other formats are still detected", () => {
  assert.equal(lib.parseImport("1\tHi.\t嗨。\n2\tRun.\t跑。").format, "tsv");
  assert.deepEqual(pairs(lib.parseImport("1\tHi.\t嗨。\n2\tRun.\t跑。").items), [["Hi.", "嗨。"], ["Run.", "跑。"]]);
  const lines = lib.parseImport("Hello.\n你好。\nThanks => 谢谢\n1. Numbered line");
  assert.equal(lines.format, "lines");
  assert.deepEqual(pairs(lines.items), [["Hello.", "你好。"], ["Thanks", "谢谢"], ["Numbered line", ""]]);
  const lrc = lib.parseImport("[ti:Song]\n[00:01.00]First line\n[00:02.50]Second line", "song.lrc");
  assert.equal(lrc.format, "lrc");
  assert.deepEqual(pairs(lrc.items), [["First line", ""], ["Second line", ""]]);
});

test("mergeItems appends new sentences with the next id and reports duplicates", () => {
  const existing = [{ id: "1", text: "Hello", translation: "你好" }, { id: "2", text: "Bye", translation: "" }];
  const incoming = [
    { text: "hello", translation: "您好" },
    { text: "Bye", translation: "再见" },
    { text: "New one", translation: "新的" }
  ];
  const merged = lib.mergeItems(existing, incoming);
  assert.deepEqual(merged.items.map((item) => [item.id, item.text, item.translation]), [
    ["1", "Hello", "你好 / 您好"],
    ["2", "Bye", "再见"],
    ["3", "New one", "新的"]
  ]);
  assert.deepEqual([merged.added, merged.duplicates, merged.translationsUpdated], [1, 2, 2]);
  assert.equal(existing[0].translation, "你好", "input is not mutated");
});

test("mergeItems duplicate modes: keep and replace", () => {
  const existing = [{ id: "1", text: "Hello", translation: "你好" }];
  const incoming = [{ text: "Hello", translation: "哈喽" }, { text: "Hello", translation: "" }];
  assert.equal(lib.mergeItems(existing, incoming, { duplicates: "keep" }).items[0].translation, "你好");
  const replaced = lib.mergeItems(existing, incoming, { duplicates: "replace" });
  assert.equal(replaced.items[0].translation, "哈喽", "an empty translation never wipes one");
  assert.equal(replaced.translationsUpdated, 1);
});

test("re-importing the same file changes nothing", () => {
  const first = lib.parseImport("A | 甲\nB | 乙").items;
  const again = lib.mergeItems(first, lib.parseImport("A | 甲\nB | 乙").items);
  assert.deepEqual([again.added, again.duplicates, again.translationsUpdated], [0, 2, 0]);
  assert.deepEqual(again.items, first);
});

test("swapColumns turns translations into practice sentences", () => {
  const swapped = lib.swapColumns([{ id: "1", text: "Go.", translation: "Ve." }, { id: "2", text: "Only", translation: "" }]);
  assert.deepEqual(pairs(swapped), [["Ve.", "Go."]]);
});

test("toPipeText exports a file that re-imports to the same items", () => {
  const items = [
    { id: "1", text: "A | B", translation: "甲\n乙" },
    { id: "2", text: "No translation", translation: "" }
  ];
  const text = lib.toPipeText(items);
  assert.equal(text, "A ｜ B | 甲 乙\nNo translation\n");
  assert.deepEqual(pairs(lib.parseImport(text).items), [["A ｜ B", "甲 乙"], ["No translation", ""]]);
});

test("sheet: guess the two fullest columns and a header row", () => {
  const rows = [["English", "中文"], ["Hello", "你好"], ["Bye", "再见"]];
  assert.deepEqual(lib.guessSheetLayout(rows), { textColumn: 0, translationColumn: 1, hasHeader: true });
  const noHeader = [["", "Hola", "", "你好"], ["", "Gracias", "", "谢谢"], ["", "Adiós", "note", ""]];
  assert.deepEqual(lib.guessSheetLayout(noHeader), { textColumn: 1, translationColumn: 3, hasHeader: false });
  assert.deepEqual(lib.guessSheetLayout([["Only one column"]]), { textColumn: 0, translationColumn: -1, hasHeader: false });
  const withNotes = [["Español", "中文", "备注"], ["Hola", "你好", ""], ["Gracias", "谢谢", "常用"]];
  assert.equal(lib.guessSheetLayout(withNotes).hasHeader, true, "a notes column does not hide the header");
});

test("sheet: rows become deduplicated items", () => {
  const rows = [["Spanish", "Chinese"], ["Hola", "你好"], ["hola", "哈喽"], ["", "orphan"], ["Gracias", ""], [], ["  Adiós\n", " 再见 "]];
  const result = lib.rowsToItems(rows, { textColumn: 0, translationColumn: 1, hasHeader: true });
  assert.deepEqual(pairs(result.items), [["Hola", "你好 / 哈喽"], ["Gracias", ""], ["Adiós", "再见"]]);
  assert.equal(result.duplicatesInFile, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.format, "sheet");
  const swapped = lib.rowsToItems(rows, { textColumn: 1, translationColumn: 0, hasHeader: true });
  assert.deepEqual(pairs(swapped.items)[0], ["你好", "Hola"]);
});

test("sheet: parse links and round-trip the stored link", () => {
  const url = "https://docs.google.com/spreadsheets/d/1NpnqQ3gmDCTP3mH6JafJwYxVb-dtNc45m6eC79vYsSs/edit?gid=123#gid=123";
  assert.deepEqual(lib.parseSheetUrl(url), { id: "1NpnqQ3gmDCTP3mH6JafJwYxVb-dtNc45m6eC79vYsSs", gid: "123" });
  assert.deepEqual(lib.parseSheetUrl("1NpnqQ3gmDCTP3mH6JafJwYxVb-dtNc45m6eC79vYsSs"), { id: "1NpnqQ3gmDCTP3mH6JafJwYxVb-dtNc45m6eC79vYsSs", gid: "" });
  assert.equal(lib.parseSheetUrl("https://example.com"), null);
  const link = { id: "1NpnqQ3gmDCTP3mH6JafJwYxVb-dtNc45m6eC79vYsSs", gid: "123", textColumn: 2, translationColumn: -1, hasHeader: true };
  const encoded = lib.encodeSheetLink(link);
  assert.ok(Buffer.byteLength(`lsrwSheet${encoded}`) <= 124, "fits a Drive appProperty");
  assert.deepEqual(lib.decodeSheetLink(encoded), link);
});
