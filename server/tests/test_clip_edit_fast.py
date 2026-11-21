"""An edit re-uses what the first render worked out and only encodes again."""
import json
import queue
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from clipy import emphasis, film, framing, laughter, media, projects, thumbs


def plain_ratio(path):
    """Width/height without the rotation query older ffprobe builds reject."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
    width, height = map(int, out.strip().split(",")[:2])
    return width / height


class FastEditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media_dir = tempfile.TemporaryDirectory()
        cls.video = Path(cls.media_dir.name) / "source.mp4"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
                        "-f", "lavfi", "-i", "sine=f=220:sample_rate=48000", "-t", "40", "-pix_fmt", "yuv420p",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.media_dir.cleanup()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.patches = [
            patch.object(projects, "DATA_DIR", Path(self.folder.name)),
            patch.object(projects, "_projects", {}),
            patch.object(projects, "_queue", queue.Queue()),
            patch.object(projects, "_active", None),
            patch.object(projects.Project, "local_video", property(lambda _: self.video)),
            patch.object(laughter, "detect", lambda *a, **k: []),
            patch.object(emphasis, "ai_keywords", lambda *a, **k: None),
            patch.object(film, "_source_ratio", plain_ratio),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.folder.cleanup()

    def project(self):
        p = projects.create("", "", {
            "mode": "clipping",
            "clip": {"ratio": "9:16", "fit": "crop", "count": 1, "max_duration": 30, "clip_ratio": "9:16", "background": "none"},
            "caption": {}, "thumb": {"source": "auto", "title_style": "bold", "voice": None}, "brand": {},
        })
        p.upload_id, p.duration, p.transcript_timing, p.transcript_origin = "local", 40.0, "kata", "whisper"
        words = [{"text": f"kata{i}", "start": i * .5, "end": i * .5 + .4} for i in range(80)]
        (p.dir / "words.json").write_text(json.dumps(words), encoding="utf-8")
        p.status = "done"
        p.clips = [{"n": 1, "start": 10.0, "end": 18.0, "title": "Clip satu", "status": "pending"}]
        p.save()
        projects._projects[p.id] = p
        return p

    def test_extending_reuses_words_framing_and_thumbnail(self):
        p = self.project()
        projects._retry(p, 1)
        clip = p.clips[0]
        self.assertEqual(clip["status"], "done", clip.get("error"))
        thumb_before = (p.dir / clip["thumb"]).stat().st_mtime

        analysed = []
        real_plan = framing.plan_crop

        def counting_plan(src, *args, **kwargs):
            analysed.append(media.probe_duration(src))
            return real_plan(src, *args, **kwargs)

        def no(*_a, **_k):
            raise AssertionError("an edit must not run this again")

        projects.edit(p, 1, 8.0, 20.0, [{"start": 12.0, "end": 12.4, "text": "BENAR", "orig": "kata24"}])
        with patch.object(framing, "plan_crop", counting_plan), \
             patch.object(projects, "_transcribe_clip", no), \
             patch.object(emphasis, "ai_keywords", no), \
             patch.object(thumbs, "add_title", no):
            projects._retry(p, 1)
        clip = p.clips[0]
        self.assertEqual(clip["status"], "done", clip.get("error"))
        self.assertAlmostEqual(media.probe_duration(p.dir / clip["video"]), 12.0, delta=0.3)
        # Only the two added stretches (2 s each) were analysed for framing.
        self.assertEqual(len(analysed), 2)
        self.assertTrue(all(d < 2.5 for d in analysed), analysed)
        self.assertEqual((p.dir / clip["thumb"]).stat().st_mtime, thumb_before)
        saved = json.loads((p.dir / "caption_1.json").read_text(encoding="utf-8"))
        texts = [w["text"] for w in saved["words"]]
        self.assertIn("BENAR", texts)
        self.assertIn("kata16", texts)   # added at the start
        self.assertIn("kata39", texts)   # added at the end
        plan = json.loads((p.dir / "framing_1.json").read_text(encoding="utf-8"))
        self.assertEqual((plan["from"], plan["to"]), (8.0, 20.0))

    def test_a_second_edit_does_not_apply_an_old_fix_twice(self):
        p = self.project()
        projects._retry(p, 1)
        self.assertEqual(p.clips[0]["status"], "done", p.clips[0].get("error"))
        projects.edit(p, 1, 10.0, 18.0, [{"start": 12.0, "end": 12.4, "text": "", "orig": "kata24"}])
        projects._retry(p, 1)
        first = [w["text"] for w in json.loads((p.dir / "caption_1.json").read_text(encoding="utf-8"))["words"]]
        self.assertNotIn("kata24", first)
        projects.edit(p, 1, 10.0, 18.0, [{"start": 14.0, "end": 14.4, "text": "LAGI", "orig": "kata28"}])
        projects._retry(p, 1)
        self.assertEqual(p.clips[0]["status"], "done", p.clips[0].get("error"))
        second = [w["text"] for w in json.loads((p.dir / "caption_1.json").read_text(encoding="utf-8"))["words"]]
        self.assertEqual(len(second), len(first))  # the earlier deletion removed nothing more
        self.assertIn("LAGI", second)
        self.assertIn("kata23", second)
        self.assertIn("kata25", second)


if __name__ == "__main__":
    unittest.main()
