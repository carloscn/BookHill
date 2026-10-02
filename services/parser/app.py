"""langLSRW syntax parser: spaCy dependency parses for the browser.

POST /api/parse  {"text": "...", "lang": "en" | "es"}
  -> {"lang", "model", "tokens": [{i, text, ws, idx, lemma, pos, tag, dep, head, morph, sent}]}
GET  /api/parse/health

Stateless: nothing is logged or stored. The browser turns the dependency tree
into sentence components (src/syntax-tree.js), so the rules can change without
redeploying this service.
"""
import os
from typing import Literal

import spacy
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

MODELS = {"en": "en_core_web_sm", "es": "es_core_news_sm"}
MAX_CHARS = 500

# NER is not used; excluding it saves memory and time.
NLP = {lang: spacy.load(name, exclude=["ner"]) for lang, name in MODELS.items()}

app = FastAPI(title="langLSRW parser", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.environ.get(
        "ALLOWED_ORIGINS", "https://lang.mltz.tech,http://localhost:8848,http://localhost:8849"
    ).split(",") if origin.strip()],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
    max_age=86400,
)


class ParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    lang: Literal["en", "es"]


def serialize(doc, lang):
    sentence_of = {}
    for index, sentence in enumerate(doc.sents):
        for token in sentence:
            sentence_of[token.i] = index
    return {
        "lang": lang,
        "model": f"{doc.lang_}:{NLP[lang].meta['name']}-{NLP[lang].meta['version']}",
        "tokens": [
            {
                "i": token.i,
                "text": token.text,
                "ws": token.whitespace_,
                "idx": token.idx,
                "lemma": token.lemma_,
                "pos": token.pos_,
                "tag": token.tag_,
                "dep": token.dep_,
                "head": token.head.i,
                "morph": str(token.morph),
                "sent": sentence_of.get(token.i, 0),
            }
            for token in doc
        ],
    }


@app.post("/api/parse")
def parse(request: ParseRequest):
    return serialize(NLP[request.lang](request.text), request.lang)


@app.get("/api/parse/health")
def health():
    return {"ok": True, "models": {lang: nlp.meta["version"] for lang, nlp in NLP.items()}}
