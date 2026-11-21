import unittest
from unittest.mock import patch

from clipy import emphasis
from clipy.captions import Word


def sentence(text, start=0.0, step=.3):
    return [Word(token, start + i * step, start + i * step + .27) for i, token in enumerate(text.split())]


class EmphasisRuleTests(unittest.TestCase):
    def pick(self, text):
        words = sentence(text)
        chosen = emphasis.merge(words, set(), None, emphasis.rule_scores(words))
        return {words[i].text.strip(".,!?").casefold() for i in chosen}

    def test_numbers_negations_and_intensified_words_win_over_filler(self):
        self.assertEqual(self.pick("Gue udah nabung 50 juta tahun ini."), {"50"})
        self.assertEqual(self.pick("Ini bukan soal itu ya."), {"bukan"})
        self.assertEqual(self.pick("Harganya mahal banget sih."), {"mahal"})
        self.assertEqual(self.pick("Itu yang paling gampang."), {"gampang"})

    def test_pronouns_particles_and_laughter_are_never_picked(self):
        words = sentence("dia itu sih kan hahaha ya")
        self.assertEqual(emphasis.merge(words, {0, 1, 4}, {2, 3}, emphasis.rule_scores(words)), set())

    def test_each_phrase_gets_at_most_its_allowance(self):
        words = sentence("Rahasia sukses itu cuma satu: konsisten setiap hari tanpa alasan apa pun, paham?")
        chosen = emphasis.merge(words, set(), None, emphasis.rule_scores(words))
        self.assertLessEqual(len(chosen), 2)
        self.assertTrue(chosen)

    def test_ai_and_voice_agreement_beats_rules_alone(self):
        words = sentence("Kita harus belajar dari kegagalan kemarin.")
        rules = emphasis.rule_scores(words)
        self.assertEqual(emphasis.merge(words, {4}, {4}, rules), {4})

    def test_choose_falls_back_to_rules_when_the_ai_is_unavailable(self):
        words = sentence("Ini bukan soal uang tapi soal waktu.")
        with patch.object(emphasis.keys, "load", return_value=None):
            chosen = emphasis.choose(None, words, "id")
        self.assertIn(1, chosen)

    def test_ai_errors_fall_back_quietly(self):
        words = sentence("Ini bukan soal uang tapi soal waktu.")
        with patch.object(emphasis.keys, "load", return_value={"provider": "x"}), \
                patch.object(emphasis.keys, "ask_json", side_effect=RuntimeError("offline")):
            self.assertIsNone(emphasis.ai_keywords(words, "id"))
            self.assertIn(1, emphasis.choose(None, words, "id"))

    def test_ai_indices_map_back_to_the_original_words(self):
        words = [Word("[musik]", 0, .2)] + sentence("Ini bukan soal uang tapi soal waktu.", start=.3)
        with patch.object(emphasis.keys, "load", return_value={"provider": "x"}), \
                patch.object(emphasis.keys, "ask_json", return_value={"keywords": [6, 99, "x"]}):
            # Token [6] skips the bracketed sound cue, so it is words[7] = "waktu."
            self.assertEqual(emphasis.ai_keywords(words, "id"), {7})


if __name__ == "__main__":
    unittest.main()
