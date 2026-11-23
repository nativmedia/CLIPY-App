import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from clipy import projects


class DeleteProjectFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data, self.exports = root / "data", root / "exports"
        self.data.mkdir()
        self.exports.mkdir()
        self.patches = [patch.object(projects, "DATA_DIR", self.data), patch.object(projects, "_projects", {}),
                        patch.object(projects, "_active", None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def make(self, status="done"):
        p = projects.Project("abc123", "", "Judul Video", {}, status=status, export_dir=str(self.exports))
        p.dir.mkdir()
        p.export_output_dir.mkdir()
        (p.export_output_dir / "clip.mp4").write_bytes(b"x")
        (self.exports / "punya-user.txt").write_text("keep")
        projects._projects[p.id] = p
        return p

    def test_done_project_is_deleted_and_exports_kept_by_default(self):
        p = self.make()
        self.assertEqual(projects.delete(p), {"files_removed": False})
        self.assertFalse(p.dir.exists())
        self.assertTrue(p.export_output_dir.exists())

    def test_files_option_removes_only_the_project_export_folder(self):
        p = self.make()
        self.assertEqual(projects.delete(p, remove_files=True), {"files_removed": True})
        self.assertFalse(p.export_output_dir.exists())
        self.assertTrue((self.exports / "punya-user.txt").exists())

    def test_working_project_cannot_be_deleted(self):
        p = self.make(status="clipping")
        with self.assertRaises(ValueError):
            projects.delete(p, remove_files=True)
        self.assertTrue(p.export_output_dir.exists())


if __name__ == "__main__":
    unittest.main()
