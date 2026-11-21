import json
import queue
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from clipy import projects, select
from clipy.captions import Word


def sentence(text, start=0.0, step=0.5):
    return [Word(token, start + i * step, start + i * step + .45) for i, token in enumerate(text.split())]


class GenMoreTests(unittest.TestCase):
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

    def finished_project(self, clips=2, mode="clipping"):
        p = projects.create("https://example.test/v", "vid", {
            "mode": mode, "clip": {"count": clips, "max_duration": 60}, "caption": {}, "thumb": {}, "brand": {},
        })
        p.status, p.stage, p.progress = "done", "done", 1.0
        p.clips = [{"n": i + 1, "start": i * 100.0, "end": i * 100.0 + 50, "title": f"Clip {i + 1}",
                    "status": "done", "video": f"0{i + 1}.mp4"} for i in range(clips)]
        (p.dir / "words.json").write_text(json.dumps([{"text": "halo", "start": 0, "end": .4}]), encoding="utf-8")
        p.save()
        projects._projects[p.id] = p
        return p

    def test_more_queues_the_extra_clips_and_remembers_the_earlier_ones(self):
        p = self.finished_project()
        projects.more(p, 3)
        self.assertEqual(projects._queue.get_nowait(), ("more", p.id, 3))
        self.assertEqual((p.status, p.more_from), ("selecting", 2))
        self.assertFalse(p.public()["can_more"])

    def test_more_is_refused_while_running_for_filming_or_out_of_range(self):
        p = self.finished_project()
        for count in (0, 11):
            with self.assertRaises(ValueError):
                projects.more(p, count)
        p.status = "clipping"
        with self.assertRaises(ValueError):
            projects.more(p, 2)
        film = self.finished_project(mode="filming")
        self.assertFalse(film.public()["can_more"])
        with self.assertRaises(ValueError):
            projects.more(film, 2)

    def test_new_clips_are_numbered_after_the_old_ones_and_avoid_every_earlier_clip(self):
        p = self.finished_project()
        sibling = self.finished_project(clips=1)  # an earlier project on the same video
        sibling.clips[0].update(start=300.0, end=340.0, title="Clip lain")
        sibling.save()
        rendered = []

        def attempt(project, clip, words, opts, base, share):
            rendered.append(clip["n"])
            clip["status"] = "done"

        with patch.object(projects.select, "pick_clips",
                          return_value=[select.Pick(400, 440, "Baru A", ""), select.Pick(500, 540, "Baru B", "")]) as pick, \
                patch.object(projects, "_attempt_clip", side_effect=attempt), \
                patch.object(projects, "_clip_options", return_value={}):
            projects.more(p, 2)
            projects._more(p, 2)

        kwargs = pick.call_args.kwargs
        self.assertEqual(sorted(kwargs["exclude"]), [(0.0, 50.0), (100.0, 150.0), (300.0, 340.0)])
        self.assertEqual({c.title for c in kwargs["avoid"]}, {"Clip 1", "Clip 2", "Clip lain"})
        self.assertEqual(rendered, [3, 4])  # only the new clips are rendered
        self.assertEqual([c["n"] for c in p.clips], [1, 2, 3, 4])
        self.assertEqual([c["video"] for c in p.clips[:2]], ["01.mp4", "02.mp4"])
        self.assertEqual((p.status, p.more_from, p.notice), ("done", None, None))

    def test_running_out_of_new_moments_keeps_the_project_done(self):
        p = self.finished_project()
        with patch.object(projects.select, "pick_clips",
                          side_effect=ValueError("no new moments left that differ from earlier clips")):
            projects.more(p, 2)
            projects._more(p, 2)
        self.assertEqual(p.status, "done")
        self.assertEqual(len(p.clips), 2)
        self.assertIn("Tidak ada momen baru", p.notice)

    def test_a_second_ask_fills_picks_dropped_as_duplicates(self):
        p = self.finished_project()
        answers = [[select.Pick(400, 440, "Baru A", "")], [select.Pick(500, 540, "Baru B", "")]]
        with patch.object(projects.select, "pick_clips", side_effect=answers) as pick, \
                patch.object(projects, "_attempt_clip", side_effect=lambda *a: a[1].update(status="done")), \
                patch.object(projects, "_clip_options", return_value={}):
            projects.more(p, 2)
            projects._more(p, 2)
        self.assertEqual(pick.call_count, 2)
        self.assertIn((400, 440), pick.call_args_list[1].kwargs["exclude"])
        self.assertEqual([c["title"] for c in p.clips[2:]], ["Baru A", "Baru B"])

    def test_stopping_gen_more_keeps_earlier_and_finished_new_clips(self):
        p = self.finished_project()
        projects.more(p, 2)
        p.clips += [{"n": 3, "start": 400, "end": 440, "title": "A", "status": "done"},
                    {"n": 4, "start": 500, "end": 540, "title": "B", "status": "rendering"}]
        p.status = "clipping"
        p.save()
        stopped = projects.stop(p)
        self.assertEqual(stopped.status, "done")
        self.assertEqual([c["n"] for c in stopped.clips], [1, 2, 3])
        self.assertIsNone(stopped.more_from)

    def test_worker_tells_the_project_process_it_is_a_gen_more_run(self):
        p = self.finished_project()
        projects.more(p, 4)
        projects._queue.put(None)

        class Done:
            def wait(self):
                return 0

        with patch.object(projects, "_start_project", return_value=Done()) as start:
            projects._worker()
        start.assert_called_once_with(p.id, ["more", 4])


class DuplicateGuardTests(unittest.TestCase):
    words = (sentence("Rahasia lari pagi adalah pemanasan lima menit sebelum berangkat.", 0, 1.0)
             + sentence("Cerita kucing tetangga yang masuk dapur kemarin malam lucu sekali.", 20, 1.0)
             + sentence("Rahasia lari pagi adalah pemanasan lima menit sebelum berangkat.", 40, 1.0))

    def test_same_wording_at_another_time_is_a_duplicate(self):
        earlier = select.Pick(0, 10, "Pemanasan sebelum lari", "")
        self.assertIs(select.duplicate_of(self.words, select.Pick(40, 50, "Tips pagi", ""), [earlier]), earlier)
        self.assertIsNone(select.duplicate_of(self.words, select.Pick(20, 31, "Kucing masuk dapur", ""), [earlier]))

    def test_overlap_and_near_identical_titles_are_duplicates(self):
        earlier = select.Pick(0, 10, "Kenapa Titan makan manusia?", "")
        self.assertIs(select.duplicate_of(self.words, select.Pick(8, 15, "Lain", ""), [earlier]), earlier)
        self.assertIs(select.duplicate_of(self.words, select.Pick(20, 31, "Kenapa Titan makan manusia", ""), [earlier]),
                      earlier)

    def test_pick_clips_drops_duplicates_and_tells_the_model_about_earlier_clips(self):
        earlier = select.Pick(0, 10, "Pemanasan sebelum lari", "")
        answer = {"clips": [{"start": 40, "end": 50, "title": "Tips pagi", "reason": ""},
                            {"start": 20, "end": 31, "title": "Kucing masuk dapur", "reason": ""}]}
        with patch.object(select.keys, "ask_json", return_value=answer) as ask:
            picks = select.pick_clips(self.words, 2, 12, "id", exclude=[(0, 10)], avoid=[earlier])
        self.assertEqual([p.title for p in picks], ["Kucing masuk dapur"])
        self.assertIn("Pemanasan sebelum lari", ask.call_args.args[1])

    def test_pick_clips_never_returns_two_versions_of_one_moment(self):
        answer = {"clips": [{"start": 0, "end": 10, "title": "Rahasia lari pagi", "reason": ""},
                            {"start": 40, "end": 50, "title": "Pemanasan lima menit", "reason": ""}]}
        with patch.object(select.keys, "ask_json", return_value=answer):
            picks = select.pick_clips(self.words, 2, 12, "id")
        self.assertEqual(len(picks), 1)


if __name__ == "__main__":
    unittest.main()
