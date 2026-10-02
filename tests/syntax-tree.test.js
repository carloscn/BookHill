// Real spaCy parses (tests/fixtures/spacy-parses.json, produced by
// services/parser with en_core_web_sm / es_core_news_sm 3.8.0) turned into
// sentence components. Regenerate the fixtures only together with a model
// upgrade, and re-check these expectations when you do.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const syntax = require("../src/syntax-tree.js");
const fixtures = require("./fixtures/spacy-parses.json");

const tree = (lang, sentence) => syntax.build(fixtures[lang][sentence]);
const top = (result) => result.nodes.filter((node) => node.parent === 0).map((node) => `${node.role}:${node.text}`);
const childrenOf = (result, text) => {
  const parent = result.nodes.find((node) => node.text === text);
  return result.nodes.filter((node) => node.parent === parent.id).map((node) => `${node.role}·${node.type}:${node.text}`);
};
const find = (result, text) => result.nodes.find((node) => node.text === text);

test("every tree is well formed: known roles, children inside parents, text from the sentence", () => {
  const roles = new Set(["主语", "谓语", "宾语", "表语", "补语", "定语", "状语", "同位语", "中心语", "其他"]);
  for (const lang of ["en", "es"]) {
    for (const [sentence, parse] of Object.entries(fixtures[lang])) {
      const result = syntax.build(parse);
      assert.equal(result.convention, "syntax-parser/1");
      assert.equal(result.schemaVersion, 2);
      const byId = new Map(result.nodes.map((node) => [node.id, node]));
      result.nodes.forEach((node) => {
        assert.ok(roles.has(node.role), `${sentence}: role ${node.role}`);
        assert.ok(sentence.includes(node.text), `${sentence}: "${node.text}" is not a substring`);
        if (node.parent) assert.ok(byId.get(node.parent).text.includes(node.text), `${sentence}: "${node.text}" outside its parent`);
      });
    }
  }
});

test("English: subject, predicate with tense, object, adverbial", () => {
  const result = tree("en", "The experienced engineer fixed the problem quickly.");
  assert.deepEqual(top(result), ["主语:The experienced engineer", "谓语:fixed", "宾语:the problem", "状语:quickly"]);
  assert.equal(result.pattern, "主语 + 谓语 + 宾语 + 状语");
  assert.equal(find(result, "fixed").type, "一般过去时");
  assert.deepEqual(childrenOf(result, "The experienced engineer"), ["定语·冠词:The", "定语·形容词:experienced", "中心语·名词:engineer"]);
  assert.equal(result.status, "complete");
});

test("English: the whole verb group is the predicate", () => {
  const result = tree("en", "She has been leading the team since January.");
  assert.equal(find(result, "has been leading").role, "谓语");
  assert.equal(find(result, "has been leading").type, "现在完成进行时");
  assert.deepEqual(childrenOf(result, "since January"), ["其他·介词:since", "宾语·介词宾语:January"]);
  assert.equal(tree("en", "I don't like coffee.").nodes.find((node) => node.role === "谓语").text, "don't like");
  assert.equal(find(tree("en", "If it rains tomorrow, we will stay at home."), "will stay").type, "一般将来时");
});

test("English: formal subject, there be, passive", () => {
  const formal = tree("en", "It was surprising that he left.");
  assert.equal(formal.pattern, "形式主语 + 谓语 + 表语 + 后置主语从句");
  assert.equal(find(formal, "that he left").type, "后置主语从句");
  assert.equal(find(formal, "surprising").role, "表语");

  const thereBe = tree("en", "There is a book on the table.");
  assert.equal(find(thereBe, "There").type, "引导词");
  assert.equal(thereBe.pattern.startsWith("There be"), true);

  const passive = tree("en", "The letter was written by my grandmother.");
  assert.equal(find(passive, "was written").type, "一般过去时（被动）");
  assert.equal(find(passive, "by my grandmother").note, "引出动作的执行者");
});

test("English: clauses and objects", () => {
  const relative = tree("en", "The man who called you yesterday is my brother.");
  assert.equal(find(relative, "who called you yesterday").type, "定语从句");
  assert.equal(find(relative, "who").type, "关系代词");
  assert.equal(find(relative, "my brother").role, "表语");

  assert.equal(find(tree("en", "If it rains tomorrow, we will stay at home."), "If it rains tomorrow").type, "条件状语从句");

  const question = tree("en", "Could you tell me where the station is?");
  assert.equal(find(question, "where the station is").type, "宾语从句");
  assert.equal(find(question, "where").type, "连接副词");
  assert.equal(question.status, "partial", "inverted auxiliary is not contiguous with the verb");
  assert.equal(find(question, "Could").role, "其他");

  const double = tree("en", "She gave her friend a beautiful present.");
  assert.equal(find(double, "her friend").type, "间接宾语");
  assert.equal(find(double, "a beautiful present").type, "直接宾语");

  const complement = tree("en", "They elected him president.");
  assert.deepEqual(top(complement), ["主语:They", "谓语:elected", "宾语:him", "补语:president"]);

  const compound = tree("en", "I came home and my sister cooked dinner.");
  assert.equal(find(compound, "my sister cooked dinner").type, "并列分句");

  assert.equal(tree("en", "Good morning.").pattern, "省略句");

  const imperative = tree("en", "Please close the door.");
  assert.equal(imperative.pattern, "祈使句：谓语 + 宾语");
  assert.equal(find(imperative, "close").type, "祈使句（动词原形）");
  assert.equal(tree("en", "She gave her friend a beautiful present.").pattern.startsWith("祈使句"), false);
});

test("Spanish: progressive, relative clause, copula", () => {
  const progressive = tree("es", "¿Qué estás haciendo?");
  assert.deepEqual(top(progressive), ["宾语:Qué", "谓语:estás haciendo"]);
  assert.equal(find(progressive, "estás haciendo").type, "现在进行时");
  assert.equal(find(progressive, "Qué").type, "疑问代词");

  const copula = tree("es", "El libro que compré es muy interesante.");
  assert.deepEqual(top(copula), ["主语:El libro que compré", "谓语:es", "表语:muy interesante"]);
  assert.equal(find(copula, "que compré").type, "定语从句");
  assert.equal(find(copula, "que").type, "关系代词");
  assert.equal(find(copula, "compré").type, "简单过去时");
});

test("Spanish: conditional clause, future (despite the model), prepositional phrases", () => {
  const conditional = tree("es", "Si llueve mañana, nos quedaremos en casa.");
  assert.equal(find(conditional, "Si llueve mañana").type, "条件状语从句");
  assert.equal(find(conditional, "nos quedaremos").type, "将来时", "the model tags quedaremos as present");
  assert.deepEqual(childrenOf(conditional, "en casa"), ["其他·介词:en", "宾语·介词宾语:casa"]);
  assert.equal(find(conditional, "en casa").type, "介词短语");
});

test("Spanish: clitic indirect object, modal, passive agent", () => {
  const modal = tree("es", "¿Me puedes recomendar un restaurante?");
  assert.equal(find(modal, "Me").type, "间接宾语");
  assert.equal(find(modal, "un restaurante").type, "直接宾语");
  assert.equal(find(modal, "puedes recomendar").type, "情态动词 + 不定式");

  const passive = tree("es", "La carta fue escrita por mi abuela.");
  assert.equal(find(passive, "fue escrita").type, "简单过去时（被动）");
  assert.equal(find(passive, "por mi abuela").role, "状语");
  assert.equal(find(passive, "por mi abuela").note, "引出动作的执行者");
  assert.equal(tree("es", "Hola.").pattern, "省略句");
});
