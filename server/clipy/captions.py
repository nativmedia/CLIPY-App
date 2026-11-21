"""Timed captions with fixed word anchors, rendered by FFmpeg/libass.

Users pick one *caption font* (a font with its weights and size already tuned,
so font and size are a single choice) and one *caption preset* (an animation
style plus colours). Each style decides how ordinary and emphasized words look,
so a stressed word always reads differently from the rest of the sentence
(bigger, heavier, coloured, boxed or stacked) whatever the font.
"""

from __future__ import annotations

import re
from collections.abc import Set
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

from fontTools.ttLib import TTFont
from PIL import ImageFont


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Chunk:
    words: list[Word]
    start: float
    end: float


DEFAULT_COLOR = "yellow"
DEFAULT_ANIMATION = "clean"
CAPTION_FACE = "plus-jakarta"
BASE_WEIGHT = "bold"
EMPHASIS_WEIGHT = "extra-bold"
FONT_WEIGHTS = {"thin": 100, "regular": 400, "medium": 500, "bold": 700, "extra-bold": 800}
# Font resolution also serves the experimental HyperFrames renderer and older
# saved project settings. Production captions always use CAPTION_FACE.
FONT_WEIGHT_FONTS = frozenset({"jetbrains-mono", "montserrat", "poppins", "plus-jakarta"})
VARIABLE_WEIGHT_FONTS = frozenset({"jetbrains-mono", "montserrat"})
_STATIC_WEIGHTS = {
    "poppins": {100: "Poppins-Thin.ttf", 400: "Poppins-Regular.ttf", 700: "Poppins-Bold.ttf",
                800: "Poppins-ExtraBold.ttf"},
    "plus-jakarta": {500: "PlusJakartaSans-Medium.ttf", 700: "PlusJakartaSans-Bold.ttf",
                     800: "PlusJakartaSans-ExtraBold.ttf"},
}


def font_weight_value(font: str, weight: str) -> int:
    """Translate a supported weight name to ASS/CSS; unsupported faces use regular."""
    if font not in FONT_WEIGHT_FONTS:
        return FONT_WEIGHTS["regular"]
    value = FONT_WEIGHTS.get(weight, FONT_WEIGHTS["regular"])
    files = _STATIC_WEIGHTS.get(font)
    if files and value not in files:
        # Snap to the nearest weight that is really bundled for this face.
        value = min(files, key=lambda available: (abs(available - value), -available))
    return value


def font_file(font: str, weight: str = "regular") -> str:
    """Return the source file that contains this font's real requested weight."""
    files = _STATIC_WEIGHTS.get(font)
    if files:
        return files[font_weight_value(font, weight)]
    return FONT_FILES[font]


# Sentence captions never run past two lines, so viewers can follow them at a glance.
MAX_LINES = 2


@dataclass
class CaptionStyle:
    animation: str = DEFAULT_ANIMATION
    color: str = DEFAULT_COLOR
    case: str = "upper"
    position: int | None = None
    display: str | None = None
    max_lines: int = 2
    font: str = "jakarta"
    # Accepted only so older saved projects still load; the font choice
    # already includes its weights and size.
    font_weight: str = BASE_WEIGHT
    text_style: str = "plain"


# Family names as libass sees them (the TTFs live in server/fonts).
FONTS = {
    "plus-jakarta": ("Plus Jakarta Sans", "Plus Jakarta Sans"),
    "anton": ("Anton", "Anton"),
    "bangers": ("Bangers", "Bangers"),
    "bebas": ("Bebas Neue", "Bebas Neue"),
    "gaegu": ("Gaegu", "Gaegu"),
    "instrument-serif": ("Instrument Serif", "Instrument Serif"),
    "jetbrains-mono": ("JetBrains Mono", "JetBrains Mono"),
    "just-me": ("Just Me Again Down Here", "Just Me Again Down Here"),
    "montserrat": ("Montserrat", "Montserrat"),
    "poppins": ("Poppins", "Poppins"),
}
FONT_FILES = {
    "plus-jakarta": "PlusJakartaSans-Bold.ttf",
    "montserrat": "Montserrat[wght].ttf",
    "anton": "Anton-Regular.ttf",
    "bebas": "BebasNeue-Regular.ttf",
    "poppins": "Poppins-Regular.ttf",
    "bangers": "Bangers-Regular.ttf",
    "just-me": "JustMeAgainDownHere.ttf",
    "instrument-serif": "InstrumentSerif-Regular.ttf",
    "jetbrains-mono": "JetBrainsMono[wght].ttf",
    "gaegu": "Gaegu-Regular.ttf",
}
FONT_DIR = Path(__file__).resolve().parent.parent / "fonts"


@dataclass(frozen=True)
class CaptionFont:
    """One caption font choice: its bundled faces and a tuned size.

    Each face lives in its own file with a unique family name
    ("Clipy <key> <role>"), so libass always draws exactly that file and
    weight instead of guessing between installed faces.
    """
    label: str
    key: str
    size: float
    roles: tuple[str, ...] = ("Soft", "Base", "Strong")

    def role(self, wanted: str) -> str:
        if wanted in self.roles:
            return wanted
        return "Strong" if wanted == "Strong" and "Strong" in self.roles else "Base"

    def file(self, wanted: str) -> str:
        return f"Clipy-{self.key}-{self.role(wanted)}.ttf"

    def family(self, wanted: str) -> str:
        return f"Clipy {self.key} {self.role(wanted)}"


DEFAULT_FONT = "jakarta"
# Sizes are matched by cap height first, then nudged to each font's character
# (condensed and display faces read better a little larger, wide ones smaller).
CAPTION_FONTS = {
    "jakarta": CaptionFont("Jakarta Bold", "Jakarta", 1.0),
    "montserrat": CaptionFont("Montserrat Black", "Montserrat", 1.0),
    "tiktok": CaptionFont("TikTok Sans", "TikTokSans", 1.04),
    "poppins": CaptionFont("Poppins Bold", "Poppins", 1.02),
    "anton": CaptionFont("Anton", "Anton", 1.05, ("Base",)),
    "bebas": CaptionFont("Bebas Neue", "Bebas", 1.33, ("Base",)),
    "unbounded": CaptionFont("Unbounded", "Unbounded", .85),
    "dm-serif": CaptionFont("DM Serif Display", "DMSerif", 1.2, ("Base", "Strong")),
    "bangers": CaptionFont("Bangers", "Bangers", 1.2, ("Base",)),
    "caveat": CaptionFont("Caveat Bold", "Caveat", 1.36),
}
FONT_ALIASES = {
    # Font values saved by earlier releases.
    "plus-jakarta": "jakarta", "instrument-serif": "dm-serif", "gaegu": "caveat",
    "just-me": "caveat", "jetbrains-mono": "jakarta",
}


def normalize_font(font: str | None) -> str:
    font = FONT_ALIASES.get(font or "", font or "")
    return font if font in CAPTION_FONTS else DEFAULT_FONT

ANIMATIONS = {
    "clean": "Clean",
    "marker": "Marker",
    "karaoke": "Karaoke",
    "pop": "Pop",
    "aesthetic": "Aesthetic",
    "headline": "Headline",
    "glow": "Glow",
    "rise": "Fly In",
    "duo": "Serif Accent",
    "script": "Script Accent",
}
ANIMATION_ALIASES = {
    # Styles of earlier releases, kept so saved projects and presets still load.
    "focus": "clean", "highlight": "clean", "underline": "clean",
    "outline": "clean", "word-neon": "glow", "word-3d": "clean", "word-outline": "clean",
    "editorial": "clean", "word-shadow": "clean",
    "pill": "marker", "box": "marker", "word-box": "marker",
    "fade": "aesthetic", "minimal": "aesthetic",
    "reveal": "pop", "word-slide": "pop", "word": "pop", "word-bounce": "pop", "word-punch": "pop",
    "stack": "headline", "supersize": "headline",
    "fly-in": "rise", "float": "rise", "slide-up": "rise",
}


@dataclass(frozen=True)
class StyleSpec:
    base: str            # face role of ordinary words: Soft, Base or Strong
    strong: str          # face role of emphasized words
    strong_scale: float  # emphasized word size relative to the cue size
    plain_scale: float = 1.0
    size: float = 1.0    # whole caption size relative to the layout size
    case: str | None = None
    strong_font: str | None = None  # another caption font for emphasized words


STYLES = {
    "clean": StyleSpec("Base", "Strong", 1.30),
    "marker": StyleSpec("Base", "Strong", 1.08),
    "karaoke": StyleSpec("Base", "Strong", 1.22),
    "pop": StyleSpec("Strong", "Strong", 1.38),
    "aesthetic": StyleSpec("Soft", "Strong", 1.14, size=.88, case="lower"),
    "headline": StyleSpec("Base", "Strong", 1.85, plain_scale=.80),
    "glow": StyleSpec("Base", "Strong", 1.24),
    "rise": StyleSpec("Base", "Strong", 1.26),
    # Emphasized words switch to a contrasting typeface as well as a bigger size.
    "duo": StyleSpec("Base", "Strong", 1.48, strong_font="dm-serif"),
    "script": StyleSpec("Base", "Strong", 1.72, strong_font="caveat"),
}

# When the chosen caption font already is the accent typeface, use this one instead.
ACCENT_FALLBACK = {"dm-serif": "caveat", "caveat": "dm-serif"}


def strong_font_for(spec: StyleSpec, base_key: str) -> str:
    """Caption font key used for emphasized words."""
    if not spec.strong_font:
        return base_key
    return ACCENT_FALLBACK.get(spec.strong_font, "jakarta") if spec.strong_font == base_key else spec.strong_font


def normalize_animation(animation: str) -> str:
    return ANIMATION_ALIASES.get(animation, animation if animation in ANIMATIONS else DEFAULT_ANIMATION)


@lru_cache(maxsize=96)
def _font(font: str, size: int, weight: str = "regular"):
    face = ImageFont.truetype(str(FONT_DIR / font_file(font, weight)), size)
    if font in VARIABLE_WEIGHT_FONTS:
        # Both bundled variable files have one Weight axis, so Pillow measures
        # the exact same glyph weight that is sent to the renderer.
        face.set_variation_by_axes([font_weight_value(font, weight)])
    return face


@lru_cache(maxsize=96)
def _metrics(font: str, weight: str = "regular") -> tuple[float, float, float]:
    """(ASS size per em, descent per em, cap height per em) from the real file."""
    with TTFont(FONT_DIR / font_file(font, weight), lazy=True) as face:
        os2, em = face["OS/2"], face["head"].unitsPerEm
        cap = getattr(os2, "sCapHeight", 0) or .72 * em
        return (os2.usWinAscent + os2.usWinDescent) / em, os2.usWinDescent / em, cap / em


@lru_cache(maxsize=64)
def _file_metrics(filename: str) -> tuple[float, float, float, int]:
    """(ASS size per em, descent per em, cap height per em, weight class)."""
    with TTFont(FONT_DIR / filename, lazy=True) as face:
        os2, em = face["OS/2"], face["head"].unitsPerEm
        cap = getattr(os2, "sCapHeight", 0) or .72 * em
        return ((os2.usWinAscent + os2.usWinDescent) / em, os2.usWinDescent / em, cap / em,
                os2.usWeightClass)


@lru_cache(maxsize=192)
def _file_font(filename: str, size: int):
    return ImageFont.truetype(str(FONT_DIR / filename), size)


def _ass_font_scale(font: str, weight: str = "regular") -> float:
    # ASS sizes refer to the Windows line box; Pillow measures an em at the requested size.
    return _metrics(font, weight)[0]


COLORS = {
    "yellow": "#FFD60A",
    "white": "#FFFFFF",
    "cream": "#FFF1C1",
    "orange": "#FF8A3D",
    "green": "#3CFF6E",
    "cyan": "#33E1FF",
    "pink": "#FF4FD8",
    "red": "#FF3B30",
}
CASES = {"upper": "UPPERCASE", "lower": "lowercase", "title": "Title Case", "sentence": "Sentence case"}

OPTIONS = {
    "fonts": {key: font.label for key, font in CAPTION_FONTS.items()},
    "font_sizes": {key: font.size for key, font in CAPTION_FONTS.items()},
    "font_aliases": FONT_ALIASES,
    "animations": ANIMATIONS,
    "animation_aliases": ANIMATION_ALIASES,
    "colors": COLORS,
    "cases": CASES,
}

# A pause this long (seconds) always starts a new chunk.
BREAK_GAP = 0.45
# How long a chunk may linger after its last word when nothing follows straight away.
LINGER = 0.3
MIN_CHUNK = 0.35
# Row box relative to the largest word on that row: tight, modern leading.
ROW_HEIGHT = 1.18
ROW_BASELINE = .92
MARKER_PAD = .17


@dataclass
class Layout:
    width: int
    height: int
    font_size: int
    baseline: int
    max_words: int
    max_chars: int


def layout_for(width: int, height: int) -> Layout:
    """Scale type with the short edge and keep its default clear of player controls."""
    if width > height:
        return Layout(width, height, round(height * 0.081), round(height * 0.80), 5, 28)
    baseline = 0.71 if height / width > 1.5 else 0.76
    return Layout(width, height, round(width * 0.082), round(height * baseline), 3, 15)


def chunk_words(words: list[Word], max_words: int = 3, max_chars: int = 15, *, sentence: bool = False) -> list[Chunk]:
    """Group words into short chunks, splitting on pauses and punctuation."""
    chunks: list[Chunk] = []
    current: list[Word] = []
    for w in words:
        if current:
            prev = current[-1]
            chars = sum(len(x.text) + 1 for x in current) + len(w.text)
            if (
                len(current) >= max_words
                or chars > max_chars
                or w.start - prev.end > BREAK_GAP
                or re.search(r"[.!?]$" if sentence else r"[.!?;:,]$", prev.text)
            ):
                chunks.append(Chunk(current, current[0].start, current[-1].end))
                current = []
        current.append(w)
    if current:
        chunks.append(Chunk(current, current[0].start, current[-1].end))

    # Let each chunk hang on a moment, but never into the next one.
    for i, c in enumerate(chunks):
        nxt = chunks[i + 1].start if i + 1 < len(chunks) else c.end + LINGER
        c.end = max(c.start + MIN_CHUNK, min(c.end + LINGER, nxt))
        if i + 1 < len(chunks):
            c.end = min(c.end, nxt)
    return chunks


_VOWEL_GROUPS = re.compile(r"[aeiouy]+", re.IGNORECASE)
COARSE_WORD_LEAD = 0.16


def _spoken_weight(token: str) -> float:
    """Estimate spoken duration from syllables, not raw character count."""
    letters = re.sub(r"[^A-Za-zÀ-ÖØ-öø-ÿ]", "", token)
    syllables = len(_VOWEL_GROUPS.findall(letters))
    # Acronyms/numbers still take time to say.  A tiny length component keeps
    # unusually long words from being rushed without delaying every later cue.
    return max(1.0, min(4.5, syllables + max(0, len(letters) - 4) * 0.06))


def expand_coarse_words(words: list[Word]) -> list[Word]:
    """Split cue-level subtitle timing into readable, approximately timed words.

    YouTube's fallback captions sometimes provide a whole spoken passage as one
    ``Word``.  Caption rendering, clipping, and framing all need word-sized
    entries, so distribute that cue's duration by spoken-syllable weight. A
    short, per-word anticipation makes the visual highlight feel aligned with
    speech without applying one global offset. Real word-timed transcripts
    contain one token per entry and pass through unchanged (same objects).
    """
    expanded: list[Word] = []
    for word in words:
        tokens = word.text.split()
        if len(tokens) < 2 or word.end <= word.start:
            expanded.append(word)
            continue
        weights = [_spoken_weight(token) for token in tokens]
        total = sum(weights)
        elapsed = 0
        previous_start = word.start
        for index, (token, weight) in enumerate(zip(tokens, weights)):
            raw_start = word.start + (word.end - word.start) * elapsed / total
            elapsed += weight
            end = word.end if index == len(tokens) - 1 else word.start + (word.end - word.start) * elapsed / total
            # Segment tracks do not expose the true onset of each token. Lead
            # only later words by a fraction of their own estimated duration,
            # so the active word does not visibly trail the speaker.
            lead = 0 if index == 0 else min(COARSE_WORD_LEAD, (end - raw_start) * 0.4)
            start = max(word.start, previous_start, raw_start - lead)
            expanded.append(Word(token, start, end))
            previous_start = start
    # Segment captions can overlap while they are refreshed by YouTube.  Sort
    # the synthesized word starts before a renderer turns them into cues.
    return sorted(expanded, key=lambda entry: (entry.start, entry.end, entry.text.casefold()))


def apply_case(text: str, case: str, first_in_sentence: bool) -> str:
    if case == "upper":
        return text.upper()
    if case == "lower":
        return text.lower()
    if case == "title":
        return text[:1].upper() + text[1:]
    # Sentence case: as transcribed, with the first word of a sentence capitalised.
    return text[:1].upper() + text[1:] if first_in_sentence else text


def display_words(words: list[Word], case: str) -> list[str]:
    out = []
    sentence_start = True
    for w in words:
        # Trending caption style: drop trailing commas/periods, keep ?! for tone.
        text = re.sub(r"[.,;:]+$", "", w.text.strip())
        text = text.replace("\\", "").replace("{", "(").replace("}", ")")
        out.append(apply_case(text, case, sentence_start))
        sentence_start = w.text.rstrip().endswith((".", "?", "!"))
    return out


def ass_color(hex_rgb: str, alpha: int = 0) -> str:
    """Colour as written in a Style line: &HAABBGGRR."""
    r, g, b = hex_rgb[1:3], hex_rgb[3:5], hex_rgb[5:7]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def tag_color(hex_rgb: str) -> str:
    """Colour as written inside an override tag: &HBBGGRR&."""
    return f"&H{hex_rgb[5:7]}{hex_rgb[3:5]}{hex_rgb[1:3]}&".upper()


def _ass_centiseconds(t: float) -> int:
    return round(max(0.0, t) * 100)


def ass_time(t: float) -> str:
    cs = _ass_centiseconds(t)
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


class Item(NamedTuple):
    word: Word
    label: str
    advance: float
    scale: float = 1.0
    strong: bool = False


@dataclass
class CaptionCue:
    rows: list[list[Item]]
    size: int
    line_height: int
    space: float
    start: float
    end: float
    row_heights: list[float] = field(default_factory=list)

    def __post_init__(self):
        if not self.row_heights:
            self.row_heights = [self.line_height] * len(self.rows)


def _caption_cues(words: list[Word], style: CaptionStyle, width: int, height: int, *,
                  emphasized: Set[int] = frozenset(), face: str = CAPTION_FACE,
                  weight: str | None = None) -> list[CaptionCue]:
    """Wrap on stable glyph metrics shared by the video and subtitle exports.

    ``emphasized`` holds indices into ``words``. Emphasized words are measured
    at their real, larger size so line breaks already account for them.
    """
    strong_ids = {id(word) for i, word in enumerate(words) if i in emphasized}
    words = expand_coarse_words(words)
    layout = layout_for(width, height)
    animation = normalize_animation(style.animation)
    spec = STYLES[animation]
    caption_font = CAPTION_FONTS[normalize_font(style.font)]
    accent_font = CAPTION_FONTS[strong_font_for(spec, normalize_font(style.font))]
    legacy = face != CAPTION_FACE
    if legacy:
        # Legacy renderers measure one fixed face and weight with no supersizing.
        spec = StyleSpec(weight or "regular", weight or "regular", 1.0)

    def face_for(role: str, px: int, accent: bool = False):
        if legacy:
            return _font(face, px, role)
        return _file_font((accent_font if accent else caption_font).file(role), px)

    single = style.display == "word" or (style.display is None and style.animation == "word")
    sentence = style.display == "sentence"
    headline = animation == "headline" and not single
    font_size = 1.0 if legacy else caption_font.size
    size = max(1, round(layout.font_size * spec.size * font_size * (1.12 if single else 1)))
    base_font = face_for(spec.base, size)
    limit = width * .84
    max_lines = min(style.max_lines, MAX_LINES) if sentence and not headline else 1
    if single:
        chunks = [Chunk([word], word.start, word.end + LINGER) for word in words]
    elif headline:
        # Short punchy groups so the stressed word can take a row of its own.
        chunks = chunk_words(words, layout.max_words * 2, layout.max_chars * 2)
    elif sentence:
        chunks = chunk_words(words, 60, 360, sentence=True)
    else:
        chunks = chunk_words(words, layout.max_words, layout.max_chars)
    labels = dict(zip(map(id, words), display_words(words, spec.case or style.case)))
    space = max(base_font.getlength(" "), size * .28)
    cues: list[CaptionCue] = []

    def measure(label: str, scale: float, strong: bool) -> tuple[float, float]:
        role = spec.strong if strong else spec.base
        advance = face_for(role, max(1, round(size * scale)), strong).getlength(label)
        if advance > limit:
            scale *= limit / advance
            advance = face_for(role, max(1, round(size * scale)), strong).getlength(label)
        return advance, scale

    def finish(rows: list[list[Item]]):
        rows = [row for row in rows if row]
        if not rows:
            return
        heights = [size * ROW_HEIGHT * max(item.scale for item in row) for row in rows]
        first, last = rows[0][0].word, rows[-1][-1].word
        cues.append(CaptionCue(rows, size, round(size * ROW_HEIGHT), space, first.start,
                               last.end + LINGER, heights))

    for chunk in chunks:
        items: list[Item] = []
        for word in chunk.words:
            label = labels[id(word)]
            if not label:
                continue
            strong = id(word) in strong_ids
            scale = spec.strong_scale if strong else spec.plain_scale
            advance, scale = measure(label, scale, strong)
            if strong and animation == "marker":
                advance += 2 * size * scale * MARKER_PAD  # room for the box
            items.append(Item(word, label, advance, scale, strong))
        if not items:
            continue
        if headline and any(item.strong for item in items) and not all(item.strong for item in items):
            # Stack: words before the stressed word, the stressed word big on
            # its own row, then the rest. Each group wraps on its own.
            groups: list[list[Item]] = []
            for item in items:
                if groups and groups[-1][0].strong == item.strong:
                    groups[-1].append(item)
                else:
                    groups.append([item])
            rows: list[list[Item]] = []
            for group in groups:
                rows.append([])
                row_width = 0.0
                for item in group:
                    if rows[-1] and row_width + space + item.advance > limit:
                        rows.append([])
                        row_width = 0.0
                    row_width += item.advance + (space if rows[-1] else 0)
                    rows[-1].append(item)
            finish(rows)
            continue
        rows = [[]]
        row_width = 0.0
        for item in items:
            if rows[-1] and row_width + space + item.advance > limit:
                if len(rows) == max_lines:
                    finish(rows)
                    rows = [[]]
                else:
                    rows.append([])
                row_width = 0.0
            row_width += item.advance + (space if rows[-1] else 0)
            rows[-1].append(item)
        finish(rows)

    # A rolling subtitle source can produce a later phrase whose estimated
    # word onset comes before an earlier phrase ends.  ASS draws both dialogue
    # events, making the text stack.  Serialize the actual visual cues and
    # drop zero-length fragments rather than rendering unreadable collisions.
    cues.sort(key=lambda cue: (cue.start, cue.end))
    for cue, following in zip(cues, cues[1:]):
        cue.end = min(cue.end, following.start)
    return [cue for cue in cues if cue.end - cue.start >= .01]


def _rounded_box(width: int, height: int, radius: int) -> str:
    r = min(radius, width // 2, height // 2)
    if r <= 0:
        return f"m 0 0 l {width} 0 {width} {height} 0 {height}"
    w, h, k = width, height, round(r * .55)
    return (f"m {r} 0 l {w-r} 0 b {w-r+k} 0 {w} {r-k} {w} {r} "
            f"l {w} {h-r} b {w} {h-r+k} {w-r+k} {h} {w-r} {h} "
            f"l {r} {h} b {r-k} {h} 0 {h-r+k} 0 {h-r} "
            f"l 0 {r} b 0 {r-k} {r-k} 0 {r} 0")


def _contrasting_ink(rgb: str) -> str:
    def linear(channel):
        s = int(channel, 16) / 255
        return s / 12.92 if s <= .04045 else ((s + .055) / 1.055) ** 2.4

    lightness = sum(weight * linear(rgb[i:i+2]) for i, weight in ((1, .2126), (3, .7152), (5, .0722)))
    return "#0A0C12" if lightness >= .179 else "#FFFFFF"


INK = "#0A0C12"


RISE_TIME = .42   # seconds from first frame to landing (ease-outs read best at 200-500 ms)
RISE_STEPS = 7


def _ease_out_back(k: float, overshoot: float = 1.3) -> float:
    k -= 1
    return 1 + (overshoot + 1) * k ** 3 + overshoot * k ** 2


def _alpha_hex(transparency: float) -> str:
    return f"&H{max(0, min(255, round(transparency * 255))):02X}&"


def _shadow_alpha(alpha: str) -> str:
    """Keep the drop shadow softer than the letters while fading in."""
    value = int(alpha[2:4], 16)
    return f"&H{max(0x60, value):02X}&"


def build_ass(words: list[Word], style: CaptionStyle, width: int = 1080, height: int = 1920, *,
              offset: float = 0, emphasized: Set[int] = frozenset()) -> str:
    animation = normalize_animation(style.animation)
    spec = STYLES[animation]
    caption_font = CAPTION_FONTS[normalize_font(style.font)]
    family = caption_font.family(spec.base)
    # Per face: (\fn family, ASS size per em, descent per em, cap height per em, weight).
    accent_font = CAPTION_FONTS[strong_font_for(spec, normalize_font(style.font))]
    faces = {}
    for key, font, role in (("base", caption_font, spec.base), ("strong", accent_font, spec.strong)):
        scale_em, descent_em, cap_em, weight_class = _file_metrics(font.file(role))
        faces[key] = (font.family(role), scale_em, descent_em, cap_em, weight_class)
    accent = COLORS.get(style.color, COLORS[DEFAULT_COLOR])
    # White accents would be invisible as "emphasis" on white text; give them
    # a warm cream instead so the stressed word still reads as different.
    if accent == "#FFFFFF" and animation != "marker":
        accent = COLORS["cream"]
    hi = tag_color(accent)
    white = tag_color("#FFFFFF")
    dark = tag_color(INK)
    marker_ink = tag_color(_contrasting_ink(accent))
    baseline_y = layout_for(width, height).baseline
    center = baseline_y if style.position is None else round(height * (0.17 + (style.position - 1) * 0.11))
    stack_shift = round(height * 0.79) - baseline_y if style.position is None and height > width else 0
    header = f"""[Script Info]
; CLIPY stack shift: {stack_shift}
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{family},40,&H00FFFFFF,&H00FFFFFF,&H00120C0A,&H60120C0A,{faces['base'][4]},0,0,0,100,100,0,0,1,0,0,2,0,0,0,1
Style: Shape,{family},40,&H00FFFFFF,&H00FFFFFF,&H00120C0A,&H60120C0A,{faces['base'][4]},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []

    def emit(start, end, tags, content, *, name="Cap", layer=2):
        start_time, end_time = ass_time(start + offset), ass_time(end + offset)
        if end > start and start_time != end_time:
            events.append(f"Dialogue: {layer},{start_time},{end_time},{name},,0,0,0,,{{{tags}}}{content}")

    def ms(seconds: float) -> int:
        return max(0, round(seconds * 1000))

    for cue in _caption_cues(words, style, width, height, emphasized=emphasized):
        size = cue.size
        total = sum(cue.row_heights)
        top = max(height * .055, min(height * .92 - total, center - total / 2))
        spoken = [item.word for row in cue.rows for item in row]
        next_start = {id(word): following.start for word, following in zip(spoken, spoken[1:])}
        if animation == "aesthetic":
            # Soft but present: a slightly blurred dark rim plus a diffuse drop
            # shadow keeps light, thin type readable on white backgrounds too.
            contour = (fr"\bord{max(1, round(size * .055))}\3c{dark}\3a&H30&\blur{max(1, round(size * .045))}"
                       fr"\xshad0\yshad{max(1, round(size * .04))}\4c{dark}\4a&H80&")
        else:
            contour = (fr"\bord{max(1, round(size * .085))}\3c{dark}\3a&H00&\blur{max(.6, size * .012):.1f}"
                       fr"\xshad0\yshad{max(1, round(size * .055))}\4c{dark}\4a&H60&")
        # Only the soft style fades in; every other style lands exactly on the word.
        entrance = r"\fad(90,0)" if animation == "aesthetic" else ""

        for row, row_height in zip(cue.rows, cue.row_heights):
            biggest = max(item.scale for item in row)
            baseline = top + size * biggest * ROW_BASELINE
            row_width = sum(item.advance for item in row) + (len(row) - 1) * cue.space
            x = (width - row_width) / 2
            for item in row:
                word, text, advance, scale, strong = item
                start = max(cue.start, word.start)
                end = min(cue.end, word.end, next_start.get(id(word), cue.end))
                end = max(end, min(cue.end, start + .12))
                px = size * scale
                cx = x + advance / 2
                fn, font_scale, descent, cap, weight_class = faces["strong" if strong else "base"]
                anchor = (fr"\an2\pos({round(cx)},{round(baseline + px * descent)})"
                          fr"\fs{px * font_scale:.2f}")
                # The family names one exact file, so its own weight is requested
                # and libass never fakes bold on top of it.
                weight = fr"\fn{fn}\b{weight_class}"
                color = hi if strong else white
                layer = 3 if strong else 2
                look = anchor + weight + contour + fr"\1c{color}"
                if animation == "marker" and strong:
                    # A tilted sticker-like box sits behind the stressed word.
                    pad_top, pad_bottom = px * .16, px * .17
                    box_w = advance
                    box_h = px * cap + pad_top + pad_bottom
                    box_cx, box_cy = cx, baseline - px * cap + box_h / 2 - pad_top
                    tilt = fr"\org({round(box_cx)},{round(box_cy)})\frz2"
                    shape = (fr"\an5\pos({round(box_cx)},{round(box_cy)}){tilt}\p1\bord0"
                             fr"\shad{max(1, round(size * .05))}\4c{dark}\4a&H70&\1c{hi}")
                    drawing = _rounded_box(round(box_w), round(box_h), round(box_h * .24))
                    ink = anchor + tilt + weight + fr"\bord0\shad0\1c{marker_ink}"
                    pop = r"\t(0,90,\fscx112\fscy112)\t(90,200,\fscx100\fscy100)"
                    emit(cue.start, start, shape + entrance, drawing, name="Shape", layer=0)
                    emit(start, cue.end, shape + pop, drawing, name="Shape", layer=0)
                    emit(cue.start, start, ink + entrance, text, layer=layer)
                    emit(start, cue.end, ink + pop, text, layer=layer)
                elif animation == "karaoke":
                    dim = anchor + weight + contour + fr"\1c{color}\1a&H70&\3a&H70&\4a&HB0&"
                    if not strong:
                        dim = anchor + weight + contour + fr"\1c{white}\1a&H70&\3a&H70&\4a&HB0&"
                    active = (anchor + weight + contour + fr"\1c{hi}"
                              r"\t(0,80,\fscx108\fscy108)\t(80,180,\fscx104\fscy104)")
                    emit(cue.start, start, dim + entrance, text, layer=layer)
                    emit(start, end, active, text, layer=layer + 1)
                    emit(end, cue.end, look, text, layer=layer)
                elif animation == "glow":
                    # A blurred halo in the accent colour sits on the bottom layer;
                    # the word itself stays white (accent when stressed) with a crisp
                    # dark rim, so it reads on bright footage as well as dark.
                    halo_alpha = "&H28&" if strong else "&H8C&"
                    halo = (anchor + weight + fr"\1c{hi}\3c{hi}\1a{halo_alpha}\3a{halo_alpha}"
                            fr"\bord{max(2, round(size * .17))}\blur{max(3, round(size * .16))}\shad0")
                    crisp = (anchor + weight + fr"\bord{max(1, round(size * .055))}\3c{dark}\3a&H00&"
                             fr"\blur{max(.6, size * .012):.1f}\xshad0\yshad{max(1, round(size * .04))}"
                             fr"\4c{dark}\4a&H70&\1c{color}")
                    lit = ""
                    if strong:
                        at = ms(start - cue.start)
                        lit = fr"\t({at},{at + 110},\fscx110\fscy110)\t({at + 110},{at + 240},\fscx100\fscy100)"
                        halo += fr"\t({at},{at + 110},\fscx110\fscy110)\t({at + 110},{at + 240},\fscx100\fscy100)"
                    emit(cue.start, cue.end, halo, text, layer=0 if not strong else 1)
                    emit(cue.start, cue.end, crisp + lit, text, layer=layer)
                elif animation == "rise":
                    # Fly in: the word starts transparent about one line below and
                    # glides up on an ease-out-back curve (fast start, a small
                    # overshoot, then it settles), sharpening from a slight motion
                    # blur as it lands. libass moves linearly, so the curve is
                    # drawn as short linear steps.
                    ax, ay = round(cx), round(baseline + px * descent)
                    lift = size * ROW_HEIGHT * .9
                    base_blur = max(.6, size * .012)
                    head = fr"\an2\fs{px * font_scale:.2f}" + weight + contour.split(r"\blur")[0]
                    tail = contour[contour.index(r"\xshad"):] + fr"\1c{color}"
                    keys = [i / RISE_STEPS for i in range(RISE_STEPS + 1)]
                    for k0, k1 in zip(keys, keys[1:]):
                        y0, y1 = (ay + lift * (1 - _ease_out_back(k)) for k in (k0, k1))
                        a0, a1 = (_alpha_hex(1 - min(1.0, k / .55)) for k in (k0, k1))
                        b0, b1 = (base_blur + (3.5 - base_blur) * (1 - min(1.0, k / .7)) for k in (k0, k1))
                        t0 = start + RISE_TIME * k0
                        t1 = start + RISE_TIME * k1
                        span = ms(t1 - t0)
                        emit(t0, t1, head + fr"\move({ax},{round(y0)},{ax},{round(y1)},0,{span})"
                             + fr"\blur{b0:.1f}" + tail
                             + fr"\1a{a0}\3a{a0}\4a{_shadow_alpha(a0)}"
                             + fr"\t(0,{span},\1a{a1}\3a{a1}\4a{_shadow_alpha(a1)}\blur{b1:.1f})",
                             text, layer=layer)
                    landed = start + RISE_TIME
                    settle = anchor + weight + contour + fr"\1c{color}"
                    if strong:
                        settle += r"\t(0,110,\fscx110\fscy110)\t(110,240,\fscx100\fscy100)"
                    emit(landed, cue.end, settle, text, layer=layer)
                elif animation == "pop":
                    # Words land one by one as they are spoken.
                    land = (r"\fscx62\fscy62\t(0,100,\fscx118\fscy118)\t(100,210,\fscx100\fscy100)"
                            if strong else r"\fscx78\fscy78\t(0,80,\fscx106\fscy106)\t(80,160,\fscx100\fscy100)")
                    fade = r"\1a&HFF&\3a&HFF&\4a&HFF&\t(0,60,\1a&H00&\3a&H00&\4a&H60&)"
                    emit(start, cue.end, look + land + fade, text, layer=layer)
                elif strong:
                    # clean, aesthetic, headline: stressed words are styled for
                    # the whole cue, then pulse when they are actually spoken.
                    pulse = (r"\t(0,90,\fscx110\fscy110)\t(90,220,\fscx100\fscy100)"
                             if animation != "aesthetic" else r"\t(0,160,\fscx104\fscy104)\t(160,320,\fscx100\fscy100)")
                    emit(cue.start, start, look + entrance, text, layer=layer)
                    emit(start, cue.end, look + (entrance if start <= cue.start else "") + pulse, text, layer=layer)
                else:
                    emit(cue.start, cue.end, look + entrance, text, layer=layer)
                x += advance + cue.space
            top += row_height
    return header + "\n".join(events) + "\n"


def for_stacked_panels(ass: str, height: int) -> str:
    """Move the legacy auto-positioned layout as a unit, including word decorations."""
    marker = re.search(r"; CLIPY stack shift: (-?\d+)", ass)
    if marker:
        shift = int(marker[1])
        if not shift:
            return ass

        def move(m):
            return fr"\{m[1]}({m[2]},{int(m[3]) + shift})"

        def glide(m):
            return fr"\move({m[1]},{int(m[2]) + shift},{m[3]},{int(m[4]) + shift}{m[5]})"
        ass = re.sub(r"\\move\((-?\d+),(-?\d+),(-?\d+),(-?\d+)((?:,\d+)*)\)", glide, ass)
        return re.sub(r"\\(pos|org)\((-?\d+),(-?\d+)\)", move, ass)
    baseline = round(height * 0.88)
    return re.sub(r"(?<!\\an5)\\pos\((\d+),\d+\)", lambda m: fr"\pos({m[1]},{baseline})", ass)


def build_srt(words: list[Word], style: CaptionStyle | None = None, width: int = 1080, height: int = 1920, *,
              offset: float = 0, emphasized: Set[int] = frozenset()) -> str:
    """Export the same cue boundaries and line breaks as the video."""
    def srt_time(t: float) -> str:
        ms = int(round(max(0.0, t) * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    cues = [(c.start, c.end, "\n".join(" ".join(item.word.text.strip() for item in row) for row in c.rows))
            for c in _caption_cues(words, style or CaptionStyle(), width, height, emphasized=emphasized)]
    return "\n".join(f"{n}\n{srt_time(start + offset)} --> {srt_time(end + offset)}\n{text}\n"
                     for n, (start, end, text) in enumerate(cues, 1) if end > start)
