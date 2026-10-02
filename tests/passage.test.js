const assert = require("node:assert/strict");
const { test } = require("node:test");
const passage = require("../src/passage.js");

const texts = (body) => passage.splitSentences(body).map((item) => item.text);

test("splits on sentence punctuation and keeps the closing mark", () => {
  assert.deepEqual(texts("Hello world. This is a test! Really?"), [
    "Hello world.",
    "This is a test!",
    "Really?"
  ]);
});

test("does not split abbreviations, initials, or decimals", () => {
  assert.deepEqual(texts("Mr. Smith went home. He was tired."), [
    "Mr. Smith went home.",
    "He was tired."
  ]);
  assert.deepEqual(texts("The U.S. policy changed. Next."), [
    "The U.S. policy changed.",
    "Next."
  ]);
  assert.deepEqual(texts("Pi is 3.14 here. Then stop."), [
    "Pi is 3.14 here.",
    "Then stop."
  ]);
  assert.deepEqual(texts("See e.g. this note. Done."), [
    "See e.g. this note.",
    "Done."
  ]);
});

test("splits Spanish sentences, including inverted punctuation", () => {
  assert.deepEqual(texts("¿Dónde está el baño? ¡Hola! Bien."), [
    "¿Dónde está el baño?",
    "¡Hola!",
    "Bien."
  ]);
  assert.deepEqual(texts("La Sra. García llegó. Después salió."), [
    "La Sra. García llegó.",
    "Después salió."
  ]);
});

test("a sentence without a stop, and ellipsis, stay readable", () => {
  assert.deepEqual(texts("Just one line"), ["Just one line"]);
  assert.deepEqual(texts("Wait... Really? Yes."), ["Wait…", "Really?", "Yes."]);
});

test("blank lines start a new paragraph; single newlines stay in the sentence", () => {
  const sentences = passage.splitSentences("First line\nstill first.\n\nSecond paragraph.");
  assert.deepEqual(sentences.map((item) => item.text), ["First line still first.", "Second paragraph."]);
  assert.deepEqual(sentences.map((item) => item.paragraph), [0, 1]);
});

test("quotes after a stop stay with the sentence", () => {
  assert.deepEqual(texts('He said "Go." Then he left.'), ['He said "Go."', "Then he left."]);
});

test("normalizePassage trims, picks the language, and rejects empty or huge bodies", () => {
  assert.equal(passage.normalizePassage({ title: "  ", body: "Hi." }), null);
  assert.equal(passage.normalizePassage({ title: "Title", body: "  \n" }), null);
  assert.deepEqual(passage.normalizePassage({ title: "  Hola  ", body: "¿Qué?\n", languageId: "es" }), {
    title: "Hola",
    body: "¿Qué?",
    languageId: "es"
  });
  assert.equal(passage.normalizePassage({ title: "T", body: "Hi.", languageId: "fr" }).languageId, "en");
  const huge = passage.normalizePassage({ title: "T", body: "a".repeat(passage.BODY_LIMIT + 1) });
  assert.equal(huge.error, "too-long");
});

test("notes are capped and highlight colours cycle", () => {
  assert.equal(passage.normalizeNote("x".repeat(passage.NOTE_LIMIT + 5)).length, passage.NOTE_LIMIT);
  assert.equal(passage.highlightIndex(0), 0);
  assert.equal(passage.highlightIndex(6), 0);
  assert.equal(passage.highlightIndex(7), 1);
});
