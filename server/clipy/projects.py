"""
Projects: one YouTube video → several captioned shorts.

    downloading   audio of the whole video (or, for an uploaded file, just its sound)
    transcribing  Whisper large-v3 on the GPU, word timestamps
    selecting     the LLM behind the stored key picks the clips
    clipping      per clip: fetch the section, frame the speaker, render with captions,
                  thumbnail, dubbed intro

One scheduler runs projects in order, each in its own process. Everything for a
project lives in data/projects/<id>/, and project.json survives server restarts.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from urllib.parse import quote
import re

from . import captions, emphasis, framing, laughter, media, select, social, thumbs, tts, uploads
from .captions import CaptionStyle, Word

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "projects"
TERMINAL = {"done", "error", "cancelled"}

# Share of the progress bar for each stage; clipping is split evenly between clips.
STAGES = {"queued": (0, 0), "downloading": (0, 0.08), "transcribing": (0.08, 0.4), "selecting": (0.4, 0.45), "clipping": (0.45, 1.0)}

_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def clip_file_stem(clip: dict) -> str:
    """A readable, Windows- and FFmpeg-safe base name for final deliverables."""
    number = int(clip.get("n", 0) or 0)
    title = re.sub(r"[^\w -]+", " ", str(clip.get("title") or "clip"), flags=re.UNICODE)
    title = re.sub(r"\s+", " ", title).strip(" .")[:100].rstrip(" .") or "clip"
    if title.upper() in _WINDOWS_RESERVED:
        title = f"_{title}"
    return f"{number:02d} - {title}"


@dataclass
class Project:
    id: str
    url: str
    video_id: str
    settings: dict
    title: str = ""
    duration: float = 0
    language: str | None = None
    status: str = "queued"
    progress: float = 0.0
    stage: str = "queued"
    error: str | None = None
    clips: list[dict] = field(default_factory=list)
    upload: str | None = None
    logo: str | None = None
    subtitle: str | None = None
    music: str | None = None
    music_url: str | None = None
    transcript_origin: str | None = None
    transcript_note: str | None = None
    transcript_timing: str | None = None
    transcription_backend: str | None = None
    transcription_note: str | None = None
    # Set when the video came from the user's computer instead of YouTube.
    upload_id: str | None = None
    # Set when this is a re-clip of a video done before: that project's transcript is reused.
    reuse_from: str | None = None
    # A folder explicitly picked by the local user for a copy of completed results.
    export_dir: str | None = None
    export_status: str | None = None
    export_error: str | None = None
    # Clip count before a "gen more" run, so stopping it keeps the earlier clips.
    more_from: int | None = None
    # A short, non-fatal message for the project card (e.g. no new moments left).
    notice: str | None = None
    created: float = field(default_factory=time.time)

    @property
    def local_video(self) -> Path | None:
        return uploads.path_of(self.upload_id) if self.upload_id else None

    @property
    def source_key(self) -> str:
        """Same for every project made from the same video, wherever it came from."""
        return f"upload:{self.upload_id}" if self.upload_id else f"youtube:{self.video_id}"

    @property
    def dir(self) -> Path:
        return DATA_DIR / self.id

    @property
    def export_output_dir(self) -> Path | None:
        if not self.export_dir:
            return None
        safe_title = "".join(ch if ch.isalnum() or ch in " -_" else " " for ch in self.title).strip()
        safe_title = "-".join(safe_title.split())[:60] or "project"
        return Path(self.export_dir) / f"CLIPY-{safe_title}-{self.id}"

    def clip_asset_name(self, clip: dict, extension: str) -> str:
        return f"{clip_file_stem(clip)}.{extension.lstrip('.')}"

    def clip_asset_path(self, clip: dict, extension: str) -> Path:
        return self.dir / self.clip_asset_name(clip, extension)

    def file_url(self, name: str) -> str:
        return f"/api/projects/{self.id}/files/{quote(name, safe='')}"

    def public(self) -> dict:
        d = asdict(self)
        d.pop("upload")
        d.pop("export_dir")
        d["has_export_dir"] = self.export_output_dir is not None
        d["export_ready"] = bool(self.export_output_dir and self.export_output_dir.is_dir())
        d["has_logo"] = bool(d.pop("logo"))
        d["can_more"] = (self.status in ("done", "error") and self.settings.get("mode", "clipping") != "filming"
                          and (self.dir / "words.json").exists())
        d["progress"] = round(self.progress, 3)
        # Always the source video's own thumbnail, so projects are easy to recognise.
        if self.video_id:
            d["thumbnail"] = f"https://i.ytimg.com/vi/{self.video_id}/mqdefault.jpg"
        else:
            d["thumbnail"] = self.file_url("poster.jpg") if (self.dir / "poster.jpg").exists() else ""
        for c in d["clips"]:
            for key in ("video", "thumb", "srt", "ass"):
                if c.get(key):
                    c[key] = self.file_url(c[key])
        return d

    def save(self) -> None:
        tmp = self.dir / "project.json.tmp"
        tmp.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        # Windows may briefly lock the destination while the API reads a checkpoint.
        for attempt in range(5):
            try:
                tmp.replace(self.dir / "project.json")
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.02)


_projects: dict[str, Project] = {}
_queue: queue.Queue[str | tuple | None] = queue.Queue()
_lock = threading.RLock()
_active: tuple[str, subprocess.Popen] | None = None
_scheduler: threading.Thread | None = None
_shutting_down = False


def _terminate(process: subprocess.Popen) -> None:
    if process.poll() is None:
        if os.name == "nt":
            result = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                    capture_output=True, timeout=3, creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode and process.poll() is None:
                raise OSError("Windows gagal menghentikan proses proyek")
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    process.wait(timeout=2)


def stop(p: Project) -> Project:
    with _lock:
        current = get(p.id)
        if current is None or current.status in ("done", "error"):
            raise ValueError("Proyek sudah berhenti")
        if current.status != "cancelled":
            if _active and _active[0] == p.id:
                _terminate(_active[1])
                current = _checkpoint(p.id) or current
            if current.more_from is not None:
                # Stopping "gen more" keeps the project as it was, plus any new clip already finished.
                kept = current.clips[:current.more_from] + [c for c in current.clips[current.more_from:]
                                                            if c.get("status") == "done"]
                current = replace(current, status="done", stage="done", progress=1.0, error=None, clips=kept,
                                  more_from=None, notice="Gen more dihentikan.")
                current.save()
                _projects[p.id] = current
                return current
            clips = [clip if clip.get("status") == "done" else
                     {**clip, "status": "cancelled", "video": None, "thumb": None, "srt": None}
                     for clip in current.clips]
            current = replace(current, status="cancelled", stage="dihentikan", error=None, clips=clips)
            current.save()
            _projects[p.id] = current
        return current


def _active_running(project_id: str) -> bool:
    if _active is None or _active[0] != project_id:
        return False
    poll = getattr(_active[1], "poll", None)
    return True if poll is None else poll() is None


def delete_stopped(p: Project) -> None:
    with _lock:
        current = _projects.get(p.id)
        if (current is None or current.status not in ("cancelled", "error")
                or _active_running(current.id)):
            raise ValueError("Tunggu hingga proses berhenti")
        if p.dir.resolve().parent != DATA_DIR.resolve() or p.dir.is_symlink():
            raise ValueError("Folder proyek tidak valid")
        shutil.rmtree(p.dir)
        _projects.pop(p.id, None)


def _checkpoint(project_id: str) -> Project | None:
    try:
        return Project(**json.loads((DATA_DIR / project_id / "project.json").read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return None


def _load(*, interrupted: bool = False) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for f in DATA_DIR.glob("*/project.json"):
        p = _checkpoint(f.parent.name)
        if p is None:
            continue
        if interrupted and p.status not in TERMINAL:
            p.status, p.error, p.stage = "error", "interrupted: the server restarted", "interrupted"
            p.save()
        if p.status in TERMINAL and migrate_clip_assets(p):
            p.save()
        _projects[p.id] = p


def migrate_clip_assets(p: Project) -> bool:
    """Give legacy final outputs the same readable names used by new projects."""
    changed = False
    for clip in p.clips:
        if not isinstance(clip.get("n"), int):
            continue
        n = clip["n"]
        for key, extension, legacy in (
            ("video", "mp4", (f"clip_{n}.mp4",)),
            ("srt", "srt", (f"clip_{n}.srt",)),
            ("ass", "ass", (f"clip_{n}.ass", f"film_{n}.ass")),
        ):
            current = clip.get(key)
            candidates = [current] if isinstance(current, str) and Path(current).name == current else []
            candidates.extend(name for name in legacy if name not in candidates)
            source = next((p.dir / name for name in candidates if (p.dir / name).is_file()), None)
            if source is None:
                continue
            target = p.clip_asset_path(clip, extension)
            if source != target and not target.exists():
                source.replace(target)
            if target.is_file() and clip.get(key) != target.name:
                clip[key] = target.name
                changed = True
    return changed


def create(url: str, video_id: str, settings: dict, upload_id: str | None = None, title: str = "",
           reuse_from: str | None = None, export_dir: str | None = None) -> Project:
    p = Project(id=uuid.uuid4().hex[:12], url=url, video_id=video_id, settings=settings, upload_id=upload_id,
                title=title, reuse_from=reuse_from, export_dir=export_dir,
                export_status="pending" if export_dir else None)
    p.dir.mkdir(parents=True, exist_ok=True)
    p.save()
    return p


def reclip(base: Project, settings: dict, export_dir: str | None = None) -> Project:
    """A new project on the same video as `base`, reusing its transcript."""
    return create(base.url, base.video_id, settings, base.upload_id, base.title, reuse_from=base.id,
                  export_dir=export_dir)


def used_ranges(source_key: str, skip: str | None = None) -> list[tuple[float, float]]:
    """Every stretch of this video already picked as a clip, in any project."""
    return sorted(
        (float(c["start"]), float(c["end"]))
        for p in all_projects()
        if p.source_key == source_key and p.id != skip
        for c in p.clips
        if "start" in c and "end" in c
        and (p.status != "cancelled" or c.get("status") == "done")
    )


def used_clips(source_key: str) -> list[select.Pick]:
    """Every clip already made from this video (any project), with its title."""
    return sorted(
        (select.Pick(float(c["start"]), float(c["end"]), str(c.get("title", "")), "")
         for p in all_projects()
         if p.source_key == source_key
         for c in p.clips
         if "start" in c and "end" in c
         and (p.status != "cancelled" or c.get("status") == "done")),
        key=lambda pick: pick.start,
    )


def sources() -> list[dict]:
    """
    Every video clipped before whose transcript is still on disk, newest first: what the
    "local project" picker offers for clipping again.
    """
    by_key: dict[str, list[Project]] = {}
    for p in all_projects():
        if p.transcript_origin in ("hyperframes-demo", "ffmpeg-demo"):
            continue
        if (p.dir / "words.json").exists() and (not p.upload_id or p.local_video):
            by_key.setdefault(p.source_key, []).append(p)
    out = []
    for key, group in by_key.items():
        group.sort(key=lambda p: p.created, reverse=True)
        latest = group[0]
        out.append({
            "key": key,
            "project": latest.id,
            "kind": "upload" if latest.upload_id else "youtube",
            "title": latest.title,
            "url": latest.url,
            "video_id": latest.video_id,
            "upload_id": latest.upload_id,
            "duration": latest.duration,
            "thumbnail": latest.public()["thumbnail"],
            "projects": len(group),
            "clips_used": len(used_ranges(key)),
            "last_used": latest.created,
        })
    # Uploaded videos never turned into a project yet: listed too, they just start from scratch.
    for meta in uploads.all_meta():
        if f"upload:{meta['id']}" in by_key:
            continue
        out.append({
            "key": f"upload:{meta['id']}",
            "project": None,
            "kind": "upload",
            "title": meta["name"].rsplit(".", 1)[0],
            "url": "",
            "video_id": "",
            "upload_id": meta["id"],
            "duration": meta.get("duration", 0),
            "thumbnail": f"/api/uploads/{meta['id']}/poster",
            "projects": 0,
            "clips_used": 0,
            "last_used": meta["created"],
        })
    return sorted(out, key=lambda s: s["last_used"], reverse=True)


def enqueue(p: Project) -> None:
    with _lock:
        _projects[p.id] = p
        _queue.put(p.id)


def restart_unstarted(p: Project) -> Project:
    """Requeue an unstarted stopped/failed project without losing its inputs."""
    with _lock:
        current = _projects.get(p.id)
        if (current is not p or current.status not in ("cancelled", "error")
                or current.progress != 0 or current.clips
                or (_active is not None and _active[0] == p.id)):
            raise ValueError("Proyek ini tidak dapat dimulai ulang dari awal")
        queued = replace(current, status="queued", stage="queued", error=None)
        queued.save()
        _projects[queued.id] = queued
        _queue.put(queued.id)
        return queued


def get(project_id: str) -> Project | None:
    with _lock:
        p = _projects.get(project_id)
        if p and p.status != "cancelled" and _active and _active[0] == project_id:
            p = _checkpoint(project_id) or p
            _projects[project_id] = p
        return p


def all_projects() -> list[Project]:
    with _lock:
        if _active:
            get(_active[0])
        return sorted(_projects.values(), key=lambda p: p.created, reverse=True)


# ---------- pipeline ----------

def update_busy() -> bool:
    """Prevent an installer from stopping a running or queued project."""
    with _lock:
        return _active is not None or any(p.status not in TERMINAL for p in _projects.values())


def _stage(p: Project, status: str, stage: str | None = None) -> None:
    p.status = status
    p.stage = stage or status
    p.progress = STAGES[status][0]
    p.save()


def _span(p: Project, lo: float, hi: float):
    last_saved = 0.0

    def report(x: float) -> None:
        nonlocal last_saved
        p.progress = lo + (hi - lo) * x
        now = time.monotonic()
        if now - last_saved >= 0.5:
            p.save()
            last_saved = now

    return report


def _clip_options(p: Project):
    clip_cfg = p.settings["clip"]
    width, height = media.RATIOS[clip_cfg["ratio"]]
    brand = p.settings.get("brand") or {}
    # One branding image (logo and/or text, at its final size and opacity) for every clip.
    mark = thumbs.build_brand(
        p.dir / "brand.png", width, height,
        p.dir / p.logo if p.logo else None,
        brand.get("text") or "", brand.get("style") or "outline", int(brand.get("opacity") or 100),
    )
    return {
        "width": width,
        "height": height,
        "fit": clip_cfg["fit"],
        "clip_ratio": clip_cfg.get("clip_ratio"),
        "background": clip_cfg.get("background") or "black",
        "background_inset": clip_cfg.get("background_inset", False),
        "style": CaptionStyle(**p.settings["caption"]),
        "thumb_cfg": p.settings["thumb"],
        "dubbing_speed": clip_cfg.get("dubbing_speed", 1.0),
        "brand": mark,
        "brand_position": brand.get("position") or "bc",
    }


def _load_words(p: Project) -> list[Word]:
    return [Word(**w) for w in json.loads((p.dir / "words.json").read_text(encoding="utf-8"))]


def _save_words(p: Project, words: list[Word]) -> None:
    tmp = p.dir / "words.json.tmp"
    tmp.write_text(json.dumps([asdict(w) for w in words], ensure_ascii=False), encoding="utf-8")
    tmp.replace(p.dir / "words.json")


def _local_words(words: list[Word], start: float, end: float) -> list[Word]:
    """Return words visible in a clip, preserving overlap at either edge."""
    local = []
    for word in captions.expand_coarse_words(words):
        word_start = max(word.start, start)
        word_end = min(word.end, end)
        if word_end > word_start:
            local.append(Word(word.text, word_start - start, word_end - start))
    return local


def _transcribe_clip(source: Path, duration: float, on_progress) -> list[Word]:
    """Get word onsets from the audio that will actually appear in the clip."""
    wav = source.with_suffix(".caption.wav")
    try:
        from . import transcribe

        media.extract_audio(source, wav)
        words, _ = transcribe.transcribe(str(wav), on_progress=on_progress)
        return _local_words(words, 0, duration)
    except (OSError, RuntimeError, ValueError, ImportError, subprocess.SubprocessError):
        traceback.print_exc()
        return []
    finally:
        wav.unlink(missing_ok=True)


def _run(p: Project) -> None:
    if p.music_url and not p.music:
        from . import music
        _stage(p, "downloading", "mengambil musik")
        p.music = music.download(p.music_url, p.dir).name
        p.save()
    clip_cfg = p.settings["clip"]
    opts = _clip_options(p)

    local = p.local_video
    base = get(p.reuse_from) if p.reuse_from else None
    if p.subtitle:
        from . import subtitles
        _stage(p, "downloading", "reading source and subtitle")
        if base:
            p.title, p.duration = p.title or base.title, base.duration
            if (base.dir / "poster.jpg").exists():
                shutil.copy(base.dir / "poster.jpg", p.dir / "poster.jpg")
        elif p.upload_id:
            if not local:
                raise FileNotFoundError("the uploaded video is gone; upload it again")
            p.duration = media.probe_duration(local)
            media.poster(local, p.dir / "poster.jpg")
        else:
            info = media.video_info(p.url)
            p.title, p.duration = info.get("title", ""), float(info.get("duration") or 0)
        if not 0 < p.duration <= 4 * 3600:
            raise ValueError("Durasi video tidak valid atau lebih dari 4 jam")
        _stage(p, "transcribing", "using uploaded subtitle")
        words = subtitles.parse_srt((p.dir / "source.srt").read_bytes())
        if max(w.end for w in words) > p.duration + 0.5:
            raise ValueError("Waktu subtitle melewati durasi video; pastikan SRT sesuai video")
        p.language = None
        p.transcript_origin = "srt"
        p.transcription_backend = None
        p.transcript_note = 'Subtitle yang diunggah pengguna.'
        _save_words(p, words)
    elif (base and p.upload_id and (base.dir / "words.json").exists()
          and not (p.settings.get("mode", "clipping") == "clipping"
                   and (base.transcript_origin == "srt" or base.subtitle))):
        # Clipping a video done before: its transcript is already here, so skip straight on.
        _stage(p, "downloading", "reusing transcript")
        tmp = p.dir / "words.json.tmp"
        shutil.copyfile(base.dir / "words.json", tmp)
        tmp.replace(p.dir / "words.json")
        if (base.dir / "poster.jpg").exists():
            shutil.copy(base.dir / "poster.jpg", p.dir / "poster.jpg")
        p.title, p.duration, p.language = p.title or base.title, base.duration, base.language
        p.transcript_origin = base.transcript_origin or ("srt" if base.subtitle else "whisper")
        p.transcript_note = getattr(base, 'transcript_note', None)
        p.transcript_timing = getattr(base, 'transcript_timing', None)
        p.transcription_backend = getattr(base, 'transcription_backend', None)
        p.transcription_note = getattr(base, 'transcription_note', None)
        words = _load_words(p)
    else:
        words = None
        if p.upload_id:
            # A video from the user's computer: nothing to download, just read its sound.
            if not local:
                raise FileNotFoundError("the uploaded video is gone; upload it again")
            _stage(p, "downloading", "reading video")
            p.duration = media.probe_duration(local)
            media.poster(local, p.dir / "poster.jpg")
            audio = media.extract_audio(local, p.dir / "audio.wav")
        else:
            _stage(p, "downloading", "memeriksa subtitle YouTube")
            info = media.video_info(p.url)
            p.title, p.duration = info.get("title", ""), float(info.get("duration") or 0)
            if not 0 < p.duration <= 4 * 3600:
                raise ValueError("Durasi video tidak valid atau lebih dari 4 jam")
            from . import youtube_transcript
            words, origin, p.language, reason, precision = youtube_transcript.fetch(
                info, prefer_word_timing=p.settings.get("mode", "clipping") == "clipping")
            if words:
                p.transcript_origin = origin
                p.transcript_timing = precision
                p.transcript_note = ('Timestamp per kata dari YouTube.' if precision == 'kata' else
                                     'Timestamp per segmen; ketepatan batas kata tidak dapat dipastikan.')
                p.transcription_backend = None
                p.transcription_note = None
                p.save()
            else:
                p.transcript_note = reason + ' Menggunakan transkripsi lokal.'
                p.save()
                _stage(p, "downloading", "mengunduh audio untuk transkripsi lokal")
                audio_src = media.download_audio(p.url, p.dir, _span(p, *STAGES["downloading"]))
                audio = media.extract_audio(audio_src, p.dir / "audio.wav")
                audio_src.unlink(missing_ok=True)
        if p.duration > 4 * 3600:
            raise ValueError("videos over 4 hours aren't supported")

        if words is None:
            _stage(p, "transcribing", "menyiapkan transkripsi lokal")
            # Imported here so the API can start while model libraries load.
            from . import transcribe
            def status(backend, reason):
                p.transcription_backend, p.transcription_note = backend, reason or None
                p.stage = f"transkripsi · {backend}"
                p.save()
            words, p.language = transcribe.transcribe(str(audio), None, _span(p, *STAGES["transcribing"]), on_status=status)
            p.transcript_origin = "whisper"
            p.transcript_timing = "kata"
            audio.unlink(missing_ok=True)
        _save_words(p, words)

    _stage(p, "selecting", "picking new clips" if p.reuse_from else "picking clips")
    if p.settings.get("mode") == "filming":
        from . import film
        cfg = p.settings["film"]
        _stage(p, "selecting", "planning story episodes from transcript")
        episodes = film.plan(words, p.duration, cfg, speed=opts["dubbing_speed"])
        if getattr(p, 'transcript_timing', None) == 'segmen' and len(episodes) > 1:
            lengths = [sum(float(shot['end']) - float(shot['start']) for shot in ep['shots']) for ep in episodes]
            if max(lengths) - min(lengths) > 3:
                p.transcript_note = (p.transcript_note or '') + ' Durasi antarbagiannya berbeda lebih dari 3 detik.'
                p.save()
        p.clips = [{"n": i + 1, "start": ep["shots"][0]["start"], "end": ep["shots"][-1]["end"],
                    "title": str(ep.get("title", f"Episode {i+1}"))[:80],
                    "reason": str(ep.get("reason", ""))[:300], "narration": str(ep["narration"]),
                    "shots": ep["shots"], "status": "pending"} for i, ep in enumerate(episodes)]
        _stage(p, "clipping", f"episode 1/{len(p.clips)}")
        for i, clip in enumerate(p.clips):
            p.stage = f"episode {i+1}/{len(p.clips)}"
            clip["status"] = "rendering"
            p.save()
            try:
                film.render(p, clip, opts, cfg)
            except Exception as e:
                clip["status"], clip["error"] = "error", str(e) or e.__class__.__name__
                p.save()
                raise
            clip["status"] = "done"
            p.progress = 0.45 + 0.55 * (i + 1) / len(p.clips)
            p.save()
        p.status, p.stage, p.progress = "done", "done", 1.0
        _export_results(p)
        p.save()
        return
    # Never hand back a moment this video has already been clipped at.
    def uncertain_boundary():
        p.transcript_note = 'Batas clip diperkirakan karena timestamp subtitle tidak cukup rinci.'
        p.save()
    picks = select.pick_clips(words, int(clip_cfg["count"]), float(clip_cfg["max_duration"]), p.language,
                              exclude=used_ranges(p.source_key, skip=p.id), mood=p.settings.get("mood", "auto"),
                              allow_approximate=getattr(p, 'transcript_timing', None) == 'segmen',
                              on_approximate=uncertain_boundary,
                              objective=p.settings.get('objective', ''),
                              avoid=[c for c in used_clips(p.source_key) if c.title])
    if getattr(p, 'transcript_timing', None) == 'segmen' and len(picks) > 1:
        lengths = [item.end - item.start for item in picks]
        if max(lengths) - min(lengths) > 3:
            p.transcript_note = (p.transcript_note or '') + ' Durasi antarclip berbeda lebih dari 3 detik.'
            p.save()
    p.clips = [
        {"n": i + 1, "start": c.start, "end": c.end, "title": c.title, "reason": c.reason, "status": "pending"}
        for i, c in enumerate(picks)
    ]
    _stage(p, "clipping", f"clip 1/{len(p.clips)}")

    lo, hi = STAGES["clipping"]
    share = (hi - lo) / len(p.clips)
    for i, clip in enumerate(p.clips):
        p.stage = f"clip {i + 1}/{len(p.clips)}"
        _attempt_clip(p, clip, words, opts, lo + share * i, share)

    if not any(c["status"] == "done" for c in p.clips):
        raise RuntimeError(p.clips[0].get("error") or "no clip could be made")
    p.status, p.stage, p.progress = "done", "done", 1.0
    _export_results(p)
    p.save()


def _attempt_clip(p: Project, clip: dict, words: list[Word], opts: dict, base: float, share: float) -> None:
    clip.pop("error", None)
    clip.pop("note", None)
    try:
        _make_clip(p, clip, words, opts, base, share)
        clip["status"] = "done"
    except Exception as e:
        traceback.print_exc()
        clip["status"], clip["error"] = "error", str(e) or e.__class__.__name__
    p.save()


def _make_clip(p: Project, clip: dict, words: list[Word], opts: dict, base: float, share: float) -> None:
    from . import film
    n = clip["n"]
    d = p.dir
    width, height, fit = opts["width"], opts["height"], opts["fit"]
    thumb_cfg = opts["thumb_cfg"]
    for stale in ("video", "thumb", "srt", "ass", "intro_duration"):
        clip.pop(stale, None)

    fast = bool(clip.pop("fast_edit", False))
    clip["status"] = "downloading"
    src = d / f"src_{n}.mp4"
    window = _edit_window(p, n, clip["start"], clip["end"]) if fast and not p.upload_id else None
    if not src.exists() and window:
        # The editor already fetched this stretch at full quality: cut it locally.
        path, w0 = window
        src = media.cut_section(path, clip["start"] - w0, clip["end"] - w0, src, _span(p, base, base + share * 0.25))
    if not src.exists():
        fetched = _span(p, base, base + share * 0.25)
        if p.upload_id:
            src = media.cut_section(p.local_video, clip["start"], clip["end"], src, fetched)
        else:
            src = media.download_section(p.url, clip["start"], clip["end"], src, fetched)

    background = opts.get("background", "black")
    background_inset = opts.get("background_inset", False)
    clip_ratio = "auto" if background == "none" else opts.get("clip_ratio")
    inset = media.crop_insets(src, clip_ratio)
    has_inset = any(inset) if isinstance(inset, tuple) else bool(inset)
    if has_inset:
        clean = d / f"src_{n}_active.mp4"
        if not clean.exists():
            media.remove_letterbox(src, clean, inset, _span(p, base + share * .25, base + share * .32))
        src = clean

    local = _local_words(words, clip["start"], clip["end"])
    duration = clip["end"] - clip["start"]
    timing = p.transcript_timing
    reused = _reuse_caption_words(p, clip, words) if fast else None
    if reused is not None:
        caption_words, emphasized = reused
    elif timing == "segmen" or (timing is None and p.transcript_origin == "whisper"):
        # Segment tracks still guide selection. Get real onsets for the chosen
        # cut, including old Whisper checkpoints made before audio PTS sync.
        clip["status"] = "transcribing"
        p.save()
        local = _transcribe_clip(src, duration, _span(p, base + share * .32, base + share * .39)) or local
    if reused is None:
        # Word-sized entries let emphasis target single words even when the
        # transcript only had segment timing.
        caption_words = captions.expand_coarse_words(laughter.caption_words(src, local, duration))
        caption_words = apply_caption_fixes(caption_words, clip.get("caption_fixes") or [], clip["start"])
        emphasized = emphasis.choose(src, caption_words, getattr(p, "language", None))
    _save_caption_words(p, clip, caption_words, emphasized)
    ass = p.clip_asset_path(clip, "ass")
    srt = p.clip_asset_path(clip, "srt")
    ass.write_text(captions.build_ass(caption_words, opts["style"], width, height, emphasized=emphasized), encoding="utf-8")

    source_ratio = film._source_ratio(src) if clip_ratio is not None else None
    plan = None
    if fit == "crop" and clip_ratio not in ("none", "blackbar"):
        clip["status"] = "framing"
        try:
            frame_width, frame_height = (media.clip_frame_size(width, clip_ratio, source_ratio, output_height=height)
                                         if clip_ratio is not None and source_ratio is not None else (width, height))
            key = {"frame": [frame_width, frame_height], "inset": list(inset) if isinstance(inset, tuple) else bool(inset)}
            plan = _reuse_plan(p, clip, src, key, local) if fast else None
            if plan is None:
                plan = framing.plan_crop(src, frame_width, frame_height, local)
            _save_plan(p, clip, plan, key)
        except Exception:
            # Framing is a nicety; a centre crop is still a usable short.
            traceback.print_exc()
        p.progress = base + share * 0.4

    clip["status"] = "rendering"
    voice = thumb_cfg.get("voice")
    body = d / f"body_{n}.mp4"
    # Without a dubbed intro, the title shows over the opening seconds instead.
    title = None if voice else thumbs.title_overlay(d / f"title_{n}.png", width, height, clip["title"], thumb_cfg.get("title_style", "bold"))
    media.render_clip(src, ass, body, width, height, fit, _span(p, base + share * 0.4, base + share * 0.85),
                      opts["brand"], opts["brand_position"], plan, title,
                      clip_ratio=clip_ratio, background=background, source_ratio=source_ratio,
                      background_inset=background_inset)

    clip["status"] = "thumbnail"
    thumb = d / f"thumb_{n}.jpg"
    if not (fast and thumb.exists()):
        # An edit keeps the clip's title, so its thumbnail can stay as it is.
        frame = d / f"frame_{n}.jpg"
        if thumb_cfg.get("source") == "upload" and p.upload:
            thumbs.prepare(d / p.upload, frame, width, height)
        else:
            media.grab_frame(src, frame, width, height, fit, plan, clip_ratio=clip_ratio,
                             background=background, source_ratio=source_ratio, background_inset=background_inset)
        title_text = thumbs.thumbnail_text(thumb_cfg, clip, " ".join(w.text for w in local))
        thumbs.add_title(frame, thumb, clip["title"], "none" if thumb_cfg.get("text_mode") == "none" else thumb_cfg.get("title_style", "bold"), custom_text=title_text,
                         number=n, sequence=thumb_cfg.get("sequence") or ("number" if thumb_cfg.get("numbered") else "off"),
                         position=thumb_cfg.get("position"))
        frame.unlink(missing_ok=True)
        if opts["brand"]:
            thumbs.add_brand(thumb, opts["brand"], opts["brand_position"], media.brand_margin(width, height))
    clip["thumb"] = thumb.name

    out = p.clip_asset_path(clip, "mp4")
    intro_duration = 0.0
    if voice:
        clip["status"] = "dubbing"
        try:
            dub = d / f"dub_{n}.mp3"
            speech = dub if fast and dub.exists() else tts.speak(clip["title"], voice, dub, speed=opts["dubbing_speed"])
            intro_duration = media.add_intro(body, thumb, speech, out, width, height)
        except Exception as e:
            # A dubbing hiccup shouldn't cost the whole clip: keep it without the intro.
            traceback.print_exc()
            clip["note"] = f"no dubbed intro ({e or e.__class__.__name__})"
        else:
            body.unlink(missing_ok=True)
            clip["intro_duration"] = intro_duration
    if not intro_duration:
        body.replace(out)
    if getattr(p, "music", None):
        mixed = d / f"clip_{n}_music.mp4"
        media.mix_music(out, d / p.music, mixed, start=p.settings.get("music_start", 0), length=p.settings.get("music_length"))
        mixed.replace(out)
    if intro_duration:
        ass.write_text(captions.build_ass(caption_words, opts["style"], width, height,
                                         offset=intro_duration, emphasized=emphasized), encoding="utf-8")
    srt.write_text(captions.build_srt(caption_words, opts["style"], width, height, offset=intro_duration,
                                      emphasized=emphasized), encoding="utf-8")
    clip["srt"], clip["ass"] = srt.name, ass.name
    clip["video"] = out.name
    p.progress = base + share


def _write_posts(p: Project) -> None:
    """Platform titles and descriptions; best effort, the editor can regenerate them."""
    done = [c for c in p.clips if c["status"] == "done"]
    if not done:
        return
    p.stage = "writing posts"
    try:
        words = json.loads((p.dir / "words.json").read_text(encoding="utf-8"))
        social.generate(p.dir, p.title, done, words)
    except Exception:
        traceback.print_exc()


def _export_results(p: Project) -> None:
    """Copy finished deliverables to the folder selected when the project was started."""
    output = p.export_output_dir
    if output is None:
        return
    p.export_status, p.export_error = "copying", None
    p.save()
    try:
        output.mkdir(parents=True, exist_ok=True)
        names = {"dashboard-text.json", "filming-sequence.mp4", "filming-sequence.json"}
        for clip in p.clips:
            if clip.get("status") == "done":
                names.update(name for name in (clip.get("video"), clip.get("thumb"), clip.get("srt"), clip.get("ass")) if name)
        for name in names:
            source = p.dir / name
            if source.is_file():
                shutil.copy2(source, output / source.name)
        p.export_status = "done"
        p.save()
        shutil.copy2(p.dir / "project.json", output / "project.json")
    except OSError as exc:
        p.export_status, p.export_error = "error", str(exc)


def sequence_parts(p: Project) -> list[tuple[Path, float]]:
    """Return finished clips in display order, excluding thumbnail intros."""
    if p.status not in TERMINAL:
        raise ValueError("Tunggu hingga proses proyek selesai")
    parts = []
    for clip in p.clips:
        if clip.get("status") != "done":
            continue
        n = clip["n"]
        name = clip.get("video")
        if not isinstance(name, str) or Path(name).name != name:
            raise ValueError(f"Video klip {n} tidak tersedia")
        video = p.dir / name
        if not video.is_file():
            raise ValueError(f"Video klip {n} tidak tersedia")
        body = p.dir / f"body_{n}.mp4"
        if body.is_file():
            parts.append((body, 0.0))
        elif clip.get("intro_duration"):
            parts.append((video, clip["intro_duration"]))
        elif p.settings.get("mode") != "filming" and p.settings.get("thumb", {}).get("voice") and not clip.get("note", "").startswith("no dubbed intro"):
            # Older renders kept only the final video and the generated speech.
            dub = p.dir / f"dub_{n}.mp3"
            if not dub.is_file():
                raise ValueError(f"Intro thumbnail klip {n} tidak dapat dihapus: audio dubbing tidak tersedia")
            parts.append((video, float(f"{media.probe_duration(dub) + 0.4:.2f}")))
        else:
            parts.append((video, 0.0))
    if not parts:
        raise ValueError("Tidak ada klip yang selesai")
    return parts


def ensure_posts(p: Project) -> dict:
    """Saved posts, generating them first if this project has none yet (or is missing clips)."""
    data = social.load(p.dir) or {}
    done = [c for c in p.clips if c["status"] == "done"]
    if done and any(str(c["n"]) not in data for c in done):
        words = json.loads((p.dir / "words.json").read_text(encoding="utf-8"))
        data = {**data, **social.generate(p.dir, p.title, done, words)}
        social.save(p.dir, data)
    return data


# ---------- simple clip editing: extend/trim and per-word caption fixes ----------

EDIT_MIN_DURATION = 3.0


def _caption_file(p: Project, n: int) -> Path:
    return p.dir / f"caption_{n}.json"


def _save_caption_words(p: Project, clip: dict, words: list[Word], emphasized: set[int] = frozenset()) -> None:
    """The exact words a clip's captions were drawn from, in source-video seconds,
    with the ones that were emphasized, so an edit can reuse both."""
    start = float(clip["start"])
    data = {"from": start, "to": float(clip["end"]), "fixes": clip.get("caption_fixes") or [], "words": [
        {"text": w.text, "start": round(w.start + start, 3), "end": round(w.end + start, 3), **({"strong": True} if i in emphasized else {})}
        for i, w in enumerate(words)]}
    _caption_file(p, clip["n"]).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _read_caption_file(p: Project, n: int) -> dict | None:
    """{"from", "to", "words", "fixes"}: the words a render drew, and the fixes already in them."""
    path = _caption_file(p, n)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):  # written before the range was stored
        return {"from": data[0]["start"], "to": data[-1]["end"], "words": data, "fixes": None} if data else None
    return {"from": float(data["from"]), "to": float(data["to"]), "words": data["words"], "fixes": data.get("fixes") or []}


def _pending_fixes(clip: dict, saved: dict | None) -> list[dict]:
    """Fixes not yet drawn into the saved words. Applying one twice could drop a neighbour."""
    fixes = clip.get("caption_fixes") or []
    if saved is None or saved.get("fixes") is None:
        return fixes
    return [f for f in fixes if f not in saved["fixes"]]


def _reuse_caption_words(p: Project, clip: dict, words: list[Word]) -> tuple[list[Word], set[int]] | None:
    """Caption words for an edited clip without transcribing or analysing it again.

    Words inside the previous cut come back exactly as they were drawn (timing,
    laughter cues, emphasis); added stretches use the project transcript and the
    instant text rules for emphasis.
    """
    saved = _read_caption_file(p, clip["n"])
    if saved is None:
        return None
    old_from, old_to, old = saved["from"], saved["to"], saved["words"]
    start, end = float(clip["start"]), float(clip["end"])
    kept = [w for w in old if start <= (w["start"] + w["end"]) / 2 < end]
    added = [w for w in captions.expand_coarse_words(words)
             if w.end > start and w.start < end and ((w.start + w.end) / 2 < old_from or (w.start + w.end) / 2 >= old_to)]
    merged: list[tuple[Word, bool, bool]] = []  # (word, strong, new)
    for w in kept:
        merged.append((Word(w["text"], max(w["start"], start) - start, min(w["end"], end) - start), bool(w.get("strong")), False))
    for w in added:
        text = laughter.normalize_cues(w.text, w.end - w.start)
        if text:
            merged.append((Word(text, max(w.start, start) - start, min(w.end, end) - start), False, True))
    merged.sort(key=lambda item: item[0].start)
    plain = [w for w, _, _ in merged]
    fixed = apply_caption_fixes(plain, _pending_fixes(clip, saved), start)
    if [w.text for w in fixed] != [w.text for w in plain] or len(fixed) != len(plain):
        # Fixes changed the words: map emphasis back by time.
        strong_at = {round(w.start, 2) for (w, strong, _) in merged if strong}
        new_at = [(w.start, w.end) for (w, _, new) in merged if new]
        plain, merged = fixed, [(w, round(w.start, 2) in strong_at,
                                 any(a <= w.start < b for a, b in new_at)) for w in fixed]
    emphasized = {i for i, (_, strong, _) in enumerate(merged) if strong}
    fresh = {i for i, (_, _, new) in enumerate(merged) if new}
    if fresh:
        quick = emphasis.choose(None, plain, getattr(p, "language", None), use_ai=False)
        emphasized |= quick & fresh
    return plain, emphasized


def _plan_file(p: Project, n: int) -> Path:
    return p.dir / f"framing_{n}.json"


def _save_plan(p: Project, clip: dict, plan, key: dict) -> None:
    """Keep a clip's framing in source seconds so an edit only analyses what it adds."""
    path = _plan_file(p, clip["n"])
    if plan is None:
        path.unlink(missing_ok=True)
        return
    start = float(clip["start"])
    segments = [{**asdict(seg), "start": round(seg.start + start, 3)} for seg in plan.segments]
    path.write_text(json.dumps({"from": start, "to": float(clip["end"]), "key": key, "segments": segments}), encoding="utf-8")


def _reuse_plan(p: Project, clip: dict, src: Path, key: dict, local: list[Word]):
    path = _plan_file(p, clip["n"])
    if not path.exists():
        return None
    saved = json.loads(path.read_text(encoding="utf-8"))
    if saved.get("key") != key:
        return None
    start, end = float(clip["start"]), float(clip["end"])
    old_from, old_to = float(saved["from"]), float(saved["to"])

    def seg(data: dict, at: float):
        data = dict(data)
        for name in ("secondary", "tertiary"):
            if data.get(name) is not None:
                data[name] = tuple(data[name])
        data["start"] = round(at, 3)
        return framing.Segment(**data)

    def analyse(a: float, b: float) -> list:
        """Framing for [a, b) (source seconds) of a stretch outside the old cut."""
        if b - a < .05:
            return []
        part = src.with_name(f"{src.stem}.frame{int(a * 1000)}.mp4")
        try:
            media.cut_section(src, a - start, b - start, part)
            words_here = [Word(w.text, w.start - (a - start), w.end - (a - start)) for w in local
                          if w.end > a - start and w.start < b - start]
            sub = framing.plan_crop(part, key["frame"][0], key["frame"][1], words_here)
        finally:
            part.unlink(missing_ok=True)
        if sub is None:
            return []
        return [seg({**asdict(s), "secondary": s.secondary, "tertiary": s.tertiary}, s.start + a - start)
                for s in sub.segments]

    old = sorted(saved["segments"], key=lambda s: s["start"])
    lo, hi = max(start, old_from), min(end, old_to)
    reused = []
    if hi > lo:
        active = [s for s in old if s["start"] <= lo + 1e-3]
        if active:
            reused.append(seg(active[-1], lo - start))
        reused += [seg(s, s["start"] - start) for s in old if lo + 1e-3 < s["start"] < hi]
    head = analyse(start, min(old_from, end)) if start < old_from else []
    tail = analyse(max(old_to, start), end) if end > old_to else []
    segments = sorted(head + reused + tail, key=lambda s: s.start)
    if not segments:
        return None
    segments[0].start = 0.0
    return framing.Plan(segments)


def _edit_window(p: Project, n: int, start: float, end: float) -> tuple[Path, float] | None:
    """The full-quality stretch the editor downloaded, when it covers [start, end]."""
    path, meta = p.dir / f"edit_window_{n}.mp4", _preview_path(p, n).with_suffix(".json")
    if not (path.exists() and meta.exists()):
        return None
    data = json.loads(meta.read_text(encoding="utf-8"))
    if data["from"] - .01 <= start and end <= data["to"] + .01:
        return path, float(data["from"])
    return None


def _best_match(words: list[Word], fix: dict, offset: float = 0.0) -> int | None:
    """Index of the word a fix was made on: the most time overlap, same spelling preferred."""
    f0, f1 = float(fix["start"]), float(fix["end"])
    original = str(fix.get("orig", "")).strip().lower()
    best, best_score = None, 0.0
    for i, word in enumerate(words):
        w0, w1 = word.start + offset, word.end + offset
        overlap = min(w1, f1) - max(w0, f0)
        near = abs((w0 + w1) / 2 - (f0 + f1) / 2)
        if overlap <= 0 and near > .15:
            continue
        score = max(overlap, 0) + (1.0 if original and word.text.strip().lower() == original else 0) - near * .1
        if best is None or score > best_score:
            best, best_score = i, score
    return best


def _apply_line_fix(words: list[Word], fix: dict, offset: float) -> list[Word]:
    """Replace a whole sentence. New words share its time span by their length."""
    f0, f1 = float(fix["start"]), float(fix["end"])
    inside = [i for i, w in enumerate(words) if f0 - .05 <= (w.start + w.end) / 2 + offset <= f1 + .05]
    tokens = str(fix.get("text", "")).split()
    if not inside:
        return words
    first, last = inside[0], inside[-1]
    t0, t1 = words[first].start, words[last].end
    weights = [len(token) + 2 for token in tokens]
    total = sum(weights) or 1
    made, at = [], t0
    for token, weight in zip(tokens, weights):
        step = (t1 - t0) * weight / total
        made.append(Word(token, round(at, 3), round(at + step, 3)))
        at += step
    return words[:first] + made + words[last + 1:]


def apply_caption_fixes(words: list[Word], fixes: list[dict], offset: float = 0.0) -> list[Word]:
    """Replace (or, with empty text, drop) the words the user corrected.

    A fix with ``kind == "line"`` rewrites a whole sentence whose word count changed.
    """
    if not fixes:
        return words
    words = [Word(w.text, w.start, w.end) for w in words]
    for fix in fixes:
        if fix.get("kind") == "line":
            words = _apply_line_fix(words, fix, offset)
    drop: set[int] = set()
    for fix in fixes:
        if fix.get("kind") == "line":
            continue
        i = _best_match(words, fix, offset)
        if i is None:
            continue
        text = " ".join(str(fix.get("text", "")).split())
        if text:
            words[i].text = text
        else:
            drop.add(i)
    return [w for i, w in enumerate(words) if i not in drop]


def edit_info(p: Project, n: int) -> dict:
    """Everything the clip editor needs: range, limits and the words around the clip."""
    clip = next(c for c in p.clips if c["n"] == n)
    start, end = float(clip["start"]), float(clip["end"])
    limit = max(float(p.settings["clip"]["max_duration"]), end - start)
    total = float(p.duration or 0) or end + limit
    lo, hi = max(0.0, start - limit), min(total, end + limit)
    words = [w for w in captions.expand_coarse_words(_load_words(p)) if w.end > lo and w.start < hi]
    saved = _read_caption_file(p, n)
    if saved is not None:
        # Inside the clip, show the words its captions were really drawn from.
        words = [w for w in words if w.end <= saved["from"] or w.start >= saved["to"]] + [
            Word(w["text"], w["start"], w["end"]) for w in saved["words"]]
    words = apply_caption_fixes(sorted(words, key=lambda w: w.start), _pending_fixes(clip, saved))
    return {
        "n": n, "title": clip.get("title", ""), "start": start, "end": end,
        "min_duration": EDIT_MIN_DURATION, "max_duration": limit,
        "window": [round(lo, 3), round(hi, 3)], "duration": total,
        "intro": float(clip.get("intro_duration") or 0),
        "video": p.file_url(clip["video"]) if clip.get("video") else None,
        "caption": _caption_look(p),
        "words": [{"text": w.text, "start": round(w.start, 3), "end": round(w.end, 3)} for w in words],
    }


def _caption_look(p: Project) -> dict:
    """What the editor needs to draw a close live preview of the captions."""
    cfg = p.settings.get("caption") or {}
    style = CaptionStyle(**cfg)
    animation = captions.normalize_animation(style.animation)
    spec = captions.STYLES[animation]
    font = captions.normalize_font(style.font)
    return {
        "font": font,
        "accent_font": captions.strong_font_for(spec, font),
        "accent": captions.COLORS.get(style.color, captions.COLORS[captions.DEFAULT_COLOR]),
        "case": spec.case or style.case,
        "position": style.position,
        "display": style.display or "sentence",
        "animation": animation,
        "size": captions.CAPTION_FONTS[font].size,
        "max_lines": min(style.max_lines, captions.MAX_LINES),
    }


def _preview_path(p: Project, n: int) -> Path:
    return p.dir / f"edit_preview_{n}.mp4"


_preview_guard = threading.Lock()
_preview_locks: dict[tuple[str, int], threading.Lock] = {}


def edit_preview(p: Project, n: int) -> dict:
    """A light video of the whole editable window, so the editor can play any range live.

    Requests for the same clip queue up: the second one reuses the first one's file
    instead of writing the same temporary files at the same time.
    """
    with _preview_guard:
        lock = _preview_locks.setdefault((p.id, n), threading.Lock())
    with lock:
        return _edit_preview(p, n)


def _edit_preview(p: Project, n: int) -> dict:
    info = edit_info(p, n)
    lo, hi = info["window"]
    out = _preview_path(p, n)
    meta = out.with_suffix(".json")
    if out.exists() and meta.exists():
        saved = json.loads(meta.read_text(encoding="utf-8"))
        if abs(saved["from"] - lo) < .01 and abs(saved["to"] - hi) < .01:
            return {**saved, "url": f"/api/projects/{p.id}/clips/{n}/edit/preview.mp4"}
    part = p.dir / f"edit_preview_{n}.part.mp4"
    part.unlink(missing_ok=True)
    local = p.local_video
    downloaded = None
    if local and Path(local).exists():
        source, skip = Path(local), lo
    else:
        # Only the window is fetched, not the whole video.
        downloaded = media.download_section(p.url, lo, hi, p.dir / f"edit_window_{n}.mp4")
        source, skip = downloaded, 0.0
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{skip:.3f}", "-i", str(source), "-t", f"{hi - lo:.3f}",
             "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:540,fps=30", "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "28", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
             "-movflags", "+faststart", str(part)],
            check=True,
        )
    except Exception:
        if downloaded:
            downloaded.unlink(missing_ok=True)
        raise
    # A downloaded window stays (full quality): saving an edit cuts the clip from it
    # instead of downloading again.
    part.replace(out)
    data = {"from": lo, "to": hi, "offset": lo}
    meta.write_text(json.dumps(data), encoding="utf-8")
    return {**data, "url": f"/api/projects/{p.id}/clips/{n}/edit/preview.mp4"}


def edit_preview_file(p: Project, n: int) -> Path | None:
    out = _preview_path(p, n)
    return out if out.exists() else None


def edit(p: Project, n: int, start: float, end: float, fixes: list[dict]) -> None:
    """Save a new range and caption fixes, then render the clip again in place."""
    clip = next(c for c in p.clips if c["n"] == n)
    info = edit_info(p, n)
    start, end = round(float(start), 3), round(float(end), 3)
    if not (0 <= start < end <= info["duration"] + .01):
        raise ValueError("Rentang clip di luar video sumber")
    if end - start < EDIT_MIN_DURATION - .01:
        raise ValueError(f"Clip minimal {EDIT_MIN_DURATION:g} detik")
    if end - start > info["max_duration"] + .01:
        raise ValueError(f"Clip maksimal {info['max_duration']:g} detik sesuai pengaturan proyek")
    kept = [f for f in clip.get("caption_fixes") or []
            if not any(abs(float(f["start"]) - float(x["start"])) < .05 for x in fixes)]
    clean = [{"start": round(float(f["start"]), 3), "end": round(float(f["end"]), 3),
              "text": str(f.get("text", ""))[:600], "orig": str(f.get("orig", ""))[:600],
              **({"kind": "line"} if f.get("kind") == "line" else {})} for f in fixes]
    moved = abs(start - float(clip["start"])) > .001 or abs(end - float(clip["end"])) > .001
    with _lock:
        if _projects.get(p.id) is not p or p.status not in ("done", "error") or (_active and _active[0] == p.id):
            raise ValueError("Tunggu hingga proses project selesai")
        clip["caption_fixes"] = kept + clean
        clip["start"], clip["end"] = start, end
        clip["edited"] = True
        clip["fast_edit"] = True
        if moved:
            # The cut source covers the old range only; fetch it again.
            for stale in (p.dir / f"src_{n}.mp4", p.dir / f"src_{n}_active.mp4"):
                stale.unlink(missing_ok=True)
        _fix_transcript(p, clean)
        p.save()
    retry(p, n)


def _fix_transcript(p: Project, fixes: list[dict]) -> None:
    """Carry corrections into the project transcript, so Gen More reuses them.

    Only single-word entries are rewritten; a segment-timed line is left whole.
    """
    if not fixes:
        return
    words = _load_words(p)
    changed = False
    for fix in fixes:
        if fix.get("kind") == "line":
            continue  # a rewritten sentence has no reliable word timing to carry over
        i = _best_match(words, fix)
        if i is None or " " in words[i].text.strip():
            continue
        text = " ".join(str(fix.get("text", "")).split())
        if text and text != words[i].text:
            words[i].text, changed = text, True
    if changed:
        _save_words(p, words)


def retry(p: Project, n: int) -> None:
    with _lock:
        if _projects.get(p.id) is not p or p.status not in ("done", "error") or (_active and _active[0] == p.id):
            raise ValueError("this project can't retry clips right now")
        clip = next(c for c in p.clips if c["n"] == n)
        clip["status"] = "pending"
        clip.pop("error", None)
        p.notice = None
        p.status, p.stage, p.progress, p.error = "clipping", f"retry clip {n}", STAGES["clipping"][0], None
        p.save()
        _queue.put(("retry", p.id, n))


def _retry(p: Project, n: int) -> None:
    if p.settings.get("mode") == "filming":
        from . import film
        opts = _clip_options(p)
        cfg = p.settings["film"]
        for clip in p.clips:
            if clip["n"] != n and clip.get("status") == "done":
                continue
            clip["status"] = "rendering"
            clip.pop("error", None)
            p.stage = f"episode {clip['n']}/{len(p.clips)}"
            p.save()
            try:
                film.render(p, clip, opts, cfg)
            except Exception as e:
                clip["status"], clip["error"] = "error", str(e) or e.__class__.__name__
                p.save()
                raise
            clip["status"] = "done"
            p.progress = 0.45 + 0.55 * sum(c.get("status") == "done" for c in p.clips) / len(p.clips)
            p.save()
        p.status, p.stage, p.progress = "done", "done", 1.0
        _export_results(p)
        p.save()
        return
    clip = next(c for c in p.clips if c["n"] == n)
    lo, hi = STAGES["clipping"]
    _attempt_clip(p, clip, _load_words(p), _clip_options(p), lo, hi - lo)
    if any(c.get("status") == "done" for c in p.clips):
        p.status, p.stage, p.progress, p.error = "done", "done", 1.0, None
        _export_results(p)
    else:
        p.status, p.stage, p.error = "error", "failed", clip.get("error") or "Klip gagal diproses"
    p.save()


MORE_LIMIT = 10


def more(p: Project, count: int) -> None:
    """Queue `count` extra clips for a finished clipping project, reusing its transcript."""
    if not 1 <= count <= MORE_LIMIT:
        raise ValueError(f"Jumlah clip tambahan harus 1–{MORE_LIMIT}")
    with _lock:
        if (_projects.get(p.id) is not p or p.status not in ("done", "error")
                or (_active and _active[0] == p.id)):
            raise ValueError("Tunggu hingga proses project selesai")
        if p.settings.get("mode", "clipping") == "filming":
            raise ValueError("Gen more hanya tersedia untuk mode clipping")
        if not (p.dir / "words.json").exists():
            raise ValueError("Transkrip project ini tidak ditemukan")
        p.more_from, p.notice = len(p.clips), None
        p.status, p.stage, p.progress, p.error = "selecting", "picking more clips", STAGES["selecting"][0], None
        p.save()
        _queue.put(("more", p.id, count))


def _more(p: Project, count: int) -> None:
    """Pick new moments from the saved transcript and render only those clips."""
    words = _load_words(p)
    clip_cfg = p.settings["clip"]

    def uncertain_boundary():
        p.transcript_note = 'Batas clip diperkirakan karena timestamp subtitle tidak cukup rinci.'
        p.save()

    # Every clip already made from this video, this project's own included, may not be
    # repeated: not its stretch, nor its wording or title at another time.
    made = used_clips(p.source_key)
    picks: list[select.Pick] = []
    problem = None
    for _ in range(2):  # a second ask covers picks dropped as duplicates
        try:
            picks += select.pick_clips(
                words, count - len(picks), float(clip_cfg["max_duration"]), p.language,
                exclude=[(c.start, c.end) for c in made + picks], mood=p.settings.get("mood", "auto"),
                allow_approximate=getattr(p, 'transcript_timing', None) == 'segmen',
                on_approximate=uncertain_boundary, objective=p.settings.get('objective', ''),
                avoid=made + picks)
        except ValueError as e:
            problem = str(e)
            break
        if len(picks) >= count:
            break
    picks = picks[:count]
    if not picks:
        # Running out of fresh moments is not a failure of the clips already made.
        p.status, p.stage, p.progress, p.more_from = "done", "done", 1.0, None
        p.notice = ("Tidak ada momen baru lagi di video ini." if not problem or "no new moments" in problem
                    else f"Gen more gagal: {problem}")
        p.save()
        return
    first = max((int(c["n"]) for c in p.clips), default=0) + 1
    new = [{"n": first + i, "start": c.start, "end": c.end, "title": c.title, "reason": c.reason,
            "status": "pending"} for i, c in enumerate(picks)]
    p.clips.extend(new)
    _stage(p, "clipping", f"clip {new[0]['n']}/{len(p.clips)}")
    opts = _clip_options(p)
    lo, hi = STAGES["clipping"]
    share = (hi - lo) / len(new)
    for i, clip in enumerate(new):
        p.stage = f"clip {clip['n']}/{len(p.clips)}"
        _attempt_clip(p, clip, words, opts, lo + share * i, share)
    rendered = sum(c["status"] == "done" for c in new)
    p.status, p.stage, p.progress, p.error, p.more_from = "done", "done", 1.0, None, None
    if rendered < len(new):
        p.notice = f"{rendered} dari {len(new)} clip tambahan berhasil dibuat."
    elif len(new) < count:
        p.notice = f"Hanya {len(new)} momen baru yang tidak mengulang clip sebelumnya."
    _export_results(p)
    p.save()


def _fail(p: Project, error: str) -> None:
    p.status, p.stage, p.error, p.more_from = "error", "failed", error, None
    p.save()


def _start_project(pid: str, args: list) -> subprocess.Popen:
    # Frozen desktop executables dispatch the worker through their own entry point.
    command = ([sys.executable, "--project-worker"] if getattr(sys, "frozen", False)
               else [sys.executable, "-m", "clipy.project_worker"])
    return subprocess.Popen(
        [*command, str(DATA_DIR), pid, *map(str, args)],
        cwd=Path(__file__).resolve().parent.parent,
        # The desktop parent monitors stdin for launcher exit. Inheriting its
        # blocked pipe can hang Python startup on Windows before the job runs.
        stdin=subprocess.DEVNULL,
        start_new_session=os.name != "nt",
    )


def _worker() -> None:
    global _active
    while (task := _queue.get()) is not None:
        kind, pid, *args = task if isinstance(task, tuple) else ("run", task)
        if kind == "more":
            args = ["more", *args]
        with _lock:
            if _shutting_down:
                return
            p = _projects.get(pid)
            if not p or p.status in TERMINAL:
                continue
            try:
                proc = _start_project(pid, args)
            except OSError as e:
                traceback.print_exc()
                _fail(p, str(e))
                continue
            _active = (pid, proc)
        code = proc.wait()
        with _lock:
            _active = None
            p = _projects.get(pid)
            if p and p.status != "cancelled":
                p = _checkpoint(pid) or p
                if p.status in TERMINAL and migrate_clip_assets(p):
                    p.save()
                _projects[pid] = p
                if p.status not in TERMINAL:
                    _fail(p, f"Project worker exited before completing the project (status {code})")


def start_worker() -> None:
    global _scheduler, _shutting_down
    with _lock:
        _shutting_down = False
        _projects.clear()
        _load(interrupted=True)
        _scheduler = threading.Thread(target=_worker, daemon=True, name="clipy-worker")
        _scheduler.start()


def shutdown_worker() -> None:
    global _queue, _scheduler, _shutting_down
    with _lock:
        _shutting_down = True
        if _active:
            _terminate(_active[1])
        _queue.put(None)
    if _scheduler:
        _scheduler.join()
    _scheduler = None
    _queue = queue.Queue()

