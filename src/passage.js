// Passage text for the 读 page. Pure functions (no DOM), loaded by the page and by
// node tests (tests/passage.test.js).
//
// A passage is a title plus a body, stored per learning language. The reader
// splits the body into sentences so each one can be highlighted and read aloud.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.langLSRWPassage = api;
})(typeof self !== "undefined" ? self : this, function () {
  const TITLE_LIMIT = 120;
  const BODY_LIMIT = 100000;
  const NOTE_LIMIT = 20000;
  const HIGHLIGHT_COUNT = 6;
  // Periods inside these tokens are not sentence ends (Mr. Smith, U.S., 3.14, e.g.).
  const ABBREVIATION = /\b(?:mr|mrs|ms|dr|prof|sr|sra|srta|st|jr|vs|etc|approx|aprox)\./gi;
  const INITIALS = /\b(?:[A-Za-z]\.){2,}/g;
  const DOTTED = /\b(?:e\.g|i\.e|p\.ej|u\.s|u\.k)\./gi;

  function createPassageId() {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function cleanTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, TITLE_LIMIT);
  }

  function cleanBody(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
  }

  // null when the title or body is empty, or the body is over the size limit.
  function normalizePassage(input = {}) {
    const title = cleanTitle(input.title);
    const body = cleanBody(input.body);
    const languageId = input.languageId === "es" ? "es" : "en";
    if (!title || !body) return null;
    if (body.length > BODY_LIMIT) return { error: "too-long", languageId };
    return { title, body, languageId };
  }

  function normalizeNote(value) {
    return String(value || "").slice(0, NOTE_LIMIT);
  }

  // Hide periods that must not end a sentence, then split. The placeholder is
  // restored in each sentence so the text the learner sees is unchanged.
  function shieldPeriods(text) {
    return text
      .replace(INITIALS, (match) => match.replaceAll(".", "\u0001"))
      .replace(DOTTED, (match) => match.replaceAll(".", "\u0001"))
      .replace(ABBREVIATION, (match) => match.replaceAll(".", "\u0001"))
      .replace(/(\d)\.(\d)/g, "$1\u0001$2");
  }

  function restorePeriods(text) {
    return text.replaceAll("\u0001", ".");
  }

  function splitParagraph(paragraph) {
    const shielded = shieldPeriods(paragraph.replace(/\.{3,}/g, "…"));
    const sentences = [];
    let start = 0;
    for (let i = 0; i < shielded.length; i += 1) {
      const char = shielded[i];
      if (char !== "." && char !== "!" && char !== "?" && char !== "…") continue;
      let end = i + 1;
      while (end < shielded.length && /["”'’»)\]]/.test(shielded[end])) end += 1;
      let next = end;
      while (next < shielded.length && /\s/.test(shielded[next])) next += 1;
      if (next <= end) continue;
      if (next < shielded.length && !/[\p{L}\p{N}"“«¿¡(\[]/u.test(shielded[next])) continue;
      const sentence = restorePeriods(shielded.slice(start, end)).trim();
      if (sentence) sentences.push(sentence);
      start = next;
      i = next - 1;
    }
    const tail = restorePeriods(shielded.slice(start)).trim();
    if (tail) sentences.push(tail);
    return sentences;
  }

  // Sentences in reading order. `paragraph` groups sentences that were separated
  // by a blank line, so the reader can keep paragraph breaks.
  function splitSentences(text) {
    const source = cleanBody(text);
    if (!source) return [];
    const paragraphs = source
      .split(/\n[ \t]*\n+/)
      .map((paragraph) => paragraph.replace(/[ \t]*\n[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ").trim())
      .filter(Boolean);
    const sentences = [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      splitParagraph(paragraph).forEach((sentence) => {
        sentences.push({ text: sentence, paragraph: paragraphIndex });
      });
    });
    return sentences;
  }

  function highlightIndex(index) {
    const value = Number(index) || 0;
    return ((value % HIGHLIGHT_COUNT) + HIGHLIGHT_COUNT) % HIGHLIGHT_COUNT;
  }

  return {
    TITLE_LIMIT,
    BODY_LIMIT,
    NOTE_LIMIT,
    HIGHLIGHT_COUNT,
    createPassageId,
    normalizePassage,
    normalizeNote,
    splitSentences,
    highlightIndex
  };
});
