"""Choose which caption words get the emphasized look.

Three signals are merged per spoken phrase:

* voice   - prosodic prominence measured in the real audio (caption_emphasis)
* meaning - the stored AI key picks the 1-2 words that carry each sentence
* rules   - an offline Indonesian/English heuristic (numbers, negation,
            intensified words, names, exclamations, long content words)

The AI step is best-effort: without a key, offline, or on any provider error
the rules take its place, so captions never wait on or fail because of it.
Indices returned always point into the ``words`` list that was passed in.
"""

from __future__ import annotations

import logging
import math
import re
from pathlib import Path
from typing import Sequence

from . import caption_emphasis, keys
from .captions import Word
from .laughter import TYPED_LAUGHTER

LOG = logging.getLogger(__name__)

# Function words, pronouns and conversational particles never carry the stress.
STOPWORDS = frozenset("""
yang dan di ke dari ini itu aku kamu dia kami kita mereka saya gue gua gw lu lo elu loe anda engkau
ada adalah untuk dengan juga sih deh dong kok ya yah nah kan tuh nih lah pun tapi tetapi terus trus jadi
kalau kalo kalau-kalau karena karna soalnya biar agar supaya sama atau pada oleh dalam akan sudah udah
udh telah lagi masih bisa mau ingin hanya cuma saja aja doang begitu gitu begini gini kayak kaya seperti
mungkin emang memang yaitu yakni bahwa sebuah seorang para nya si sang tersebut sebagai saat ketika waktu
apa siapa mana kenapa mengapa bagaimana gimana kapan dimana berapa oh eh ah hmm em eem mm ok oke okay iya
yaa ye yo wah wow aduh loh lho the a an and or but so to of in on at for with is are was were be been
it this that these those i you he she we they my your our their me him her them do does did just like
um uh yeah okay well really very makanya pengin pingin mending cuman emang terus kayaknya emm emmm eee ehh hmmm umm uhm anu gitu-gitu
""".split())
NEGATIONS = frozenset("""
bukan tidak tak nggak ngga enggak engga gak ga kagak belum jangan tanpa never not no nothing none
""".split())
# The stress lands on the word these modify, not on the intensifier itself.
INTENSIFY_PREVIOUS = frozenset("banget bgt bener sekali amat parah pol abis kali".split())
INTENSIFY_NEXT = frozenset("paling sangat terlalu super makin semakin amat sungguh benar-benar bener-bener most so".split())
POWER_WORDS = frozenset("""
penting rahasia gratis wajib harus pasti selalu semua pertama terakhir satu-satunya terbaik terburuk
bahaya berbahaya salah benar beda berbeda gagal sukses berhasil kaya miskin mahal murah juta miliar
triliun ribu ratus persen viral gila mustahil langsung sekarang hari rugi untung uang duit cuan
mati hidup cinta takut marah sedih bahagia senang malu bohong jujur nyata fakta mitos ternyata
never always everything everyone secret free money first last best worst wrong right
""".split())
_NUMBER = re.compile(r"\d|^(nol|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|sebelas|seratus|seribu|sejuta)$")
_CLEAN = re.compile(r"[^\w%$€£¥-]+")

AI_SYSTEM = (
    "You mark words for animated short-form video captions (TikTok, Reels, Shorts). "
    "In each sentence pick the one or two words a good editor would visually punch up: "
    "the word carrying the meaning, contrast, number, negation, emotion or punchline. "
    "Prefer the key noun, verb, adjective, number or name. Never pick filler, pronouns, "
    "conjunctions, prepositions, conversational particles (sih, deh, dong, kok, ya, kan, nih) "
    "or laughter. Aim for roughly one word per five to seven words and never more than two "
    "per sentence. Reply with the token indices exactly as numbered."
)
AI_SCHEMA = {
    "type": "object",
    "properties": {"keywords": {"type": "array", "items": {"type": "integer"}}},
    "required": ["keywords"],
    "additionalProperties": False,
}
AI_BATCH = 320


def _key(text: str) -> str:
    return _CLEAN.sub("", text.strip()).casefold().strip("-")


def _eligible(word: Word) -> bool:
    text = word.text.strip()
    label = _key(text)
    return bool(label) and not text.startswith("[") and len(text.split()) == 1 and not TYPED_LAUGHTER.fullmatch(label)


def rule_scores(words: Sequence[Word]) -> dict[int, float]:
    """Score how much each word deserves stress from its text and neighbors."""
    scores: dict[int, float] = {}
    labels = [_key(word.text) for word in words]
    for i, word in enumerate(words):
        label = labels[i]
        if not _eligible(word) or label in INTENSIFY_PREVIOUS or label in INTENSIFY_NEXT:
            continue
        if label in STOPWORDS and label not in NEGATIONS:
            continue
        score = 0.0
        letters = re.sub(r"[^a-zà-ÿ]", "", label)
        if _NUMBER.search(label) or "%" in label or label.startswith(("rp", "$")) and any(c.isdigit() for c in label):
            score += 3.0
        if label in NEGATIONS:
            score += 2.2
        if label in POWER_WORDS:
            score += 2.0
        if i + 1 < len(words) and labels[i + 1] in INTENSIFY_PREVIOUS:
            score += 2.4
        if i > 0 and labels[i - 1] in INTENSIFY_NEXT:
            score += 2.4
        # Superlatives such as "termahal", "tercepat".
        if letters.startswith("ter") and len(letters) >= 7:
            score += .8
        raw = word.text.strip()
        if raw.endswith("!"):
            score += 1.5
        previous = words[i - 1].text.rstrip() if i else "."
        if raw[:1].isupper() and not previous.endswith((".", "?", "!")) and not raw.isupper():
            score += 1.2  # a name in the middle of a sentence
        if len(letters) >= 4:
            score += min(1.4, (len(letters) - 3) * .18)
        if score > 0:
            scores[i] = score
    return scores


def ai_keywords(words: Sequence[Word], language: str | None = None) -> set[int] | None:
    """Ask the stored AI key for keywords. None means "not available, use rules"."""
    if not keys.load():
        return None
    eligible = [i for i, word in enumerate(words) if _eligible(word)]
    if len(eligible) < 2:
        return set()
    chosen: set[int] = set()
    try:
        for begin in range(0, len(eligible), AI_BATCH):
            batch = eligible[begin:begin + AI_BATCH]
            numbered = " ".join(f"[{n}]{words[i].text.strip()}" for n, i in enumerate(batch))
            data = keys.ask_json(
                AI_SYSTEM,
                f"Language: {language or 'unknown'}.\nTokens:\n{numbered}",
                AI_SCHEMA, effort="low", max_tokens=2000,
            )
            for n in data.get("keywords", []):
                if isinstance(n, int) and 0 <= n < len(batch):
                    chosen.add(batch[n])
    except Exception:  # noqa: BLE001 - any provider failure falls back to rules
        LOG.warning("AI caption emphasis unavailable; using offline rules", exc_info=True)
        return None
    return chosen


def _phrases(words: Sequence[Word]) -> list[list[int]]:
    return [[index for index, _ in phrase] for phrase in caption_emphasis._phrases(words)]


def merge(words: Sequence[Word], voice: set[int], meaning: set[int] | None,
          rules: dict[int, float]) -> set[int]:
    """Pick at most ~1 word per 6 (max 2) in every phrase, best evidence first."""
    chosen: set[int] = set()
    for phrase in _phrases(words):
        if not phrase:
            continue
        allowance = 1 if len(phrase) <= 7 else 2
        ranked = []
        for index in phrase:
            label = _key(words[index].text)
            if not _eligible(words[index]) or (label in STOPWORDS and label not in NEGATIONS):
                continue  # a loud "itu" or "dia" still makes a poor highlight
            score = rules.get(index, 0.0)
            in_voice, in_meaning = index in voice, bool(meaning) and index in meaning
            if in_meaning:
                score += 3.0
            if in_voice:
                score += 2.5
            # Without the AI, a rule hit must be convincing on its own.
            convincing = in_meaning or in_voice or rules.get(index, 0) >= (2.0 if meaning is None else 2.6)
            if convincing:
                ranked.append((score, index))
        ranked.sort(reverse=True)
        picks = [index for _, index in ranked[:allowance]]
        if not picks and len(phrase) >= 3 and meaning is None:
            # Keep every readable phrase from looking flat: take its strongest
            # content word if the offline rules found a reasonable one.
            best = max(phrase, key=lambda index: rules.get(index, 0.0))
            if rules.get(best, 0.0) >= 1.0:
                picks = [best]
        chosen.update(picks)
    return chosen


def choose(source: Path | None, words: Sequence[Word], language: str | None = None, *,
           use_ai: bool = True) -> set[int]:
    """Indices of ``words`` to emphasize, from voice, meaning and text rules."""
    if len(words) < 2:
        return set()
    voice = caption_emphasis.detect(source, words) if source is not None else set()
    meaning = ai_keywords(words, language) if use_ai else None
    chosen = merge(words, voice, meaning, rule_scores(words))
    return {index for index in chosen if 0 <= index < len(words) and math.isfinite(words[index].start)}
