import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from clipy import captions


def word_events(ass, text):
    return [line for line in ass.splitlines()
            if line.startswith("Dialogue:") and line.rpartition("}")[2].rstrip(".!?").casefold() == text]


def sizes(lines):
    return {float(re.search(r"\\fs([\d.]+)", line)[1]) for line in lines}


FONT_ASSETS = ("Clipy-Jakarta-Soft.ttf", "Clipy-Jakarta-Base.ttf", "Clipy-Jakarta-Strong.ttf")


class CaptionAnimationTests(unittest.TestCase):
    def test_ten_caption_fonts_each_bundle_their_own_faces(self):
        self.assertEqual(len(captions.OPTIONS["fonts"]), 10)
        for key, font in captions.CAPTION_FONTS.items():
            with self.subTest(font=key):
                for role in ("Soft", "Base", "Strong"):
                    self.assertTrue((captions.FONT_DIR / font.file(role)).is_file())

    def test_each_caption_font_draws_its_own_family_and_size(self):
        words = [captions.Word("Halo", 0, .4), captions.Word("semua", .4, .8)]
        sizes_by_font = {}
        for key, font in captions.CAPTION_FONTS.items():
            with self.subTest(font=key):
                ass = captions.build_ass(words, captions.CaptionStyle(animation="clean", font=key), 360, 640,
                                         emphasized={1})
                styles = {line.split(",")[1] for line in ass.splitlines() if line.startswith("Style:")}
                self.assertEqual(styles, {font.family("Base")})
                self.assertTrue(all(rf"\fn{font.family('Strong')}" in line for line in word_events(ass, "semua")))
                sizes_by_font[key] = captions._caption_cues(
                    words, captions.CaptionStyle(animation="clean", font=key), 360, 640)[0].size
        self.assertGreater(sizes_by_font["bebas"], sizes_by_font["jakarta"])
        self.assertLess(sizes_by_font["unbounded"], sizes_by_font["jakarta"])

    def test_saved_fonts_from_earlier_releases_still_load(self):
        words = [captions.Word("Halo", 0, .4)]
        self.assertEqual(captions.normalize_font("instrument-serif"), "dm-serif")
        self.assertEqual(captions.normalize_font("plus-jakarta"), "jakarta")
        self.assertEqual(captions.normalize_font("unknown"), "jakarta")
        legacy = captions.CaptionStyle(font="gaegu", font_weight="thin", animation="focus")
        self.assertEqual(captions.build_ass(words, legacy, 360, 640),
                         captions.build_ass(words, captions.CaptionStyle(font="caveat", animation="clean"), 360, 640))

    def test_styles_accept_legacy_animation_values(self):
        expected = {"clean", "marker", "karaoke", "pop", "aesthetic", "headline", "glow", "rise", "duo", "script"}
        self.assertEqual(set(captions.OPTIONS["animations"]), expected)
        self.assertEqual(set(captions.STYLES), expected)
        for legacy in ("focus", "pill", "outline", "editorial", "highlight", "box", "glow", "fade",
                       "reveal", "underline", "word", "word-neon"):
            with self.subTest(legacy=legacy):
                self.assertIn(captions.normalize_animation(legacy), expected)

    def test_every_style_makes_the_detected_word_bigger_and_heavier(self):
        words = [captions.Word("Lihat", 0, .35), captions.Word("ini", .35, .6), captions.Word("penting", .6, 1.0)]
        for animation in captions.OPTIONS["animations"]:
            with self.subTest(animation=animation):
                style = captions.CaptionStyle(display="sentence", animation=animation, color="yellow")
                ass = captions.build_ass(words, style, 360, 640, emphasized={2})
                ordinary, stressed = word_events(ass, "lihat"), word_events(ass, "penting")
                self.assertTrue(ordinary and stressed)
                self.assertGreater(min(sizes(stressed)), max(sizes(ordinary)))
                if captions.STYLES[animation].strong_font:
                    # Accent styles change the typeface itself instead of the weight.
                    self.assertTrue(all(r"\fnClipy Jakarta" not in line for line in stressed))
                    self.assertTrue(all(r"\fnClipy Jakarta" in line for line in ordinary))
                else:
                    self.assertTrue(all(r"\b800" in line for line in stressed))
                plain = captions.build_ass(words, style, 360, 640)
                self.assertEqual(sizes(word_events(plain, "penting")), sizes(word_events(plain, "lihat")))

    def test_stressed_word_carries_the_accent_for_the_whole_cue(self):
        words = [captions.Word("Lihat", 0, .35), captions.Word("ini", .35, .6), captions.Word("penting", .6, 1.0)]
        accent = captions.tag_color(captions.COLORS["yellow"])
        for animation in ("clean", "aesthetic", "headline"):
            with self.subTest(animation=animation):
                style = captions.CaptionStyle(display="sentence", animation=animation, color="yellow")
                stressed = word_events(captions.build_ass(words, style, 360, 640, emphasized={2}), "penting")
                self.assertTrue(stressed[0].startswith("Dialogue: 3,0:00:00.00,"))
                self.assertTrue(all(accent in line for line in stressed))

    def test_white_accent_still_differs_from_white_text(self):
        words = [captions.Word("Lihat", 0, .35), captions.Word("penting", .35, .8)]
        style = captions.CaptionStyle(display="sentence", animation="clean", color="white")
        stressed = word_events(captions.build_ass(words, style, 360, 640, emphasized={1}), "penting")
        self.assertTrue(all(captions.tag_color(captions.COLORS["cream"]) in line for line in stressed))

    def test_aesthetic_style_is_lowercase_and_medium_weight(self):
        words = [captions.Word("Hari", 0, .3), captions.Word("INDAH", .3, .7)]
        style = captions.CaptionStyle(display="sentence", animation="aesthetic", case="upper")
        ass = captions.build_ass(words, style, 360, 640, emphasized={1})
        self.assertTrue(all(r"\b500" in line for line in word_events(ass, "hari")))
        self.assertTrue(any(line.endswith("}hari") for line in ass.splitlines()))
        self.assertTrue(any(line.endswith("}indah") for line in ass.splitlines()))

    def test_headline_gives_the_stressed_word_its_own_row(self):
        words = [captions.Word(text, i * .3, i * .3 + .28)
                 for i, text in enumerate("ini bukan soal uang".split())]
        style = captions.CaptionStyle(display="sentence", animation="headline", case="upper")
        cues = captions._caption_cues(words, style, 1080, 1920, emphasized={3})
        rows = [[item.label for item in row] for row in cues[0].rows]
        self.assertEqual(rows, [["INI", "BUKAN", "SOAL"], ["UANG"]])
        self.assertGreater(cues[0].rows[1][0].scale, 1.5)

    def test_pop_reveals_each_word_when_it_is_spoken(self):
        words = [captions.Word("Lihat", 0, .35), captions.Word("penting", .5, .8)]
        style = captions.CaptionStyle(display="sentence", animation="pop")
        ass = captions.build_ass(words, style, 360, 640, emphasized={1})
        self.assertTrue(all(",0:00:00.50," in line for line in word_events(ass, "penting")))

    def test_emphasis_indices_still_point_to_original_words_after_expanding_coarse_cues(self):
        words = [captions.Word("Ini segmen", 0, .7), captions.Word("penting", .7, 1.1)]
        style = captions.CaptionStyle(display="sentence", animation="clean")
        ass = captions.build_ass(words, style, 360, 640, emphasized={1})
        stressed = [line for line in ass.splitlines() if line.startswith("Dialogue:") and r"\b800" in line]
        self.assertTrue(stressed)
        self.assertEqual(stressed, word_events(ass, "penting"))

    def test_marker_keeps_word_anchors_fixed_and_draws_a_box(self):
        words = [captions.Word("Paul", 0, .4), captions.Word("berlari.", .4, .8)]
        style = captions.CaptionStyle(display="sentence", animation="marker", position=4)
        ass = captions.build_ass(words, style, 360, 640, emphasized={1})
        stress = word_events(ass, "berlari")
        self.assertGreater(len(stress), 1)
        self.assertEqual(len({re.search(r"\\pos\([^)]*\)", line)[0] for line in stress}), 1)
        self.assertTrue(any(",Shape," in line and r"\p1" in line for line in ass.splitlines()))
        self.assertEqual(captions.for_stacked_panels(ass, 640), ass)

    def test_glow_puts_an_accent_halo_under_crisp_readable_text(self):
        words = [captions.Word("Lihat", 0, .35), captions.Word("penting", .35, 1.0)]
        style = captions.CaptionStyle(display="sentence", animation="glow", color="cyan")
        ass = captions.build_ass(words, style, 360, 640, emphasized={1})
        accent = captions.tag_color(captions.COLORS["cyan"])
        events = word_events(ass, "penting")
        halo = [e for e in events if rf"\3c{accent}" in e]
        crisp = [e for e in events if rf"\3c{captions.tag_color(captions.INK)}" in e]
        self.assertTrue(halo and crisp)
        layer = lambda e: int(e.split(":", 1)[1].split(",", 1)[0])
        self.assertLess(max(map(layer, halo)), min(map(layer, crisp)))

    def test_rise_floats_each_word_up_about_one_line_when_spoken(self):
        words = [captions.Word("Lihat", 0, .4), captions.Word("ini", .4, .8)]
        ass = captions.build_ass(words, captions.CaptionStyle(display="sentence", animation="rise"), 360, 640)
        line = word_events(ass, "ini")[0]
        self.assertIn("0:00:00.40", line)
        x1, y1, x2, y2 = map(int, re.search(r"\\move\((\d+),(\d+),(\d+),(\d+)", line).groups())
        self.assertEqual(x1, x2)
        self.assertGreater(y1 - y2, 10)
        self.assertIn(r"\1a&HFF&", line)
        shifted = captions.for_stacked_panels(ass, 640)
        if shifted != ass:
            self.assertNotEqual(re.search(r"\\move\([^)]*\)", shifted)[0], re.search(r"\\move\([^)]*\)", ass)[0])

    def test_accent_styles_switch_font_even_when_base_font_is_the_accent(self):
        words = [captions.Word("Lihat", 0, .4), captions.Word("penting", .4, 1.0)]
        for animation, font in (("duo", "dm-serif"), ("script", "caveat")):
            with self.subTest(animation=animation):
                ass = captions.build_ass(words, captions.CaptionStyle(display="sentence", animation=animation, font=font),
                                         360, 640, emphasized={1})
                fonts = {re.search(r"\\fn([^\\]+)", line)[1] for line in word_events(ass, "penting")}
                plain = {re.search(r"\\fn([^\\]+)", line)[1] for line in word_events(ass, "lihat")}
                self.assertTrue(fonts and plain and fonts.isdisjoint(plain))

    def test_rise_lands_on_an_eased_curve_with_a_small_overshoot(self):
        words = [captions.Word("Lihat", 0, .6), captions.Word("ini", .6, 1.2)]
        ass = captions.build_ass(words, captions.CaptionStyle(display="sentence", animation="rise"), 360, 640)
        ys = []
        for line in word_events(ass, "ini"):
            m = re.search(r"\\move\(\d+,(\d+),\d+,(\d+)", line)
            if m:
                ys += [int(m[1]), int(m[2])] if not ys else [int(m[2])]
        rest = int(re.search(r"\\pos\(\d+,(\d+)\)", word_events(ass, "ini")[-1])[1])
        steps = [a - b for a, b in zip(ys, ys[1:])]
        self.assertGreater(steps[0], steps[2])        # fast start, slowing down
        self.assertLess(min(ys), rest)                 # goes a little past its line
        self.assertEqual(ys[-1], rest)                 # and settles exactly on it

    def test_stacked_panels_move_positions_and_rotation_origins_together(self):
        words = [captions.Word("Paul", 0, .4), captions.Word("berlari.", .4, .8)]
        style = captions.CaptionStyle(display="sentence", animation="marker")
        ass = captions.build_ass(words, style, 1080, 1920, emphasized={1})
        moved = captions.for_stacked_panels(ass, 1920)
        shift = int(re.search(r"stack shift: (-?\d+)", ass)[1])
        before = [int(y) for y in re.findall(r"\\org\(\d+,(\d+)\)", ass)]
        after = [int(y) for y in re.findall(r"\\org\(\d+,(\d+)\)", moved)]
        self.assertTrue(before)
        self.assertEqual(after, [y + shift for y in before])

    @unittest.skipUnless(shutil.which("ffmpeg"), "requires FFmpeg with libass")
    def test_all_styles_render_distinct_legible_captions_on_light_and_dark(self):
        width, height = 360, 640
        words = [captions.Word("Lihat", 0, .35), captions.Word("penting", .35, .8)]
        results = set()
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            fonts = work / "fonts"
            fonts.mkdir()
            for asset in FONT_ASSETS:
                shutil.copyfile(captions.FONT_DIR / asset, fonts / asset)
            for animation in captions.OPTIONS["animations"]:
                with self.subTest(animation=animation):
                    style = captions.CaptionStyle(display="sentence", animation=animation, color="yellow")
                    ass = captions.build_ass(words, style, width, height, emphasized={1})
                    (work / "caption.ass").write_text(ass, encoding="utf-8")
                    video = f"color=black:s={width}x{height}:r=30:d=1"
                    graph = ("drawbox=x=180:y=0:w=180:h=640:color=white:t=fill,"
                             "ass=caption.ass:fontsdir=fonts")
                    frame = subprocess.run(
                        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", video, "-vf", graph,
                         "-ss", "0.6", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
                        cwd=work, check=True, capture_output=True,
                    ).stdout
                    self.assertEqual(len(frame), width * height)
                    left = (frame[i:i + width // 2] for i in range(0, len(frame), width))
                    right = (frame[i + width // 2:i + width] for i in range(0, len(frame), width))
                    self.assertGreater(sum(pixel > 150 for row in left for pixel in row), 40)
                    self.assertGreater(sum(pixel < 105 for row in right for pixel in row), 40)
                    results.add(frame)
        self.assertEqual(len(results), len(captions.OPTIONS["animations"]))

    def test_sentence_line_limit_is_shared_by_srt(self):
        words = [captions.Word(word, i * .3, i * .3 + .27) for i, word in enumerate(
            "Paul melihat pasukan mundur tetapi Kat masih bertahan di tengah serangan.".split()
        )]
        for limit in (1, 2, 3):
            style = captions.CaptionStyle(display="sentence", max_lines=limit)
            cues = captions.build_srt(words, style, 360, 640).strip().split("\n\n")
            # Older projects may still say 3 lines; captions stop at two.
            self.assertEqual(max(len(cue.splitlines()[2:]) for cue in cues), min(limit, captions.MAX_LINES))
            self.assertEqual(" ".join(" ".join(cue.splitlines()[2:]) for cue in cues), " ".join(w.text for w in words))

    def test_coarse_transcript_segment_becomes_readable_one_line_captions(self):
        text = "Ini satu segmen subtitle otomatis yang sangat panjang sehingga harus dibagi menjadi kata-kata yang terbaca."
        words = [captions.Word(text, 0, 12)]
        style = captions.CaptionStyle(display="sentence", max_lines=1, case="sentence")

        cues = captions._caption_cues(words, style, 360, 640)
        srt_cues = captions.build_srt(words, style, 360, 640).strip().split("\n\n")

        self.assertGreater(len(cues), 1)
        self.assertTrue(all(cue.size > 20 for cue in cues))
        self.assertTrue(all(len(cue.rows) == 1 for cue in cues))
        self.assertGreater(len(srt_cues), 1)
        self.assertTrue(all(len(cue.splitlines()[2:]) == 1 for cue in srt_cues))

    def test_overlapping_segment_windows_become_serialized_visual_cues(self):
        words = [
            captions.Word("Misalnya kita tuning", 32.34, 36.11),
            captions.Word("Iya kan kita", 33.48, 35.12),
            captions.Word("Harus menyesuaikan", 34.97, 37.82),
        ]
        style = captions.CaptionStyle(display="sentence", max_lines=1)
        cues = captions._caption_cues(words, style, 1080, 1920)

        self.assertTrue(all(first.end <= second.start for first, second in zip(cues, cues[1:])))
        self.assertTrue(all(cue.end > cue.start for cue in cues))


if __name__ == "__main__":
    unittest.main()
