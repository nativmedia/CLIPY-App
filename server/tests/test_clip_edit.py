import json
import queue
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from clipy import projects
from clipy.captions import Word


class ClipEditTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.patches = [
            patch.object(projects, "DATA_DIR", Path(self.folder.name)),
            patch.object(projects, "_projects", {}),
            patch.object(projects, "_queue", queue.Queue()),
            patch.object(projects, "_active", None),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.folder.cleanup()

    def project(self):
        p = projects.create("https://example.test/v", "vid", {
            "mode": "clipping", "clip": {"count": 1, "max_duration": 60}, "caption": {}, "thumb": {}, "brand": {},
        })
        p.status, p.stage, p.progress, p.duration = "done", "done", 1.0, 600.0
        p.clips = [{"n": 1, "start": 100.0, "end": 140.0, "title": "Clip", "status": "done", "video": "01.mp4"}]
        words = [{"text": t, "start": 98 + i, "end": 98.8 + i} for i, t in enumerate("satu dua tiga empat lima enam".split())]
        (p.dir / "words.json").write_text(json.dumps(words), encoding="utf-8")
        (p.dir / "src_1.mp4").write_bytes(b"x")
        p.save()
        projects._projects[p.id] = p
        return p

    def test_info_gives_limits_and_words_around_the_clip(self):
        info = projects.edit_info(self.project(), 1)
        self.assertEqual((info["start"], info["end"], info["max_duration"]), (100.0, 140.0, 60.0))
        self.assertEqual(info["window"], [40.0, 200.0])
        self.assertEqual([w["text"] for w in info["words"]][:3], ["satu", "dua", "tiga"])

    def test_saving_a_longer_range_rerenders_with_a_fresh_source(self):
        p = self.project()
        projects.edit(p, 1, 95.0, 150.0, [])
        self.assertEqual((p.clips[0]["start"], p.clips[0]["end"]), (95.0, 150.0))
        self.assertFalse((p.dir / "src_1.mp4").exists())
        self.assertEqual(projects._queue.get_nowait(), ("retry", p.id, 1))

    def test_range_must_respect_project_limit_and_minimum(self):
        p = self.project()
        with self.assertRaises(ValueError):
            projects.edit(p, 1, 80.0, 150.0, [])  # 70 s > 60 s
        with self.assertRaises(ValueError):
            projects.edit(p, 1, 100.0, 101.0, [])
        with self.assertRaises(ValueError):
            projects.edit(p, 1, 590.0, 620.0, [])  # past the source

    def test_caption_fixes_reach_the_render_and_the_transcript(self):
        p = self.project()
        projects.edit(p, 1, 100.0, 140.0, [{"start": 100, "end": 100.8, "text": "Tigaa", "orig": "tiga"},
                                            {"start": 101, "end": 101.8, "text": "", "orig": "empat"}])
        self.assertTrue((p.dir / "src_1.mp4").exists())  # same range keeps the cut source
        caption = [Word("tiga", 0, .8), Word("empat", 1, 1.8), Word("lima", 2, 2.8)]
        fixed = projects.apply_caption_fixes(caption, p.clips[0]["caption_fixes"], 100.0)
        self.assertEqual([w.text for w in fixed], ["Tigaa", "lima"])
        saved = json.loads((p.dir / "words.json").read_text(encoding="utf-8"))
        self.assertEqual(saved[2]["text"], "Tigaa")

    def test_sentence_rewrite_with_a_different_word_count_shares_its_time_span(self):
        caption = [Word("aku", 0, .5), Word("bilang", .5, 1.0), Word("ke", 1.0, 1.2), Word("dia", 1.2, 1.6), Word("lagi", 2.0, 2.4)]
        fix = {"kind": "line", "start": 100.0, "end": 101.6, "text": "aku bilangin dia", "orig": "aku bilang ke dia"}
        fixed = projects.apply_caption_fixes(caption, [fix], 100.0)
        self.assertEqual([w.text for w in fixed], ["aku", "bilangin", "dia", "lagi"])
        self.assertEqual((fixed[0].start, fixed[2].end), (0, 1.6))
        self.assertTrue(all(a.end <= b.start + 1e-6 for a, b in zip(fixed, fixed[1:])))

    def test_preview_is_cut_from_the_local_video_for_the_whole_window(self):
        import subprocess
        p = self.project()
        video = Path(self.folder.name) / "source.mp4"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30",
                        "-t", "210", "-pix_fmt", "yuv420p", str(video)], check=True)
        with patch.object(projects.Project, "local_video", property(lambda self: video)):
            data = projects.edit_preview(p, 1)
            self.assertEqual((data["from"], data["to"], data["offset"]), (40.0, 200.0, 40.0))
            out = projects.edit_preview_file(p, 1)
            self.assertAlmostEqual(projects.media.probe_duration(out), 160.0, delta=0.5)
            self.assertEqual(projects.edit_preview(p, 1)["url"], data["url"])  # cached

    def test_editing_waits_for_a_running_project(self):
        p = self.project()
        p.status = "clipping"
        with self.assertRaises(ValueError):
            projects.edit(p, 1, 100.0, 140.0, [])


if __name__ == "__main__":
    unittest.main()
