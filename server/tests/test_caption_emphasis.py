from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import wave

import numpy as np

from clipy import caption_emphasis
from clipy.captions import Word


class CaptionEmphasisTests(unittest.TestCase):
    def speech(self, *tokens, lead_in=0):
        """Synthesize timed speech-like harmonics with independent pitch and level."""
        rate = caption_emphasis.SAMPLE_RATE
        audio = [np.zeros(round(rate * lead_in), dtype=np.float32)]
        words = []
        position = len(audio[0])
        for text, pitch, gain, duration in tokens:
            size = round(rate * duration)
            time = np.arange(size) / rate
            signal = gain * (np.sin(2 * np.pi * pitch * time) + .3 * np.sin(4 * np.pi * pitch * time))
            start, end = position / rate, (position + size) / rate
            words.append(Word(text, start, end))
            audio.extend((signal, np.zeros(round(rate * .06))))
            position += size + len(audio[-1])
        return np.concatenate(audio).astype(np.float32), words

    def test_higher_pitch_marks_the_word_even_at_the_same_level(self):
        audio, words = self.speech(
            ("aku", 122, .13, .23), ("pilih", 120, .12, .21),
            ("merah", 188, .12, .24), ("saja.", 123, .12, .23),
        )
        self.assertEqual(caption_emphasis.detect_pcm(audio, words), {2})

    def test_sustained_loudness_marks_the_word_even_at_the_same_pitch(self):
        audio, words = self.speech(
            ("ini", 132, .09, .24), ("penting!", 132, .25, .28),
        )
        self.assertEqual(caption_emphasis.detect_pcm(audio, words), {1})

    def test_phrase_baseline_restarts_after_punctuation_and_pause(self):
        audio, words = self.speech(
            ("aku", 122, .07, .24), ("pilih.", 122, .07, .23),
            ("besok", 186, .21, .24), ("pagi", 186, .21, .24), ("boleh.", 186, .21, .23),
        )
        self.assertEqual(caption_emphasis.detect_pcm(audio, words), set())
        words[1].text = "pilih"
        at = round(words[2].start * caption_emphasis.SAMPLE_RATE)
        gap = round(.5 * caption_emphasis.SAMPLE_RATE)
        audio = np.concatenate((audio[:at], np.zeros(gap), audio[at:]))
        words[2:] = [Word(word.text, word.start + .5, word.end + .5) for word in words[2:]]
        self.assertEqual(caption_emphasis.detect_pcm(audio, words), set())

    def test_preserves_original_indices_and_excludes_laughter(self):
        audio, words = self.speech(
            ("tidak", 124, .12, .24), ("setuju", 190, .24, .26),
            ("hahaha", 295, .41, .28), ("ya.", 124, .12, .20),
        )
        reordered = [words[2], words[0], words[3], words[1]]
        self.assertEqual(caption_emphasis.detect_pcm(audio, reordered), {3})

    def test_does_not_accent_silence_noise_or_length_alone(self):
        audio, words = self.speech(
            ("meja", 140, .11, .23), ("kursi", 140, .11, .46),
            ("bunyi", 140, .11, .27), ("lampu.", 140, .11, .26),
        )
        start = round(words[2].start * caption_emphasis.SAMPLE_RATE)
        end = round(words[2].end * caption_emphasis.SAMPLE_RATE)
        audio[start:end] = np.random.default_rng(7).normal(0, .4, end - start)
        self.assertEqual(caption_emphasis.detect_pcm(audio, words), set())
        self.assertEqual(caption_emphasis.detect_pcm(np.zeros_like(audio), words), set())

    def test_reads_audio_only_files_on_the_caption_clock(self):
        audio, words = self.speech(
            ("ini", 120, .10, .24), ("penting!", 184, .18, .28), lead_in=.35,
        )
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "narration.wav"
            with wave.open(str(source), "wb") as wav:
                wav.setparams((1, 2, caption_emphasis.SAMPLE_RATE, 0, "NONE", ""))
                wav.writeframes((audio * 32767).astype("<i2").tobytes())
            self.assertEqual(caption_emphasis.detect(source, words), {1})
            self.assertEqual(caption_emphasis.detect(source.with_name("missing.wav"), words), set())
