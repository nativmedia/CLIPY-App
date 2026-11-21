import subprocess
import sys
import tempfile
import unittest
import wave
from array import array
from pathlib import Path
from unittest.mock import patch

from clipy import media, transcribe


class FfmpegRunnerTests(unittest.TestCase):
    def test_audio_extraction_preserves_stream_offset_and_timestamp_gap(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.mkv'
            audio = Path(folder) / 'audio.wav'
            subprocess.run([
                'ffmpeg', '-y', '-v', 'error',
                '-f', 'lavfi', '-i', 'color=black:s=160x120:r=25:d=4',
                '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=3',
                '-af', "aselect='not(between(t,0.8,1.3))',asetpts=PTS+0.375/TB",
                '-c:v', 'libx264', '-c:a', 'pcm_s16le', str(source),
            ], check=True)

            media.extract_audio(source, audio)

            with wave.open(str(audio)) as output:
                self.assertEqual((output.getnchannels(), output.getsampwidth(), output.getframerate()), (1, 2, 16000))
                samples = array('h', output.readframes(output.getnframes()))
            if sys.byteorder == 'big':
                samples.byteswap()
            first_tone = next(index for index, sample in enumerate(samples) if abs(sample) > 100)
            self.assertAlmostEqual(first_tone / 16000, 0.375, delta=0.002)
            self.assertLess(max(map(abs, samples[20480:23040])), 100)  # 1.28–1.44 s is silent.
            self.assertGreater(max(map(abs, samples[28800:30400])), 100)  # Tone resumes by 1.8 s.
            self.assertAlmostEqual(len(samples) / 16000, 3.375, delta=0.002)

            with transcribe.audio_for_alignment(str(audio)) as (aligned, offset):
                self.assertAlmostEqual(offset, 0.365, delta=0.002)
                with wave.open(aligned) as trimmed:
                    self.assertAlmostEqual(trimmed.getnframes() / 16000 + offset, 3.375, delta=0.002)
            self.assertFalse(Path(aligned).exists())

    def test_large_stderr_does_not_block_progress(self):
        # A child writes more than an OS pipe can hold before reporting progress.
        real_popen = subprocess.Popen
        script = "import sys; sys.stderr.write('x'*262144); sys.stderr.flush(); print('out_time_us=500000', flush=True)"
        def spawn(*args, **kwargs):
            return real_popen([sys.executable, '-c', script], **kwargs)
        progress = []
        with tempfile.TemporaryDirectory() as folder, patch.object(media, 'video_encoders', return_value=[[]]), patch.object(media.subprocess, 'Popen', side_effect=spawn):
            media._run_ffmpeg(['output.mp4'], Path(folder), 1, progress.append)
        self.assertEqual(progress, [0.5])

    def test_failure_reports_end_of_error(self):
        real_popen = subprocess.Popen
        script = "import sys; sys.stderr.write('x'*5000 + ' useful failure'); sys.exit(1)"
        def spawn(*args, **kwargs):
            return real_popen([sys.executable, '-c', script], **kwargs)
        with tempfile.TemporaryDirectory() as folder, patch.object(media, 'video_encoders', return_value=[[]]), patch.object(media.subprocess, 'Popen', side_effect=spawn):
            with self.assertRaisesRegex(RuntimeError, 'useful failure'):
                media._run_ffmpeg(['output.mp4'], Path(folder), 1)


if __name__ == '__main__':
    unittest.main()
