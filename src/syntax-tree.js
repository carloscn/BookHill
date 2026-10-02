// Dependency parse (spaCy, via services/parser) -> sentence components in the
// same JSON shape the AI grammar analysis uses (traditional teaching grammar:
// 主语 谓语 宾语 表语 补语 定语 状语 同位语 中心语 其他), so one renderer shows
// both. Pure functions; tested in tests/syntax-tree.test.js with real parses.
//
// English models use ClearNLP labels (nsubj, dobj, attr, prep, pobj …),
// Spanish ones Universal Dependencies (nsubj, obj, obl, case, cop …); both are
// handled. Parses from small models are sometimes wrong, and some structures
// (e.g. inverted auxiliaries) are not contiguous; those come out "partial".
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.langLSRWSyntaxTree = api;
})(typeof self !== "undefined" ? self : this, function () {
  const SUBJECT = new Set(["nsubj", "nsubjpass", "nsubj:pass", "csubj", "csubjpass", "csubj:pass"]);
  const OBJECT = new Set(["dobj", "obj", "dative", "iobj"]);
  const PREDICATE_PART = new Set(["aux", "auxpass", "aux:pass", "neg", "prt", "compound:prt", "expl:pv", "expl:pass", "expl:impers"]);
  const MAX_DEPTH = 4;

  const EN_CLAUSE_KIND = [
    [/^(if|unless|provided|providing)$/, "条件状语从句"],
    [/^(because|since|as)$/, "原因状语从句"],
    [/^(when|while|whenever|before|after|until|till|once|as soon as)$/, "时间状语从句"],
    [/^(although|though|whereas)$/, "让步状语从句"],
    [/^(so|so that|in order that)$/, "目的状语从句"],
    [/^(than)$/, "比较状语从句"],
    [/^(where|wherever)$/, "地点状语从句"]
  ];
  const ES_CLAUSE_KIND = [
    [/^(si)$/, "条件状语从句"],
    [/^(porque|pues|como)$/, "原因状语从句"],
    [/^(cuando|mientras|antes|después|hasta|apenas)$/, "时间状语从句"],
    [/^(aunque)$/, "让步状语从句"],
    [/^(para)$/, "目的状语从句"],
    [/^(donde)$/, "地点状语从句"]
  ];
  const ES_MODALS = new Set(["poder", "deber", "soler", "querer", "tener"]);

  // Spanish future / conditional from the word form. The small model often
  // tags them as present and even mangles the lemma (quedaremos -> "quedarer").
  // Only that mistake is corrected (the model said present or nothing), and
  // only when the stem looks like an infinitive or an irregular future stem
  // (-ar/-er/-ir/-dr/-br/-rr): compré (past) or queremos (present) stay as tagged.
  function spanishTense(token, features) {
    if (features.Tense && features.Tense !== "Pres") return features;
    if (features.Mood && !["Ind", "Cnd"].includes(features.Mood)) return features;
    const word = String(token.text || "").toLowerCase();
    const stem = "(.+(?:ar|er|ir|dr|br|rr))";
    if (new RegExp(`^${stem}(é|ás|á|án|éis)$`).test(word)) return { ...features, Tense: "Fut", Mood: "Ind" };
    if (new RegExp(`^(.+(?:ar|ir|dr|br|rr))emos$`).test(word)) return { ...features, Tense: "Fut", Mood: "Ind" };
    if (features.Mood !== "Cnd" && new RegExp(`^(.+(?:ar|ir|dr|br|rr))(ía|ías|íamos|íais|ían)$`).test(word)) return { ...features, Mood: "Cnd" };
    return features;
  }

  function morphOf(token) {
    const features = {};
    String(token.morph || "").split("|").filter(Boolean).forEach((pair) => {
      const [key, value] = pair.split("=");
      features[key] = value;
    });
    return features;
  }

  function build(parse) {
    const lang = parse.lang;
    const tokens = parse.tokens;
    const full = tokens.map((token) => token.text + token.ws).join("");
    const children = tokens.map(() => []);
    tokens.forEach((token) => {
      if (token.head !== token.i) children[token.head].push(token.i);
    });
    const isPunct = (i) => tokens[i].pos === "PUNCT" || tokens[i].dep === "punct";
    const nodes = [];
    let partial = false;

    function subtree(i) {
      const out = [i];
      children[i].forEach((child) => out.push(...subtree(child)));
      return out.sort((a, b) => a - b);
    }

    // Trim punctuation at the edges; flag gaps (non-projective parses).
    function span(indices) {
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      while (sorted.length && isPunct(sorted[0])) sorted.shift();
      while (sorted.length && isPunct(sorted[sorted.length - 1])) sorted.pop();
      if (!sorted.length) return null;
      for (let k = 1; k < sorted.length; k += 1) {
        if (sorted[k] !== sorted[k - 1] + 1 && !range(sorted[k - 1] + 1, sorted[k]).every(isPunct)) {
          return { indices: sorted, contiguous: false };
        }
      }
      return { indices: sorted, contiguous: true };
    }

    function range(from, to) {
      return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
    }

    function text(indices) {
      const first = tokens[indices[0]];
      const last = tokens[indices[indices.length - 1]];
      return full.slice(first.idx, last.idx + last.text.length);
    }

    function contentCount(indices) {
      return indices.filter((i) => !isPunct(i)).length;
    }

    function addNode({ indices, role, type = "", note = "", parent = 0 }) {
      const node = { id: nodes.length + 1, text: text(indices), role, type, parent, note, start: indices[0] };
      nodes.push(node);
      return node;
    }

    const lower = (i) => tokens[i].text.toLowerCase();
    const lemma = (i) => String(tokens[i].lemma || "").toLowerCase();
    const hasCop = (i) => children[i].some((child) => tokens[child].dep === "cop");
    const isBe = (i) => ["be", "ser", "estar"].includes(lemma(i));

    const inRelativeClause = (i) => ["relcl", "acl:relcl", "acl"].includes(tokens[tokens[i].head].dep);

    function whType(i) {
      const tag = tokens[i].tag;
      const pronType = morphOf(tokens[i]).PronType || "";
      const pronoun = tokens[i].pos === "PRON";
      if (lang === "es") {
        if (pronType.includes("Rel") && inRelativeClause(i)) return pronoun ? "关系代词" : "关系副词";
        if (pronType.includes("Int")) return pronoun ? "疑问代词" : "疑问副词";
        return "";
      }
      if (!["WP", "WDT", "WP$", "WRB"].includes(tag)) return "";
      const adverb = tag === "WRB";
      if (inRelativeClause(i)) return adverb ? "关系副词" : "关系代词";
      if (["ccomp", "csubj", "advcl", "xcomp"].includes(tokens[tokens[i].head].dep)) return adverb ? "连接副词" : "连接代词";
      return adverb ? "疑问副词" : "疑问代词";
    }

    const isEnglishPreposition = (i) => lang === "en" && (tokens[i].pos === "ADP" || ["prep", "agent"].includes(tokens[i].dep))
      && children[i].some((child) => ["pobj", "pcomp"].includes(tokens[child].dep));
    const caseOf = (i) => children[i].filter((child) => tokens[child].dep === "case" && tokens[child].pos === "ADP");

    function phraseType(i, indices) {
      const pos = tokens[i].pos;
      const single = contentCount(indices) === 1;
      const wh = whType(i);
      if (wh) return wh;
      if (isEnglishPreposition(i) || (lang === "es" && caseOf(i).length && !single)) return "介词短语";
      if (pos === "PRON") return "代词";
      if (pos === "PROPN") return single ? "专有名词" : "名词短语";
      if (pos === "NOUN") return single ? "名词" : "名词短语";
      if (pos === "ADJ") return single ? "形容词" : "形容词短语";
      if (pos === "ADV") return single ? "副词" : "副词短语";
      if (pos === "NUM") return "数词";
      if (pos === "ADP") return "介词短语";
      if (pos === "VERB" || pos === "AUX") return "动词短语";
      return "";
    }

    function clauseKind(head) {
      const marks = children[head].filter((child) => tokens[child].dep === "mark").map(lower);
      const table = lang === "es" ? ES_CLAUSE_KIND : EN_CLAUSE_KIND;
      for (const mark of marks) {
        const hit = table.find(([pattern]) => pattern.test(mark));
        if (hit) return hit[1];
      }
      const tag = tokens[head].tag;
      const hasTo = children[head].some((child) => lower(child) === "to" && ["aux", "mark"].includes(tokens[child].dep));
      if (hasTo) return "不定式短语";
      if (lang === "en" && !marks.length && tag === "VBG") return "现在分词短语";
      if (lang === "en" && !marks.length && tag === "VBN") return "过去分词短语";
      if (lang === "es" && morphOf(tokens[head]).VerbForm === "Inf") return "不定式短语";
      return "状语从句";
    }

    function isRelativeClause(head) {
      return children[head].some((child) => {
        const features = morphOf(tokens[child]);
        return features.PronType === "Rel" || ["who", "whom", "which", "that", "whose"].includes(lower(child)) && tokens[child].dep !== "mark";
      });
    }

    // ---- predicate --------------------------------------------------------
    function predicateType(members, head) {
      const head_ = tokens[head];
      if (lang === "es") {
        const auxes = members.filter((i) => i !== head && ["aux", "aux:pass", "cop"].includes(tokens[i].dep));
        const finite = [...auxes, head].find((i) => morphOf(tokens[i]).VerbForm === "Fin") ?? head;
        const features = spanishTense(tokens[finite], morphOf(tokens[finite]));
        const lemmas = auxes.map(lemma);
        if (lemmas.some((l) => ES_MODALS.has(l))) return `情态动词 + 不定式`;
        const perfect = lemmas.includes("haber");
        const progressive = lemmas.includes("estar") && morphOf(head_).VerbForm === "Ger";
        const passive = members.some((i) => tokens[i].dep === "aux:pass") || (lemmas.includes("ser") && morphOf(head_).VerbForm === "Part");
        let name;
        if (features.Mood === "Imp") name = "命令式";
        else if (features.Mood === "Cnd") name = "条件式";
        else if (features.Mood === "Sub") name = `虚拟式${features.Tense === "Past" || features.Tense === "Imp" ? "过去时" : "现在时"}`;
        else if (features.Tense === "Past") name = perfect ? "过去完成时" : "简单过去时";
        else if (features.Tense === "Imp") name = perfect ? "过去完成时" : "过去未完成时";
        else if (features.Tense === "Fut") name = "将来时";
        else if (features.VerbForm === "Inf") name = "不定式";
        else if (features.VerbForm === "Ger") name = "副动词";
        else name = perfect ? "现在完成时" : "现在时";
        if (progressive) name = name.replace(/时$/, "进行时");
        return passive ? `${name}（被动）` : name;
      }
      const auxes = members.filter((i) => i !== head && ["aux", "auxpass"].includes(tokens[i].dep));
      if (auxes.some((i) => lower(i) === "to")) return "不定式";
      const passive = members.some((i) => tokens[i].dep === "auxpass");
      const modal = auxes.find((i) => tokens[i].tag === "MD");
      const future = modal !== undefined && ["will", "shall", "'ll"].includes(lemma(modal) || lower(modal));
      const perfect = auxes.some((i) => lemma(i) === "have") && ["VBN"].includes(tokens[head].tag) || auxes.some((i, k) => lemma(i) === "have" && auxes[k + 1] !== undefined && lower(auxes[k + 1]) === "been");
      const progressive = !passive && tokens[head].tag === "VBG" && auxes.some((i) => lemma(i) === "be");
      const suffix = passive ? "（被动）" : "";
      if (modal !== undefined && !future) return `情态动词 ${lower(modal)} + ${perfect ? "完成式" : "动词原形"}${suffix}`;
      const finite = auxes.find((i) => tokens[i].tag !== "MD") ?? head;
      const tag = tokens[finite].tag;
      const time = future ? "将来" : tag === "VBD" ? "过去" : ["VBZ", "VBP"].includes(tag) ? "现在" : "";
      if (!time) return tokens[head].tag === "VB" ? "动词原形" : "动词";
      const aspect = perfect && progressive ? "完成进行时" : perfect ? "完成时" : progressive ? "进行时" : "";
      return `${aspect ? time : `一般${time}`}${aspect || "时"}${suffix}`;
    }

    function verbFormType(i) {
      if (lang === "es") {
        const features = morphOf(tokens[i]);
        return { Inf: "不定式", Ger: "副动词", Part: "过去分词" }[features.VerbForm] || "动词";
      }
      return { VBD: "过去式", VBN: "过去分词", VBG: "现在分词", VBZ: "动词（第三人称单数）", VBP: "动词", VB: "动词原形" }[tokens[i].tag] || "动词";
    }

    function predicatePartType(i) {
      const dep = tokens[i].dep;
      if (dep === "neg" || ["not", "n't", "no"].includes(lower(i))) return "否定词";
      if (dep === "prt" || dep === "compound:prt") return "副词小品词";
      if (dep.startsWith("expl")) return "代词式动词的代词";
      if (dep === "cop") return "系动词";
      if (dep === "auxpass" || dep === "aux:pass") return "被动助动词";
      if (lang === "es" && lemma(i) === "ser" && morphOf(tokens[tokens[i].head]).VerbForm === "Part") return "被动助动词";
      if (tokens[i].tag === "MD" || (lang === "es" && ES_MODALS.has(lemma(i)))) return "情态动词";
      if (lower(i) === "to") return "不定式符号";
      return "助动词";
    }

    function objectType(child, indices, objects) {
      const base = phraseType(child, indices);
      const plain = base === "形容词" ? "名词" : base; // "aprender español": a noun in this role
      if (objects.length < 2) return plain;
      const deps = objects.map((object) => tokens[object].dep);
      if (["dative", "iobj"].includes(tokens[child].dep)) return "间接宾语";
      if (deps.some((dep) => ["dative", "iobj"].includes(dep))) return "直接宾语";
      // Same label twice (small-model output): a Spanish clitic before the verb is the indirect one.
      if (lang === "es" && tokens[child].pos === "PRON" && child < tokens[child].head && objects.some((object) => object > tokens[child].head)) return "间接宾语";
      if (lang === "es" && objects.some((object) => object !== child && tokens[object].pos === "PRON" && object < tokens[object].head)) return "直接宾语";
      return plain;
    }

    // ---- constituents of a clause ------------------------------------------
    // Returns [{indices, role, type, note, expand}] for the clause headed by
    // `head` (the head itself is placed in the predicate or the predicative).
    function clauseConstituents(head, exclude = new Set()) {
      const out = [];
      const copular = hasCop(head);
      const english = lang === "en";
      const kids = children[head].filter((child) => !exclude.has(child) && !isPunct(child));
      const expletive = kids.find((child) => tokens[child].dep === "expl");
      const thereBe = english && expletive !== undefined && lower(expletive) === "there";
      const formalIt = english && kids.some((child) => SUBJECT.has(tokens[child].dep) && lower(child) === "it")
        && kids.some((child) => ["acomp", "attr"].includes(tokens[child].dep))
        && kids.some((child) => ["ccomp", "xcomp"].includes(tokens[child].dep));

      // Predicate: the verb (or the copula) with its auxiliaries.
      const predicateMembers = copular
        ? kids.filter((child) => tokens[child].dep === "cop" || PREDICATE_PART.has(tokens[child].dep))
        : [head, ...kids.filter((child) => PREDICATE_PART.has(tokens[child].dep))];
      const used = new Set(predicateMembers);
      if (copular) {
        // Predicative = the head and whatever modifies it directly.
        const clausal = new Set(["nsubj", "nsubj:pass", "csubj", "cop", "aux", "aux:pass", "mark", "cc", "conj", "advcl", "parataxis", "obl", "punct", "expl:pv", "expl:pass"]);
        const predicative = [head];
        kids.forEach((child) => {
          if (!clausal.has(tokens[child].dep)) {
            predicative.push(...subtree(child));
            used.add(child);
          }
        });
        out.push({ indices: predicative, role: "表语", type: phraseType(head, predicative), head, expand: "phrase" });
      }
      out.push({ indices: predicateMembers, role: "谓语", type: predicateType(predicateMembers, copular ? predicateMembers.find((i) => tokens[i].dep === "cop") ?? head : head), head, expand: "predicate" });

      const objects = kids.filter((child) => OBJECT.has(tokens[child].dep));
      kids.forEach((child) => {
        if (used.has(child)) return;
        const dep = tokens[child].dep;
        const indices = subtree(child);
        const item = (role, type = phraseType(child, indices), note = "", expand = "phrase") => out.push({ indices, role, type, note, head: child, expand });
        if (dep === "expl") {
          if (thereBe) item("其他", "引导词", "there be 句型");
          else item("主语", "形式主语", "");
        } else if (SUBJECT.has(dep)) {
          if (dep.startsWith("csubj")) item("主语", "主语从句", "", "clause");
          else item("主语", formalIt && lower(child) === "it" ? "形式主语" : phraseType(child, indices), dep.includes("pass") ? "被动句主语" : "");
        } else if (dep === "attr" && thereBe) {
          item("主语", phraseType(child, indices), "there be 句型的真正主语");
        } else if (OBJECT.has(dep) && lang === "es" && caseOf(child).some((c) => lemma(c) !== "a")) {
          const agent = caseOf(child).some((c) => lemma(c) === "por") && /被动/.test(predicateType(predicateMembers, head));
          item("状语", "介词短语", agent ? "引出动作的执行者" : "");
        } else if (OBJECT.has(dep)) {
          item("宾语", objectType(child, indices, objects));
        } else if (dep === "attr" || dep === "acomp") {
          item("表语", phraseType(child, indices));
        } else if (dep === "oprd") {
          item("补语", "宾语补足语");
        } else if (dep === "ccomp") {
          if (formalIt) item("主语", "后置主语从句", "真正的主语", "clause");
          else if (isBe(head) || copular) item("表语", "表语从句", "", "clause");
          else item("宾语", "宾语从句", "", "clause");
        } else if (dep === "xcomp") {
          const afterObject = objects.some((object) => object < child);
          if (formalIt) item("主语", "后置主语（不定式）", "真正的主语", "clause");
          else if (afterObject) item("补语", "宾语补足语", "", "clause");
          else if (["VERB", "AUX"].includes(tokens[child].pos)) item("宾语", clauseKind(child) === "现在分词短语" ? "动名词短语" : clauseKind(child), "", "clause");
          else item("补语", phraseType(child, indices));
        } else if (dep === "advcl") {
          item("状语", clauseKind(child), "", "clause");
        } else if (dep === "agent" || dep === "obl:agent") {
          item("状语", "介词短语", "引出动作的执行者", "phrase");
        } else if (["prep", "obl", "obl:arg", "obl:tmod", "advmod", "npadvmod", "tmod"].includes(dep)) {
          item("状语", phraseType(child, indices));
        } else if (dep === "mark") {
          item("其他", "从属连词", "", "none");
        } else if (dep === "cc") {
          item("其他", "并列连词", "", "none");
        } else if (dep === "conj") {
          const ownSubject = children[child].some((grand) => SUBJECT.has(tokens[grand].dep));
          if (["VERB", "AUX"].includes(tokens[child].pos) || hasCop(child)) {
            item("其他", ownSubject ? "并列分句" : "并列谓语结构", "", "clause");
          } else {
            item("其他", "并列成分");
          }
        } else if (dep === "parataxis") {
          item("其他", "并列分句", "", "clause");
        } else if (dep === "intj" || dep === "discourse") {
          item("其他", "感叹词", "", "none");
        } else if (dep === "vocative") {
          item("其他", "呼语");
        } else {
          item("其他", phraseType(child, indices));
        }
      });
      return out;
    }

    // ---- phrases -----------------------------------------------------------
    function phraseConstituents(head, members) {
      const out = [];
      const inside = new Set(members);
      const kids = children[head].filter((child) => inside.has(child) && !isPunct(child));
      const english = lang === "en";

      // Preposition phrase, English style: the preposition heads it.
      if (isEnglishPreposition(head)) {
        out.push({ indices: [head], role: "其他", type: "介词", expand: "none" });
        kids.forEach((child) => {
          const indices = subtree(child);
          const dep = tokens[child].dep;
          if (dep === "pobj") out.push({ indices, role: "宾语", type: "介词宾语", head: child, expand: "phrase" });
          else if (dep === "pcomp") out.push({ indices, role: "宾语", type: "介词宾语（动名词/从句）", head: child, expand: "clause" });
          else out.push({ indices, role: "其他", type: phraseType(child, indices), head: child, expand: "phrase" });
        });
        return out;
      }

      // Preposition phrase, UD style: the noun heads it and the preposition is `case`.
      const cases = kids.filter((child) => tokens[child].dep === "case" && tokens[child].pos === "ADP");
      if (!english && cases.length && contentCount(members) > 1) {
        const caseTokens = cases.flatMap(subtree);
        out.push({ indices: caseTokens, role: "其他", type: "介词", expand: "none" });
        const object = members.filter((i) => !caseTokens.includes(i));
        out.push({ indices: object, role: "宾语", type: "介词宾语", head, expand: "phrase", exclude: new Set(cases) });
        return out;
      }

      const modifiers = kids.filter((child) => !["det", "case", "punct"].includes(tokens[child].dep));
      if (!modifiers.length) return out; // e.g. "the problem": nothing worth splitting

      out.push({ indices: [head], role: "中心语", type: phraseType(head, [head]), expand: "none" });
      kids.forEach((child) => {
        const indices = subtree(child);
        const dep = tokens[child].dep;
        const item = (role, type, expand = "phrase", note = "") => out.push({ indices, role, type, head: child, expand, note });
        if (dep === "det") item("定语", ["a", "an", "the", "el", "la", "los", "las", "un", "una", "unos", "unas"].includes(lower(child)) ? "冠词" : "限定词", "none");
        else if (dep === "poss" || dep === "nmod:poss") item("定语", "物主代词/所有格", "phrase");
        else if (dep === "amod") item("定语", phraseType(child, indices));
        else if (dep === "nummod") item("定语", "数词", "none");
        else if (dep === "compound") item("定语", "名词修饰语", "none");
        else if (dep === "prep" || dep === "nmod") item("定语", "介词短语");
        else if (dep === "relcl" || dep === "acl:relcl") item("定语", "定语从句", "clause");
        else if (dep === "acl") item("定语", isRelativeClause(child) ? "定语从句" : clauseKind(child) === "状语从句" ? "定语从句" : clauseKind(child), "clause");
        else if (dep === "appos") item("同位语", phraseType(child, indices));
        else if (dep === "advmod" || dep === "npadvmod") item("状语", phraseType(child, indices), "phrase", "修饰形容词或副词");
        else if (dep === "case") item("其他", "所有格标记", "none");
        else if (dep === "cc") item("其他", "并列连词", "none");
        else if (dep === "conj") item("其他", "并列成分");
        else if (dep === "obl") item("状语", "介词短语");
        else item("其他", phraseType(child, indices));
      });
      return out;
    }

    // ---- tree assembly ------------------------------------------------------
    function place(items, parentId, depth) {
      const placed = items
        .map((item) => ({ ...item, span: span(item.indices) }))
        .filter((item) => item.span)
        .sort((a, b) => a.span.indices[0] - b.span.indices[0]);
      placed.forEach((item) => {
        let runs = [item.span.indices];
        if (!item.span.contiguous) {
          partial = true;
          runs = splitRuns(item.span.indices);
        }
        if (runs.length > 1 && item.role === "谓语") {
          // e.g. "Could you tell": the auxiliary is separated from the verb.
          const headRun = runs.find((run) => run.includes(item.head)) || runs[runs.length - 1];
          runs.forEach((run) => {
            if (run === headRun) {
              const node = addNode({ indices: run, role: "谓语", type: item.type, parent: parentId, note: "助动词前置，与后面的动词共同构成谓语" });
              expandPredicate(node, run, item.head, depth);
            } else {
              addNode({ indices: run, role: "其他", type: predicatePartType(run[0]), parent: parentId, note: "倒装：与后面的动词构成谓语" });
            }
          });
          return;
        }
        runs.forEach((run) => {
          const node = addNode({ indices: run, role: item.role, type: item.type || "", parent: parentId, note: item.note || "" });
          if (depth >= MAX_DEPTH || contentCount(run) < 2 || item.expand === "none") return;
          if (item.expand === "predicate") expandPredicate(node, run, item.head, depth);
          else if (item.expand === "clause") place(clauseConstituents(item.head), node.id, depth + 1);
          else if (item.expand === "phrase") place(phraseConstituents(item.head, item.span.indices.filter((i) => !item.exclude?.has(i))), node.id, depth + 1);
        });
      });
    }

    function splitRuns(indices) {
      const runs = [];
      indices.forEach((i) => {
        const last = runs[runs.length - 1];
        if (last && (i === last[last.length - 1] + 1 || range(last[last.length - 1] + 1, i).every(isPunct))) last.push(i);
        else runs.push([i]);
      });
      return runs;
    }

    function expandPredicate(node, run, head, depth) {
      if (contentCount(run) < 2 || depth >= MAX_DEPTH) return;
      const items = run.filter((i) => !isPunct(i)).map((i) => {
        const main = i === head || (tokens[i].dep === "cop" && !run.includes(head));
        return {
          indices: [i],
          role: main ? "中心语" : "其他",
          type: main ? (tokens[i].dep === "cop" ? "系动词" : verbFormType(i)) : predicatePartType(i),
          expand: "none"
        };
      });
      place(items, node.id, depth + 1);
    }

    // ---- sentences ----------------------------------------------------------
    const sentences = [...new Set(tokens.map((token) => token.sent))];
    const patterns = [];
    sentences.forEach((sentenceIndex) => {
      const sentenceTokens = tokens.filter((token) => token.sent === sentenceIndex).map((token) => token.i);
      const rootIndex = sentenceTokens.find((i) => tokens[i].dep === "ROOT" || tokens[i].head === i);
      if (rootIndex === undefined) return;
      const firstNode = nodes.length;
      const verbal = ["VERB", "AUX"].includes(tokens[rootIndex].pos) || hasCop(rootIndex);
      // English imperative: base-form verb at the root with no subject.
      const imperative = verbal && lang === "en" && tokens[rootIndex].tag === "VB"
        && !children[rootIndex].some((child) => SUBJECT.has(tokens[child].dep) || tokens[child].dep === "expl" || tokens[child].tag === "MD");
      if (verbal) {
        const items = clauseConstituents(rootIndex).map((item) => (imperative && item.role === "谓语"
          ? { ...item, type: "祈使句（动词原形）", note: "省略了主语 you" }
          : item));
        place(items, 0, 1);
      } else {
        // Fragments such as "Good morning." or "Hola.": one component.
        const indices = subtree(rootIndex);
        const type = contentCount(indices) === 1 ? "独词句" : `${phraseType(rootIndex, indices) || "短语"}（省略句）`;
        place([{ indices, role: "其他", type, head: rootIndex, expand: "phrase" }], 0, 1);
      }
      // Anything the parse left uncovered (rare) becomes an "其他" component.
      const covered = new Set();
      nodes.slice(firstNode).forEach((node) => {
        sentenceTokens.forEach((i) => {
          if (tokens[i].idx >= offsetOf(node) && tokens[i].idx < offsetOf(node) + node.text.length) covered.add(i);
        });
      });
      const missing = sentenceTokens.filter((i) => !isPunct(i) && !covered.has(i));
      if (missing.length) {
        partial = true;
        splitRuns(missing).forEach((run) => addNode({ indices: run, role: "其他", type: phraseType(run[0], run), note: "未能自动归类" }));
      }
      const top = nodes.slice(firstNode).filter((node) => node.parent === 0).sort((a, b) => a.start - b.start);
      patterns.push(!verbal ? "省略句" : imperative ? `祈使句：${patternOf(top)}` : patternOf(top));
    });

    function offsetOf(node) {
      return tokens[node.start].idx;
    }

    function patternOf(top) {
      const parts = [];
      top.forEach((node) => {
        if (node.type === "引导词") parts.push("There be");
        else if (node.role === "主语" && node.type === "形式主语") parts.push("形式主语");
        else if (node.role === "主语" && node.type.startsWith("后置主语")) parts.push("后置主语从句");
        else if (node.role !== "其他") parts.push(node.role);
        else if (["并列分句", "并列谓语结构"].includes(node.type)) parts.push(node.type);
      });
      const cleaned = parts.filter((part, k) => part !== "There be" || k === 0 || parts[k - 1] !== "There be");
      return cleaned.join(" + ");
    }

    // Order siblings by position (the renderer keeps array order).
    const ordered = nodes.slice().sort((a, b) => a.parent - b.parent || a.start - b.start);
    return {
      schemaVersion: 2,
      convention: "syntax-parser/1",
      source: parse.model || "",
      status: partial ? "partial" : "complete",
      pattern: patterns.filter(Boolean).join(" ｜ "),
      nodes: ordered.map(({ start, ...node }) => node),
      explanation: []
    };
  }

  return { build };
});
