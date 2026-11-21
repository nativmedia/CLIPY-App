"""Detect prosodic emphasis in the same audio and word clock used by captions."""
from __future__ import annotations

import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

import numpy as np

from .laughter import TYPED_LAUGHTER
from .media import AUDIO_TIMELINE

if TYPE_CHECKING:
    from .captions import Word


SAMPLE_RATE = 8_000
_WINDOW = round(.045 * SAMPLE_RATE)
_HOP = round(.015 * SAMPLE_RATE)
_LAGS = np.arange(round(SAMPLE_RATE / 440) - 1, round(SAMPLE_RATE / 65) + 2)
_SYLLABLES = re.compile(r"[aeiouyà-åè-ëì-ïò-öù-ü]+", re.IGNORECASE)
_PHRASE_END = re.compile(r"""[.!?;。！？；](?:["'”’)\]]*)$""")


@dataclass(frozen=True)
class _Prosody:
    level: float
    pitch: float
    seconds_per_syllable: float


def _phrases(words: Sequence[Word]) -> list[list[tuple[int, Word]]]:
    """Keep original indices while measuring neighboring words in audio order."""
    spoken = []
    for index, word in enumerate(words):
        text = word.text.strip()
        label = re.sub(r"[\W_]+", "", text).casefold()
        if (label and not text.startswith("[") and len(text.split()) == 1
                and not TYPED_LAUGHTER.fullmatch(label)
                and math.isfinite(word.start) and math.isfinite(word.end)
                and word.end > max(0.0, word.start)):
            spoken.append((index, word))

    phrases: list[list[tuple[int, Word]]] = []
    for index, word in sorted(spoken, key=lambda pair: pair[1].start):
        previous = phrases[-1][-1][1] if phrases else None
        if (previous is None or len(phrases[-1]) == 18 or word.start - previous.end > .48
                or _PHRASE_END.search(previous.text.rstrip())):
            phrases.append([])
        phrases[-1].append((index, word))
    return phrases


def _pitch(centered: np.ndarray) -> float | None:
    """Get the shortest strong period of a voiced frame by normalized autocorrelation."""
    size = len(centered)
    acf = np.correlate(centered, centered, mode="full")[size - 1:]
    power = np.concatenate(([0.0], np.cumsum(centered ** 2, dtype=np.float64)))
    normalize = np.sqrt(power[size - _LAGS] * (power[size] - power[_LAGS]))
    periodicity = acf[_LAGS] / np.maximum(normalize, 1e-12)
    peaks = np.flatnonzero(
        (periodicity[1:-1] >= periodicity[:-2]) & (periodicity[1:-1] > periodicity[2:])
    ) + 1
    if not peaks.size:
        return None
    strongest = float(periodicity[peaks].max())
    reliable = peaks[periodicity[peaks] >= max(.63, strongest * .90)]
    return SAMPLE_RATE / int(_LAGS[reliable[0]]) if reliable.size else None


def _measure(samples: np.ndarray, word: Word, end: float) -> _Prosody | None:
    begin = max(0, round(word.start * SAMPLE_RATE))
    finish = min(len(samples), round(end * SAMPLE_RATE))
    duration = (finish - begin) / SAMPLE_RATE
    if duration < .095:
        return None

    levels: list[float] = []
    pitches: list[float] = []
    offsets = range(begin, finish - _WINDOW + 1, _HOP)
    for offset in offsets:
        frame = samples[offset:offset + _WINDOW]
        centered = frame - frame.mean()
        rms = float(np.sqrt(np.mean(centered ** 2)))
        if rms <= .002:
            continue
        pitch = _pitch(centered)
        if pitch is not None:
            pitches.append(pitch)
            levels.append(20 * math.log10(rms))

    # Brief clicks and unvoiced noise should not beat surrounding speech.
    if len(pitches) < max(2, math.ceil(len(offsets) / 3)):
        return None
    syllables = max(1, len(_SYLLABLES.findall(word.text)))
    return _Prosody(float(np.percentile(levels, 65)), float(np.percentile(pitches, 65)), duration / syllables)


def _score_phrase(samples: np.ndarray, phrase: list[tuple[int, Word]]) -> list[tuple[float, int]]:
    measured = []
    for i, (index, word) in enumerate(phrase):
        # Overlapping transcript cues should not measure the following word's voice.
        end = min(word.end, phrase[i + 1][1].start) if i + 1 < len(phrase) else word.end
        measured.append((index, _measure(samples, word, end)))

    scored = []
    for i, (index, voice) in enumerate(measured):
        if voice is None:
            continue
        nearby = [item for _, item in measured[max(0, i - 3):i + 4] if item is not None]
        if len(nearby) < 2:
            continue
        # Compare a two-word phrase against its other word. On longer phrases
        # a median ignores both a neighboring accent and naturally quiet words.
        if len(nearby) == 2:
            nearby.remove(voice)
        level, pitch, pace = np.median(
            [(item.level, item.pitch, item.seconds_per_syllable) for item in nearby], axis=0
        )
        loudness = max(0.0, (voice.level - level) / 6)
        inflection = max(0.0, 12 * math.log2(voice.pitch / pitch) / 4.5)
        length = min(.35, max(0.0, voice.seconds_per_syllable / pace - 1) * .40)
        # Timing is supporting evidence; a pause or a longer word alone isn't
        # a reason to style it as emphasized.
        strength = loudness + inflection + length
        if max(loudness, inflection) >= 1 or (min(loudness, inflection) >= .25 and strength >= 1.15):
            scored.append((strength, index))
    return scored


def detect_pcm(samples: np.ndarray, words: Sequence[Word]) -> set[int]:
    """Return indices of prominent words in mono float PCM at SAMPLE_RATE."""
    emphasized = set()
    for phrase in _phrases(words):
        if len(phrase) < 2:
            continue
        scored = _score_phrase(samples, phrase)
        allowance = max(1, len(phrase) // 5)
        ranked = sorted(scored, key=lambda entry: entry[0], reverse=True)
        emphasized.update(index for _, index in ranked[:allowance])
    return emphasized


def detect(source: Path, words: Sequence[Word]) -> set[int]:
    """Measure unmixed speech before styling. Missing audio leaves normal captions."""
    ends = [word.end for word in words if math.isfinite(word.end)]
    if len(ends) < 2 or max(ends) <= 0:
        return set()
    try:
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(source), "-t", f"{max(ends):.6f}",
             "-map", "0:a:0", "-vn", "-af", AUDIO_TIMELINE,
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
            capture_output=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return set()
    return detect_pcm(np.frombuffer(result.stdout, dtype="<f4"), words)
