import { Marquee } from "./marquee";
import { el, openEditor, openPreview, openYoutubeInBrowser, retryClip, type Project } from "./editor";
import { disposeProjectIslands, mountClipResults, mountProjectSettings } from "./project-components";
import { filmConcatControls } from "./film-concat";
import { previewSelect } from "./option-preview";

new Marquee(document.querySelector<HTMLCanvasElement>(".backdrop")!);

// ---------- theme (dark / light), remembered in this browser ----------

const themeButtons = document.querySelectorAll<HTMLButtonElement>(".theme-switch button");
function applyTheme(theme: "dark" | "light") {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  themeButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.choice === theme)));
  try {
    localStorage.setItem("clipy-theme", theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
  window.dispatchEvent(new Event("themechange"));
}
themeButtons.forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.choice === "light" ? "light" : "dark")));
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const stage = $<HTMLElement>(".stage");
const form = $<HTMLFormElement>("#form");
const input = $<HTMLInputElement>("#link");
const button = $<HTMLButtonElement>("#clip");
const hint = $<HTMLParagraphElement>("#hint");
const preview = $<HTMLDivElement>("#preview");
const thumb = $<HTMLImageElement>("#thumb");
const title = $<HTMLAnchorElement>("#title-source");
const sourceLinks = [$<HTMLAnchorElement>("#thumb-source"), title];

const HINT = "paste link here";

// Block buttons spell their label one letter per cell (a space is an empty cell).
document.querySelectorAll<HTMLButtonElement>(".blocks").forEach((b) => {
  b.replaceChildren(
    ...[...(b.getAttribute("aria-label") ?? "")].map((ch) =>
      Object.assign(document.createElement("span"), { textContent: ch, className: ch === " " ? "gap" : "" }),
    ),
  );
});

// ---------- link → preview ----------

/** Video id from any common YouTube URL shape: watch, youtu.be, shorts, embed, live. */
function youtubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1] ?? null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/**
 * The video being set up: a YouTube link, or a video on the server (just uploaded from this
 * computer, or picked from "local project"). `reuse` is set when clipping a video done
 * before: the new project reuses that project's transcript and must find new moments.
 */
type Source =
  | { kind: "youtube"; id: string; url: string; title: string; reuse?: string }
  | { kind: "file"; id: string; objectUrl: string; title: string; uploadId: string | null; reuse?: string };

let current: Source | null = null;
let request: AbortController | null = null;
let upload: XMLHttpRequest | null = null;

const player = $<HTMLDivElement>("#player");
const play = $<HTMLButtonElement>("#play");
const uploadInput = $<HTMLInputElement>("#upload-input");
const uploadPick = $<HTMLButtonElement>("#upload-pick");
const exportPick = $<HTMLButtonElement>("#export-pick");
// A local page can ask the server to select a file without copying it.
// Remote visitors instead select a file in their own browser and upload it.
const serverIsLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
let exportDir = "";
const subtitleUpload = $<HTMLElement>("#subtitle-upload");
const subtitleInput = $<HTMLInputElement>("#subtitle-input");
const subtitlePick = $<HTMLButtonElement>("#subtitle-pick");
const subtitleName = $<HTMLElement>("#subtitle-name");
const subtitleRemove = $<HTMLButtonElement>("#subtitle-remove");

async function chooseExportDirectory() {
  exportPick.disabled = true;
  exportPick.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/export-directory/choose", { method: "POST" });
    if (res.status === 204) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.path !== "string") throw new Error(typeof data.detail === "string" ? data.detail : "Folder tidak dapat dipilih");
    exportDir = data.path;
  } catch {
    // Keep the compact action row unchanged; the selection can be retried.
  } finally {
    exportPick.removeAttribute("aria-busy");
    exportPick.disabled = !serverIsLocal;
  }
}

exportPick.addEventListener("click", () => void chooseExportDirectory());
if (!serverIsLocal) {
  exportPick.disabled = true;
}

function clearSubtitle() {
  subtitleInput.value = "";
  subtitleName.textContent = "opsional · lewati transkripsi otomatis";
  subtitleRemove.hidden = true;
}
subtitlePick.addEventListener("click", () => subtitleInput.click());
subtitleInput.addEventListener("change", () => {
  const file = subtitleInput.files?.[0];
  subtitleName.textContent = file ? file.name : "opsional · lewati transkripsi otomatis";
  subtitleRemove.hidden = !file;
});
subtitleRemove.addEventListener("click", clearSubtitle);

function setHint(target: HTMLElement, text: string, error = false) {
  target.textContent = text;
  target.classList.toggle("error", error);
}

/** Whether CLIPY can go: a titled YouTube video, or a file that finished uploading. */
const ready = () => !!current?.title && (current.kind === "youtube" || !!current.uploadId);

function stopPlayer() {
  player.replaceChildren();
  player.hidden = true;
  play.hidden = false;
}

function clear() {
  request?.abort();
  upload?.abort();
  upload = null;
  if (current?.kind === "file" && current.objectUrl.startsWith("blob:")) URL.revokeObjectURL(current.objectUrl);
  current = null;
  for (const link of sourceLinks) link.removeAttribute("href");
  title.parentElement!.classList.remove("loading");
  startButton.setAttribute("aria-disabled", "true");
  if (showMissingFields) setHint(startHint, "");
  showMissingFields = false;
  highlightMissingFields([]);
  clearSubtitle();
  subtitleUpload.hidden = true;
  button.disabled = true;
  stopPlayer();
  preview.classList.remove("show");
}

for (const link of sourceLinks) {
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", (event) => {
    if (current?.kind === "youtube") openYoutubeInBrowser(link, current.url, event);
  });
}

function showPlatform(kind: Source["kind"]) {
  const url = current?.kind === "youtube" ? current.url : "";
  for (const link of sourceLinks) {
    if (url) link.href = url;
    else link.removeAttribute("href");
  }
  $<HTMLElement>("#platform-youtube").hidden = kind !== "youtube";
  $<HTMLElement>("#platform-file").hidden = kind !== "file";
}

// YouTube opens externally. Local video still plays in the preview.
play.addEventListener("click", () => {
  if (!current) return;
  if (current.kind === "youtube") {
    $<HTMLAnchorElement>("#thumb-source").click();
    return;
  }
  const media = el("video", { src: current.objectUrl, controls: true, autoplay: true, playsInline: true });
  player.replaceChildren(media);
  player.hidden = false;
  play.hidden = true;
});

async function show(id: string) {
  if (current?.kind === "youtube" && current.id === id) return;
  clear();
  request = new AbortController();
  const url = `https://www.youtube.com/watch?v=${id}`;
  current = { kind: "youtube", id, url, title: "" };
  subtitleUpload.hidden = mode !== "filming";
  setHint(hint, HINT);
  showPlatform("youtube");

  // The thumbnail comes straight from the id, so it can show before the title lands.
  thumb.classList.remove("loaded");
  thumb.dataset.fallback = "";
  thumb.src = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  title.textContent = "";
  title.parentElement!.classList.add("loading");
  preview.classList.add("show");

  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: request.signal,
    });
    if (!res.ok) throw new Error(String(res.status));
    const data: { title: string } = await res.json();
    if (current?.id !== id) return;
    current.title = data.title;
    title.textContent = data.title;
    title.parentElement!.classList.remove("loading");
    button.disabled = !ready();
    progress();
  } catch (err) {
    if ((err as Error).name === "AbortError" || current?.kind !== "youtube" || current.id !== id) return;
    clear();
    setHint(hint, "video not found or private", true);
  }
}

// Videos without an HD frame get a 120×90 placeholder (sometimes with a 404); drop to hqdefault.
function fallbackThumb() {
  if (current?.kind !== "youtube" || thumb.dataset.fallback) return;
  thumb.dataset.fallback = "1";
  thumb.src = `https://i.ytimg.com/vi/${current.id}/hqdefault.jpg`;
}
thumb.addEventListener("load", () => {
  if (current?.kind === "youtube" && thumb.naturalWidth <= 120) fallbackThumb();
  else thumb.classList.add("loaded");
});
thumb.addEventListener("error", fallbackThumb);

// ---------- video from this computer ----------

/** A still from about a tenth of the way in, drawn from the file itself. */
function frameOf(objectUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = el("video", { src: objectUrl, muted: true, preload: "auto", playsInline: true });
    v.addEventListener("loadedmetadata", () => (v.currentTime = Math.min(2, (v.duration || 10) / 10)));
    v.addEventListener("seeked", () => {
      const c = el("canvas", { width: v.videoWidth, height: v.videoHeight });
      c.getContext("2d")!.drawImage(v, 0, 0);
      resolve(c.toDataURL("image/jpeg", 0.85));
    });
    v.addEventListener("error", () => reject(new Error("this browser can't read that video")));
  });
}

function asciiBar(p: number, width = 14) {
  const filled = Math.round(p * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${String(Math.round(p * 100)).padStart(3)}%`;
}

async function showFile(file: File) {
  clear();
  const objectUrl = URL.createObjectURL(file);
  const source: Source = { kind: "file", id: `${file.name}:${file.size}`, objectUrl, title: file.name.replace(/\.[^.]+$/, ""), uploadId: null };
  current = source;
  subtitleUpload.hidden = mode !== "filming";
  // Browsers never reveal a file's folder, so the field shows its name.
  input.value = file.name;
  showPlatform("file");
  thumb.classList.remove("loaded");
  title.textContent = source.title;
  title.parentElement!.classList.remove("loading");
  preview.classList.add("show");
  frameOf(objectUrl).then((src) => current === source && (thumb.src = src)).catch(() => {});

  // Upload straight away so START doesn't have to wait for it.
  const body = new FormData();
  body.append("file", file);
  const xhr = new XMLHttpRequest();
  upload = xhr;
  xhr.open("POST", "/api/uploads");
  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable) setHint(hint, `uploading ${asciiBar(e.loaded / e.total)}`);
  });
  xhr.addEventListener("load", () => {
    if (current !== source) return;
    let data: {id?: string; duration?: number; detail?: string};
    try { data = JSON.parse(xhr.responseText || "{}"); }
    catch { setHint(hint, "upload failed: respons server tidak valid", true); return; }
    if (xhr.status !== 200 || typeof data.id !== "string" || !Number.isFinite(data.duration)) {
      setHint(hint, `upload failed: ${data.detail ?? xhr.status}`, true);
      return;
    }
    source.uploadId = data.id;
    const secs = Math.round(data.duration!);
    setHint(hint, `uploaded · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
    button.disabled = !ready();
    progress();
  });
  xhr.addEventListener("error", () => current === source && setHint(hint, "upload failed: can't reach the clipping server", true));
  xhr.send(body);
}

uploadPick.addEventListener("click", () => {
  if (serverIsLocal) void pickServerFile();
  else uploadInput.click();
});
uploadInput.addEventListener("change", () => {
  const file = uploadInput.files?.[0];
  uploadInput.value = "";
  if (file) showFile(file);
});

async function pickServerFile() {
  uploadPick.disabled = true;
  try {
    setHint(hint, "pilih video pada jendela yang terbuka di komputer server");
    const response = await fetch("/api/local-files/pick", { method: "POST" });
    if (response.status === 204) { setHint(hint, HINT); return; }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `status ${response.status}`);
    if (typeof data.id !== "string" || typeof data.name !== "string") throw new Error("respons file tidak valid");
    clear();
    const source: Source = { kind: "file", id: `server:${data.id}`, objectUrl: `/api/uploads/${encodeURIComponent(data.id)}/video`, title: data.name.replace(/\.[^.]+$/, ""), uploadId: data.id };
    current = source;
    input.value = data.name;
    subtitleUpload.hidden = mode !== "filming";
    showPlatform("file");
    thumb.classList.remove("loaded");
    thumb.src = `/api/uploads/${encodeURIComponent(data.id)}/poster`;
    title.textContent = source.title;
    title.parentElement!.classList.remove("loading");
    preview.classList.add("show");
    setHint(hint, "file server siap · tanpa upload");
    button.disabled = !ready();
    progress();
  } catch (err) {
    setHint(hint, `tidak dapat memilih file server: ${(err as Error).message}`, true);
  } finally {
    uploadPick.disabled = false;
  }
}

// ---------- local project: videos clipped (or uploaded) before ----------

type LocalSource = {
  key: string;
  project: string | null;
  kind: "youtube" | "upload";
  title: string;
  url: string;
  video_id: string;
  upload_id: string | null;
  duration: number;
  thumbnail: string;
  projects: number;
  clips_used: number;
};

const library = $<HTMLDivElement>("#library");
const libraryList = $<HTMLOListElement>("#library-list");
const libraryHint = $<HTMLParagraphElement>("#library-hint");
let libraryVersion = 0;

const clockOf = (s: number) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

function closeLibrary() {
  libraryVersion++;
  library.hidden = true;
  if ($<HTMLElement>("#editor").hidden && $<HTMLElement>("#preview-modal").hidden) document.body.classList.remove("locked");
}

/** Set a video from the list up as the source, marked to be clipped again with new moments. */
function useSource(s: LocalSource) {
  closeLibrary();
  if (s.kind === "youtube") {
    clear();
    input.value = s.url;
    // The library already has the source metadata; no oEmbed request is needed.
    current = { kind: "youtube", id: s.video_id, url: s.url, title: s.title };
    showPlatform("youtube");
    thumb.classList.remove("loaded");
    thumb.dataset.fallback = "";
    thumb.src = s.thumbnail;
    title.textContent = s.title;
    title.parentElement!.classList.remove("loading");
    preview.classList.add("show");
    button.disabled = !ready();
  } else {
    clear();
    current = { kind: "file", id: s.key, objectUrl: `/api/uploads/${s.upload_id}/video`, title: s.title, uploadId: s.upload_id };
    input.value = s.title;
    showPlatform("file");
    thumb.classList.remove("loaded");
    thumb.src = s.thumbnail;
    title.textContent = s.title;
    title.parentElement!.classList.remove("loading");
    preview.classList.add("show");
    button.disabled = !ready();
  }
  if (current && s.project) current.reuse = s.project;
  subtitleUpload.hidden = mode !== "filming";
  setHint(
    hint,
    mode === "filming" ? "sumber video siap digunakan untuk filming" : s.project
      ? `clipping again · new moments only (${s.clips_used} clip${s.clips_used === 1 ? "" : "s"} used before)`
      : "local video · not clipped yet",
  );
  progress();
}

async function openLibrary() {
  const version = ++libraryVersion;
  setHint(libraryHint, mode === "filming" ? "pilih video sebagai sumber filming" : "videos clipped before · pick one to clip it again with new moments");
  library.hidden = false;
  document.body.classList.add("locked");
  libraryList.replaceChildren(el("li", { className: "library-empty", textContent: "loading…" }));
  try {
    const res = await fetch("/api/sources");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list: LocalSource[] = await res.json();
    if (version !== libraryVersion || library.hidden) return;
    if (!list.length) {
      libraryList.replaceChildren(el("li", { className: "library-empty", textContent: "nothing here yet · clip a video first" }));
      return;
    }
    const mostRecentSettings = list.find((s) => s.project)?.project ?? null;
    libraryList.replaceChildren(
      ...list.map((s) => {
        const item = el(
          "button",
          { type: "button", className: "library-item", title: s.title },
          el("span", { className: "cover" }, el("img", { src: s.thumbnail, alt: "", loading: "lazy" }), el("span", { className: "badge", textContent: s.kind === "youtube" ? "youtube" : "local" })),
          el("span", { className: "name", textContent: s.title }),
          el("span", {
            className: "meta",
            textContent: `${clockOf(s.duration)} · ${s.project ? `${s.clips_used} clip${s.clips_used === 1 ? "" : "s"} used` : "not clipped yet"}`,
          }),
        );
        item.addEventListener("click", () => useSource(s));
        const reuse = el("button", {
          type: "button", className: "library-last", textContent: "CLIPY WITH LAST SETTING",
          disabled: !(s.project || mostRecentSettings),
          title: s.project ? `Use last settings for ${s.title}` : mostRecentSettings ? "Use your most recent settings" : "No saved settings yet",
        });
        reuse.addEventListener("click", () => useLastSettings(s, reuse, s.project ?? mostRecentSettings));
        return el("li", {}, item, reuse);
      }),
    );
  } catch (err) {
    if (version === libraryVersion && !library.hidden) libraryList.replaceChildren(el("li", { className: "library-empty", textContent: `can't load the list (${(err as Error).message})` }));
  }
}

async function useLastSettings(source: LocalSource, action: HTMLButtonElement, settingsProject: string | null) {
  if (!settingsProject) return;
  const version = ++libraryVersion;
  action.disabled = true;
  action.textContent = "LOADING SETTINGS…";
  libraryHint.classList.remove("error");
  try {
    const [projectResponse, keyResponse] = await Promise.all([
      fetch(`/api/projects/${settingsProject}`), fetch("/api/key"),
      loadOptions(),
    ]);
    if (!projectResponse.ok || !keyResponse.ok) throw new Error("Can't load the saved settings. Try again.");
    const project: Project = await projectResponse.json();
    const savedMode = project.settings.mode === "filming" && project.settings.film ? "filming" : "clipping";
    const key: KeyState = await keyResponse.json();
    async function savedFile(kind: "logo" | "image" | "music") {
      const response = await fetch(`/api/projects/${settingsProject}/assets/${kind}`);
      if (!response.ok) throw new Error(`The saved ${kind} is unavailable. Open the video and choose it again.`);
      const blob = await response.blob();
      const extension = kind === "music" ? (project.music?.split(".").pop() ?? "mp3") : blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      return new File([blob], `last-${kind}.${extension}`, { type: blob.type });
    }
    const [image, logo, music] = await Promise.all([
      project.settings.thumb.source === "upload" ? savedFile("image") : null,
      project.has_logo ? savedFile("logo") : null,
      project.music ? savedFile("music") : null,
    ]);
    if (version !== libraryVersion || library.hidden) return;
    if (mode !== savedMode) document.querySelector<HTMLButtonElement>(`.mode-select button[data-mode="${savedMode}"]`)?.click();
    resetAll(false);
    useSource(source);
    const s = project.settings;
    const savedSpeed = (s.clip.dubbing_speed ?? 1).toFixed(1);
    if (savedMode === "filming") filmDubSpeed.value = savedSpeed;
    if (s.mode === "filming" && s.film) {
      restoreClipLayout(filmRatio, filmBackground, s.clip.ratio, s.film.source_ratio, s.film.background, s.clip.background_inset);
      filmEpisodes.value = String(s.film.episodes);
      filmDuration.value = String(s.film.max_duration);
      if (filmDuration.selectedIndex === -1) filmDuration.selectedIndex = 0;
      filmVoice.value = s.film.voice;
      filmStyle.value = s.film.style;
      filmPrompt.value = s.film.additional_prompt ?? "";
    }
    clipObjective.value = s.objective ?? "";
    restoreClipLayout(sel.ratio, clipBackground, s.clip.ratio, s.clip.clip_ratio, s.clip.background, s.clip.background_inset);
    sel.count.value = String(s.clip.count);
    sel.duration.value = String(s.clip.max_duration);
    captionPosition.value = String(s.caption.position ?? 6);
    captionMode.value = s.caption.display ?? (s.caption.animation === "word" ? "word" : "sentence");
    restoreCaptionStyle(s.caption.animation, s.caption.font);
    setThumbPosition(s.thumb.position ?? "bc");
    sel.case.value = options?.cases[s.caption.case] ? s.caption.case : DEFAULT_CAPTION_CASE;
    color = options?.colors[s.caption.color] ? s.caption.color : DEFAULT_CAPTION_COLOR;
    swatches.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === color)));
    sel.source.value = s.thumb.source;
    sel.titleStyle.value = s.thumb.title_style;
    thumbText.value = s.thumb.text ?? "";
    thumbTextMode.value = s.thumb.text_mode ?? (thumbText.value ? "manual" : s.thumb.title_style === "none" ? "none" : "auto");
    thumbNumber.value = s.thumb.sequence ?? (s.thumb.numbered ? "number" : "off");
    sel.voice.value = s.thumb.voice ?? "none";
    function restoreFile(input: HTMLInputElement, file: File | null) {
      if (file) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
      }
      input.dispatchEvent(new Event("change"));
    }
    restoreFile(imageInput, image);
    restoreFile(logoInput, logo);
    restoreFile(musicInput, music);
    musicStartWanted = Math.max(0, s.music_start ?? 0);
    updateMusicRange();
    imagePick.hidden = sel.source.value !== "upload";
    brandText.value = s.brand?.text ?? "";
    brandStyle.value = s.brand?.style ?? BRAND_DEFAULTS.style;
    brandOpacity.value = String(s.brand?.opacity ?? 100);
    setPosition(s.brand?.position ?? "bc");
    openFlow(key, false);
    reveal(savedMode === "filming" ? steps.film : steps.clip);
    progress();
    setHint(startHint, "Last settings loaded · review or change them, then press START");
  } catch (error) {
    if (version === libraryVersion && !library.hidden) setHint(libraryHint, (error as Error).message, true);
  } finally {
    action.disabled = false;
    action.textContent = "CLIPY WITH LAST SETTING";
  }
}

$<HTMLButtonElement>("#library-open").addEventListener("click", openLibrary);
$<HTMLButtonElement>("#library-close").addEventListener("click", closeLibrary);
library.addEventListener("click", (e) => {
  if (e.target === library) closeLibrary();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !library.hidden) closeLibrary();
});

input.addEventListener("input", () => {
  // Typing over a chosen file's name (or a video picked from the list) goes back to link mode.
  if (current?.kind === "file" || current?.reuse) clear();
  const raw = input.value.trim();
  if (!raw) {
    clear();
    setHint(hint, HINT);
    return;
  }
  const id = youtubeId(raw);
  if (id) show(id);
  else {
    clear();
    setHint(hint, "that doesn't look like a youtube link", true);
  }
});

// ---------- steps ----------

type Options = {
  ratios: string[];
  fits: Record<string, string>;
  counts: number[];
  durations: number[];
  animations: Record<string, string>;
  animation_aliases?: Record<string, string>;
  fonts?: Record<string, string>;
  font_aliases?: Record<string, string>;
  font_sizes?: Record<string, number>;
  colors: Record<string, string>;
  cases: Record<string, string>;
  title_styles: Record<string, string>;
  voices: Record<string, string>;
  logo_positions: string[];
  brand_styles: Record<string, string>;
  brand_opacities: number[];
};

type KeyState = { set: boolean; label?: string; masked?: string };

const steps = {
  film: $<HTMLDivElement>("#step-film"),
  objective: $<HTMLDivElement>("#step-objective"),
  key: $<HTMLDivElement>("#step-key"),
  clip: $<HTMLDivElement>("#step-clip"),
  caption: $<HTMLDivElement>("#step-caption"),
  thumb: $<HTMLDivElement>("#step-thumb"),
  start: $<HTMLDivElement>("#step-start"),
};

const sel = {
  ratio: $<HTMLSelectElement>("#opt-ratio"),
  count: $<HTMLSelectElement>("#opt-count"),
  duration: $<HTMLSelectElement>("#opt-duration"),
  case: $<HTMLSelectElement>("#opt-case"),
  source: $<HTMLSelectElement>("#opt-source"),
  titleStyle: $<HTMLSelectElement>("#opt-title-style"),
  voice: $<HTMLSelectElement>("#opt-voice"),
};
const swatches = $<HTMLDivElement>("#opt-color");
const imageInput = $<HTMLInputElement>("#opt-image");
const imagePick = $<HTMLButtonElement>("#opt-image-pick");
const musicInput = $<HTMLInputElement>("#opt-music");
const musicUrl = $<HTMLInputElement>("#opt-music-url");
const musicPreview = $<HTMLElement>("#music-preview");
const musicAudio = $<HTMLAudioElement>("#music-audio");
const musicPlay = $<HTMLButtonElement>("#music-play");
const musicWave = $<HTMLCanvasElement>("#music-wave");
const musicRange = $<HTMLInputElement>("#music-start");
const musicSelection = $<HTMLElement>("#music-selection");
const musicTimes = $<HTMLElement>("#music-times");
const musicError = $<HTMLElement>("#music-error");
const musicPick = $<HTMLButtonElement>("#opt-music-pick");
const musicName = $<HTMLElement>("#opt-music-name");
const musicRemove = $<HTMLButtonElement>("#opt-music-remove");
let musicObjectUrl = "", musicSource = "";
let musicVersion = 0, musicDuration = 0, musicStartWanted = 0;
let musicReady: Promise<void> | null = null;
function musicWindowLength() {
  const chosen = Number(mode === "filming" ? filmDuration.value : sel.duration.value);
  return Number.isFinite(chosen) && chosen > 0 ? chosen : 0;
}
function musicClock(seconds: number) {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function updateMusicRange() {
  const length = musicWindowLength();
  if (!musicDuration || !length) {
    musicRange.disabled = true; musicSelection.hidden = true;
    musicTimes.textContent = musicDuration ? "pilih duration" : "";
    return;
  }
  const windowLength = Math.min(length, musicDuration);
  const maxStart = Math.max(0, musicDuration - windowLength);
  musicStartWanted = Math.min(maxStart, Math.max(0, musicStartWanted));
  musicRange.max = String(maxStart); musicRange.value = String(musicStartWanted);
  musicRange.disabled = maxStart === 0;
  musicSelection.hidden = false;
  musicSelection.style.left = `${musicStartWanted / musicDuration * 100}%`;
  musicSelection.style.width = `${windowLength / musicDuration * 100}%`;
  musicTimes.textContent = `${musicClock(musicStartWanted)} – ${musicClock(musicStartWanted + windowLength)}`;
}
function updateMusicPreview() {
  musicVersion++; musicDuration = 0; musicStartWanted = 0; musicReady = null;
  musicAudio.pause(); musicAudio.removeAttribute("src"); musicAudio.load();
  if (musicObjectUrl) URL.revokeObjectURL(musicObjectUrl);
  musicObjectUrl = musicInput.files?.[0] ? URL.createObjectURL(musicInput.files[0]) : "";
  musicSource = musicObjectUrl || musicUrl.value.trim();
  musicPreview.hidden = !musicSource;
  musicPlay.textContent = "▶"; musicPlay.setAttribute("aria-label", "Putar musik");
  musicWave.getContext("2d")?.clearRect(0, 0, musicWave.width, musicWave.height);
  musicError.textContent = ""; updateMusicRange();
}
async function prepareMusic() {
  if (!musicSource) return;
  if (musicReady) return musicReady;
  const version = musicVersion;
  const task = (async () => {
    try {
      if (!musicObjectUrl && musicUrl.value.trim()) {
        musicError.textContent = "menyiapkan musik…";
        const form = new FormData(); form.append("url", musicUrl.value.trim());
        const response = await fetch("/api/music/preview", { method: "POST", body: form });
        if (!response.ok) {
          const problem = await response.json().catch(() => ({}));
          throw new Error(typeof problem.detail === "string" ? problem.detail : "Musik tidak dapat disiapkan.");
        }
        const blob = await response.blob();
        if (version !== musicVersion) return;
        musicObjectUrl = URL.createObjectURL(blob); musicSource = musicObjectUrl;
      }
      const response = await fetch(musicSource);
      if (!response.ok) throw new Error("Musik tidak dapat dibaca.");
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 100 * 1024 * 1024) throw new Error("Ukuran musik maksimal 100 MB.");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Ukuran musik maksimal 100 MB.");
      const audioContext = new AudioContext();
      let buffer: AudioBuffer;
      try { buffer = await audioContext.decodeAudioData(bytes); } finally { await audioContext.close(); }
      if (version !== musicVersion) return;
      musicDuration = buffer.duration; musicAudio.src = musicSource;
      const samples = buffer.getChannelData(0), ctx = musicWave.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, musicWave.width, musicWave.height);
        ctx.fillStyle = getComputedStyle(musicWave).color;
        const bars = 100, step = Math.max(1, Math.floor(samples.length / bars));
        for (let i = 0; i < bars; i++) {
          let peak = 0;
          for (let j = i * step; j < Math.min(samples.length, (i + 1) * step); j += Math.max(1, Math.floor(step / 128))) peak = Math.max(peak, Math.abs(samples[j]));
          const height = Math.max(2, peak * musicWave.height);
          ctx.fillRect(i * musicWave.width / bars, (musicWave.height - height) / 2, 3, height);
        }
      }
      musicError.textContent = ""; updateMusicRange();
    } catch (error) {
      if (version === musicVersion) { musicError.textContent = (error as Error).message || "Musik tidak dapat disiapkan."; musicReady = null; }
    }
  })();
  musicReady = task;
  return task;
}
musicUrl.addEventListener("input", () => { if (musicUrl.value.trim()) { musicInput.value = ""; musicName.textContent = ""; musicRemove.hidden = true; } updateMusicPreview(); progress(); });
musicUrl.addEventListener("change", () => { if (musicUrl.validity.valid) void prepareMusic(); });
musicRange.addEventListener("input", () => { musicStartWanted = Number(musicRange.value); updateMusicRange(); if (musicAudio.readyState > 0) musicAudio.currentTime = musicStartWanted; });
musicAudio.addEventListener("timeupdate", () => {
  const length = musicWindowLength();
  if (length && musicAudio.currentTime >= Math.min(musicDuration, musicStartWanted + length)) {
    musicAudio.pause(); musicAudio.currentTime = musicStartWanted;
    musicPlay.textContent = "▶"; musicPlay.setAttribute("aria-label", "Putar musik");
  }
});
musicAudio.addEventListener("ended", () => { musicPlay.textContent = "▶"; musicPlay.setAttribute("aria-label", "Putar musik"); });
musicPlay.addEventListener("click", async () => {
  if (!musicAudio.paused) { musicAudio.pause(); musicPlay.textContent = "▶"; musicPlay.setAttribute("aria-label", "Putar musik"); return; }
  const version = musicVersion;
  musicPlay.disabled = true;
  try {
    await prepareMusic();
    if (version !== musicVersion || !musicDuration) return;
    if (musicAudio.currentTime < musicStartWanted || musicAudio.currentTime >= musicStartWanted + (musicWindowLength() || musicDuration)) musicAudio.currentTime = musicStartWanted;
    await musicAudio.play();
    musicPlay.textContent = "❚❚"; musicPlay.setAttribute("aria-label", "Jeda musik");
  } catch { musicError.textContent = "Musik tidak dapat diputar."; }
  finally { musicPlay.disabled = false; }
});
musicPick.addEventListener("click", () => musicInput.click());
musicInput.addEventListener("change", () => {
  musicName.textContent = musicInput.files?.[0]?.name ?? "";
  if (musicInput.files?.length) musicUrl.value = "";
  musicRemove.hidden = !musicInput.files?.length;
  updateMusicPreview();
  if (musicInput.files?.length) void prepareMusic();
});
musicRemove.addEventListener("click", () => { musicInput.value = ""; musicInput.dispatchEvent(new Event("change")); });
const logoInput = $<HTMLInputElement>("#opt-logo");
const logoPick = $<HTMLButtonElement>("#opt-logo-pick");
const logoPreview = $<HTMLImageElement>("#opt-logo-preview");
const captionPosition = $<HTMLSelectElement>("#opt-caption-position");
const captionPreset = $<HTMLSelectElement>("#caption-preset");
const captionFont = $<HTMLSelectElement>("#caption-font");
const settingsSummary = $<HTMLElement>("#settings-summary");
const captionStylePreview = $<HTMLElement>("#caption-style-preview");
const captionStyleReplay = $<HTMLButtonElement>("#caption-style-replay");
const captionStyleStatus = $<HTMLElement>("#caption-style-status");
const captionStyleName = $<HTMLElement>("#caption-style-name");
const captionStyleMeta = $<HTMLElement>("#caption-style-meta");
/** Short terminal-style tags for the preview frame's footer. */
const CAPTION_CASE_TAGS: Record<string, string> = { upper: "ABC", lower: "abc", title: "Abc Def", sentence: "Abc" };
const reducedCaptionMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const syncPreviews = [previewSelect(sel.titleStyle, "title-style")];
/** Sentence captions never run past two lines: easy for viewers to follow. */
const CAPTION_MAX_LINES = 2;
const captionMode = $<HTMLSelectElement>("#opt-caption-mode");
const thumbFrame = $<HTMLDivElement>("#opt-thumb-position");
// Match the music columns to the thumbnail grid as its position frame changes size.
const thumbPositionColumn = thumbFrame.parentElement!;
new ResizeObserver(() => {
  const width = thumbPositionColumn.getBoundingClientRect().width;
  if (width > 0) document.documentElement.style.setProperty("--thumb-position-width", `${width}px`);
}).observe(thumbPositionColumn);
let thumbPosition = "bc";
const thumbNumber = $<HTMLSelectElement>("#opt-thumb-number");
const thumbText = $<HTMLInputElement>("#opt-thumb-text");
const thumbTextMode = $<HTMLSelectElement>("#opt-thumb-text-mode");
const logoName = $<HTMLSpanElement>("#opt-logo-name");
const positionFrame = $<HTMLDivElement>("#opt-position");
const brandText = $<HTMLInputElement>("#opt-brand-text");
const brandStyle = $<HTMLSelectElement>("#opt-brand-style");
syncPreviews.push(previewSelect(brandStyle, "brand-style"));
const brandOpacity = $<HTMLSelectElement>("#opt-brand-opacity");
const BRAND_DEFAULTS = { style: "plain", opacity: "60" };
const keyForm = $<HTMLFormElement>("#key-form");
const keyInput = $<HTMLInputElement>("#key");
const keyInsert = $<HTMLButtonElement>("#key-insert");
const keyHint = $<HTMLParagraphElement>("#key-hint");
const keyBadge = $<HTMLButtonElement>("#key-badge");
const startButton = $<HTMLButtonElement>("#start");
const newClipButton = $<HTMLButtonElement>("#new-clip");
const startHint = $<HTMLParagraphElement>("#start-hint");

let options: Options | null = null;
let optionsLoading: Promise<void> | null = null;
const DEFAULT_CAPTION_STYLE = "clean";
const DEFAULT_CAPTION_FONT = "jakarta";
const DEFAULT_CAPTION_PRESET = "clean-bold";
const DEFAULT_CAPTION_COLOR = "yellow";
type CaptionPreset = {
  label: string; animation: string; font: string; color: string; display: string; letterCase: string;
  title: string; description: string;
};
/**
 * Caption presets own the animation style; each also picks a fitting caption
 * font, colour and letter case, which can still be changed afterwards.
 */
const CAPTION_PRESETS: Record<string, CaptionPreset> = {
  "viral-pop": { label: "Viral Pop", animation: "pop", font: "montserrat", color: "yellow", display: "sentence", letterCase: "upper", title: "pop", description: "Kata muncul satu per satu; kata kunci mendarat paling besar." },
  "clean-bold": { label: "Clean Bold", animation: "clean", font: "jakarta", color: "yellow", display: "sentence", letterCase: "sentence", title: "bold", description: "Bersih dan tegas; kata yang ditekankan membesar dan berwarna." },
  karaoke: { label: "Karaoke", animation: "karaoke", font: "tiktok", color: "cyan", display: "sentence", letterCase: "sentence", title: "underline", description: "Warna mengikuti kata yang diucapkan; kata kunci lebih besar." },
  "sticker-marker": { label: "Sticker Marker", animation: "marker", font: "poppins", color: "yellow", display: "sentence", letterCase: "upper", title: "box", description: "Kata yang ditekankan diberi kotak stiker miring." },
  "headline-jumbo": { label: "Headline Jumbo", animation: "headline", font: "anton", color: "yellow", display: "sentence", letterCase: "upper", title: "bold", description: "Kata kunci naik ke baris sendiri, besar seperti judul." },
  "aesthetic-soft": { label: "Aesthetic Soft", animation: "aesthetic", font: "dm-serif", color: "cream", display: "sentence", letterCase: "lower", title: "none", description: "Huruf kecil yang lembut untuk vlog dan lifestyle." },
  "podcast-clean": { label: "Podcast Clean", animation: "clean", font: "jakarta", color: "cream", display: "sentence", letterCase: "sentence", title: "shadow", description: "Tenang untuk obrolan panjang; kata kunci membesar dengan aksen krem." },
  edukasi: { label: "Edukasi", animation: "clean", font: "poppins", color: "green", display: "sentence", letterCase: "sentence", title: "bold", description: "Kata penting dalam penjelasan tampil lebih besar dan hijau." },
  "hype-gaming": { label: "Hype Gaming", animation: "pop", font: "bangers", color: "pink", display: "word", letterCase: "upper", title: "pop", description: "Satu kata per layar, meledak seperti komik." },
  "story-drama": { label: "Story Drama", animation: "marker", font: "bebas", color: "red", display: "sentence", letterCase: "upper", title: "stamp", description: "Kapital sinematik dengan kotak merah untuk momen dramatis." },
  "neon-glow": { label: "Neon Glow", animation: "glow", font: "montserrat", color: "cyan", display: "sentence", letterCase: "upper", title: "bold", description: "Kata bercahaya neon; garis gelap tipis menjaga teks tetap terbaca." },
  "fly-in": { label: "Fly In", animation: "rise", font: "jakarta", color: "yellow", display: "sentence", letterCase: "sentence", title: "bold", description: "Tiap kata melayang naik dari bawah dengan gerak melambat yang halus, lalu mendarat tepat saat diucapkan." },
  "serif-accent": { label: "Serif Accent", animation: "duo", font: "jakarta", color: "cream", display: "sentence", letterCase: "sentence", title: "shadow", description: "Kata yang ditekankan berganti ke font serif elegan dan tampil lebih besar." },
  "script-accent": { label: "Script Accent", animation: "script", font: "montserrat", color: "yellow", display: "sentence", letterCase: "sentence", title: "bold", description: "Kata yang ditekankan berganti ke tulisan tangan yang jauh lebih besar." },
};
captionPreset.replaceChildren(...Object.entries(CAPTION_PRESETS).map(([value, preset]) => el("option", { value, textContent: preset.label })));
captionPreset.value = DEFAULT_CAPTION_PRESET;
let captionAnimation = DEFAULT_CAPTION_STYLE;
const DEFAULT_CAPTION_CASE = "sentence";
const STALE_CAPTION_ENGINE = "Server CLIPY.ID masih memakai mesin caption lama. Muat ulang server agar pratinjau dan hasil render sesuai.";
const CAPTION_COLOR_LABELS: Record<string, string> = {
  yellow: "Kuning", white: "Putih", cream: "Krem", orange: "Oranye", green: "Hijau", cyan: "Sian", pink: "Merah muda", red: "Merah",
};
const CAPTION_CASE_LABELS: Record<string, string> = {
  upper: "ALL CAPS", lower: "lowercase", title: "Title Case", sentence: "Sentence case",
};
const THUMBNAIL_DEFAULTS = { source: "auto", titleStyle: "pop", voice: "none" };
let captionPreviewFrame = 0;
let captionPreviewTimer = 0;
let color = DEFAULT_CAPTION_COLOR;
let logoPosition = "bc";
let started = false;
let starting = false;
let showMissingFields = false;
const markedFields = new Set<HTMLElement>();
let apiKeyReady = false;
let mode: "clipping" | "filming" = "clipping";
const clipBackground = $<HTMLSelectElement>("#opt-background");
const clipObjective = $<HTMLTextAreaElement>("#clip-objective");
const clipRatios = ["16:9", "4:3", "1:1", "4:5", "9:16"];

function restoreRatio(select: HTMLSelectElement, value: string) {
  select.querySelector("option[data-legacy]")?.remove();
  if (!clipRatios.includes(value)) {
    const option = new Option(value + " (tersimpan)", value);
    option.hidden = true;
    option.dataset.legacy = "true";
    select.add(option);
  }
  select.value = value;
}

function restoreClipLayout(
  ratio: HTMLSelectElement, background: HTMLSelectElement, canvasRatio: string,
  savedRatio?: string | null, savedBackground?: string | null, inset = false,
) {
  const clipRatio = savedRatio?.includes(":") ? savedRatio : canvasRatio;
  restoreRatio(ratio, clipRatio);
  // Older versions stored "black" for a full-frame clip with no added background.
  const fullFrame = !savedRatio || savedRatio === "auto" || savedRatio === canvasRatio;
  background.value = savedBackground === "black" && fullFrame && !inset
    ? "none"
    : savedBackground ?? "none";
}

function resolveAnimation(value: string) {
  return options?.animation_aliases?.[value] ?? value;
}

function resolveFont(value: string | null | undefined) {
  const resolved = options?.font_aliases?.[value ?? ""] ?? value ?? "";
  return options?.fonts && Object.hasOwn(options.fonts, resolved) ? resolved : DEFAULT_CAPTION_FONT;
}

/** Apply every setting of a caption preset (style, font, colour, case, display). */
function applyCaptionPreset(key: string) {
  const preset = CAPTION_PRESETS[key] ?? CAPTION_PRESETS[DEFAULT_CAPTION_PRESET];
  stopCaptionPreview();
  captionPreset.value = CAPTION_PRESETS[key] ? key : DEFAULT_CAPTION_PRESET;
  captionAnimation = preset.animation;
  captionFont.value = resolveFont(preset.font);
  sel.case.value = preset.letterCase;
  captionMode.value = preset.display;
  setCaptionColor(preset.color);
  $<HTMLElement>("#preset-hint").textContent = preset.description;
}

/** Restore a saved project's caption settings onto the closest preset. */
function restoreCaptionStyle(animation: string, font: string | null | undefined) {
  const resolved = resolveAnimation(animation);
  const savedFont = resolveFont(font);
  const entries = Object.entries(CAPTION_PRESETS);
  const match = entries.find(([, p]) => p.animation === resolved && p.font === savedFont)
    ?? entries.find(([, p]) => p.animation === resolved);
  captionPreset.value = match?.[0] ?? DEFAULT_CAPTION_PRESET;
  captionAnimation = match ? resolved : CAPTION_PRESETS[DEFAULT_CAPTION_PRESET].animation;
  captionFont.value = savedFont;
  $<HTMLElement>("#preset-hint").textContent = (match?.[1] ?? CAPTION_PRESETS[DEFAULT_CAPTION_PRESET]).description;
}

function setCaptionColor(name: string) {
  color = options?.colors && !Object.hasOwn(options.colors, name) ? DEFAULT_CAPTION_COLOR : name;
  swatches.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === color)));
}

/** One line above START so the whole setup can be checked at a glance. */
function summarizeSettings() {
  const text = (select: HTMLSelectElement) => select.selectedOptions[0]?.textContent?.trim() ?? "";
  const parts = mode === "filming"
    ? [`${filmEpisodes.value} episode`, text(filmDuration), text(filmRatio)]
    : [text(sel.count), text(sel.duration), text(sel.ratio)];
  parts.push(CAPTION_PRESETS[captionPreset.value]?.label ?? "", text(captionFont));
  return parts.filter((part) => part && part !== "choose").join(" · ");
}

function captionEngineReady() {
  const animations = options?.animations;
  const fonts = options?.fonts;
  return !!animations && !!fonts && Object.values(CAPTION_PRESETS)
    .every((preset) => Object.hasOwn(animations, preset.animation) && Object.hasOwn(fonts, preset.font));
}

const CAPTION_PREVIEW_CONTEXT = "Biar lebih ";
const captionPreviewContext = $<HTMLElement>("#caption-style-context");
let captionWordTimers: number[] = [];

function stopCaptionPreview() {
  window.cancelAnimationFrame(captionPreviewFrame);
  window.clearTimeout(captionPreviewTimer);
  captionWordTimers.forEach((timer) => window.clearTimeout(timer));
  captionWordTimers = [];
  captionStylePreview.dataset.playing = "false";
  delete captionStylePreview.dataset.wordStep;
  captionPreviewContext.textContent = CAPTION_PREVIEW_CONTEXT;
}

/** Per kata: show one word at a time, exactly like the rendered captions. */
function playCaptionWords() {
  const words = CAPTION_PREVIEW_CONTEXT.trim().split(/\s+/);
  const show = (step: number) => {
    const context = step < words.length;
    captionPreviewContext.textContent = context ? words[step] : CAPTION_PREVIEW_CONTEXT;
    captionStylePreview.dataset.wordStep = context ? "context" : "accent";
    captionStylePreview.dataset.playing = "false";
    void captionStylePreview.offsetWidth; // restart the entrance animation for this word
    captionStylePreview.dataset.playing = "true";
  };
  words.forEach((_, i) => captionWordTimers.push(window.setTimeout(() => show(i), i * 420)));
  captionWordTimers.push(window.setTimeout(() => show(words.length), words.length * 420));
  captionPreviewTimer = window.setTimeout(stopCaptionPreview, words.length * 420 + 1100);
}

function playCaptionPreview() {
  stopCaptionPreview();
  if (reducedCaptionMotion.matches) return;
  captionPreviewFrame = window.requestAnimationFrame(() => {
    captionPreviewFrame = window.requestAnimationFrame(() => {
      if (captionMode.value === "word") {
        playCaptionWords();
        return;
      }
      captionStylePreview.dataset.playing = "true";
      captionPreviewTimer = window.setTimeout(stopCaptionPreview, 1450);
    });
  });
}
const filmBackground = $<HTMLSelectElement>("#film-background");
const filmDubSpeed = $<HTMLInputElement>("#film-dub-speed");
const filmEpisodes = $<HTMLInputElement>("#film-episodes");
const filmDuration = $<HTMLSelectElement>("#film-duration");
const filmVoice = $<HTMLSelectElement>("#film-voice");
const filmRatio = $<HTMLSelectElement>("#film-ratio");
const filmStyle = $<HTMLSelectElement>("#film-style");
const filmPrompt = $<HTMLInputElement>("#film-prompt");
function reveal(step: HTMLElement) {
  if (step.classList.contains("show")) return;
  step.classList.add("show");
  stage.classList.add("flowing");
}

function fill(select: HTMLSelectElement, entries: [string, string][], fallback = "") {
  const previous = select.value;
  select.replaceChildren(
    el("option", { value: "", disabled: true, selected: true, hidden: true, textContent: "choose" }),
    ...entries.map(([value, label]) => el("option", { value, textContent: label })),
  );
  select.value = entries.some(([value]) => value === previous) ? previous : fallback;
}

function loadOptions(): Promise<void> {
  return optionsLoading ??= populateOptions().finally(() => {
    optionsLoading = null;
  });
}

async function populateOptions() {
  const res = await fetch("/api/options", { cache: "no-store" });
  if (!res.ok) throw new Error(`options: ${res.status}`);
  const o: Options = await res.json();
  if (JSON.stringify(options) === JSON.stringify(o)) return;
  const hadOptions = options !== null;
  const narrator = filmVoice.value;
  const branding = { style: brandStyle.value, opacity: brandOpacity.value };
  options = o;
  const savedRatio = sel.ratio.selectedOptions[0]?.dataset.legacy ? sel.ratio.value : null;
  fill(sel.ratio, clipRatios.filter(r => o.ratios.includes(r)).map(r => [r, r]), "9:16");
  if (savedRatio) restoreRatio(sel.ratio, savedRatio);
  fill(sel.count, o.counts.map((n) => [String(n), `${n} clip${n > 1 ? "s" : ""}`]));
  fill(sel.duration, o.durations.map((d) => [String(d), `≤ ${d}s`]));
  if (!sel.count.value) sel.count.value = "4";
  if (!sel.duration.value) sel.duration.value = "60";
  fill(sel.case, Object.entries(o.cases).map(([value, label]) => [value, CAPTION_CASE_LABELS[value] ?? label]), DEFAULT_CAPTION_CASE);
  fill(captionFont, Object.entries(o.fonts ?? {}), DEFAULT_CAPTION_FONT);
  fill(sel.source, [["auto", "auto (from clip)"], ["upload", "upload image"]], THUMBNAIL_DEFAULTS.source);
  fill(sel.titleStyle, Object.entries(o.title_styles), THUMBNAIL_DEFAULTS.titleStyle);
  fill(sel.voice, [["none", "No Voice Over"], ...Object.entries(o.voices)], THUMBNAIL_DEFAULTS.voice);
  filmVoice.replaceChildren(...Object.entries(o.voices).map(([value, label]) => el("option", { value, textContent: label })));
  if (narrator in o.voices) filmVoice.value = narrator;
  if (!(color in o.colors)) color = DEFAULT_CAPTION_COLOR;
  swatches.replaceChildren(
    ...Object.entries(o.colors).map(([name, hex]) => {
      const title = CAPTION_COLOR_LABELS[name] ?? name;
      const b = el("button", { type: "button", title });
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(name === color));
      b.setAttribute("aria-label", title);
      b.dataset.color = name;
      b.style.setProperty("--c", hex);
      return b;
    }),
  );
  // Nine anchor dots over a frame shaped like the chosen aspect ratio.
  positionFrame.replaceChildren(
    ...o.logo_positions.map((pos) => {
      const b = el("button", { type: "button", title: pos });
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", `logo ${pos}`);
      b.dataset.pos = pos;
      return b;
    }),
  );
  thumbFrame.replaceChildren(...o.logo_positions.map((pos) => {
    const name = POSITION_NAMES[pos] ?? pos;
    const button = el("button", { type: "button", title: name });
    button.setAttribute("aria-label", name);
    button.dataset.pos = pos;
    button.addEventListener("click", () => setThumbPosition(pos));
    return button;
  }));
  setThumbPosition(thumbPosition);
  setPosition(logoPosition);
  // Branding is optional, so its selects start on sensible values rather than "choose".
  brandStyle.replaceChildren(...Object.entries(o.brand_styles).map(([value, label]) => el("option", { value, textContent: label })));
  brandOpacity.replaceChildren(...o.brand_opacities.map((v) => el("option", { value: String(v), textContent: `${v}%` })));
  if (hadOptions) {
    brandStyle.value = branding.style in o.brand_styles ? branding.style : BRAND_DEFAULTS.style;
    brandOpacity.value = o.brand_opacities.includes(Number(branding.opacity)) ? branding.opacity : BRAND_DEFAULTS.opacity;
  } else {
    resetBrand();
  }
  progress();
}

window.addEventListener("focus", () => {
  if (options) void loadOptions().catch(() => {});
});

function resetBrand() {
  brandText.value = "";
  brandStyle.value = BRAND_DEFAULTS.style;
  brandOpacity.value = BRAND_DEFAULTS.opacity;
}

function setPosition(pos: string) {
  logoPosition = pos;
  positionFrame.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.pos === pos)));
  positionFrame.dataset.pos = pos;
}

function setThumbPosition(pos: string) {
  thumbPosition = pos;
  thumbFrame.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pos === pos)));
}

function selectedClipLayout() {
  const filming = mode === "filming";
  const clipRatio = (filming ? filmRatio.value : sel.ratio.value) || "9:16";
  const background = filming ? filmBackground.value : clipBackground.value;
  return {
    ratio: background === "none" ? clipRatio : "9:16",
    clip_ratio: clipRatio,
    background,
    background_inset: background !== "none" && clipRatio === "9:16",
  };
}

function shapeFrame() {
  positionFrame.style.aspectRatio = selectedClipLayout().ratio.replace(":", " / ");
  thumbFrame.style.aspectRatio = positionFrame.style.aspectRatio;
}

swatches.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b) return;
  color = b.dataset.color ?? "";
  swatches.querySelectorAll("button").forEach((o) => o.setAttribute("aria-checked", String(o === b)));
  progress();
});

positionFrame.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (b?.dataset.pos) setPosition(b.dataset.pos);
});

function revealSettings() {
  if (mode === "filming") reveal(steps.film);
  else {
    reveal(steps.objective);
    reveal(steps.clip);
  }
  reveal(steps.caption);
  reveal(steps.thumb);
  reveal(steps.start);
}

function missingFields(): HTMLElement[] {
  const filming = mode === "filming";
  const selects = filming
    ? [filmRatio, filmBackground, filmDuration, filmVoice, filmStyle]
    : [sel.ratio, clipBackground, sel.duration, sel.count, sel.voice];
  selects.push(captionPreset, captionFont, sel.case, captionMode, captionPosition, sel.source);
  if (thumbTextMode.value !== "none") selects.push(sel.titleStyle);
  const missing: HTMLElement[] = selects.filter((field) => !field.disabled && !field.value);
  if (filming && !filmEpisodes.validity.valid) missing.push(filmEpisodes);
  if (filming && !filmDubSpeed.validity.valid) missing.push(filmDubSpeed);
  if (thumbTextMode.value === "manual" && !thumbText.value.trim()) missing.push(thumbText);
  if (musicUrl.value.trim() && !musicUrl.validity.valid) missing.push(musicUrl);
  if (!color) missing.push(swatches);
  if (sel.source.value === "upload" && !imageInput.files?.length) missing.push(imagePick);
  if (!apiKeyReady) missing.push(keyInput);
  if (!ready()) missing.push(input);
  return missing;
}

function highlightMissingFields(fields: HTMLElement[]) {
  for (const field of markedFields) {
    field.removeAttribute("aria-invalid");
    (field.closest(".pick, .field") ?? field).classList.remove("missing-required");
  }
  markedFields.clear();
  for (const field of fields) {
    if (!(field instanceof HTMLButtonElement)) field.setAttribute("aria-invalid", "true");
    (field.closest(".pick, .field") ?? field).classList.add("missing-required");
    markedFields.add(field);
  }
}

function setStarted(value: boolean) {
  const moveFocus = value && document.activeElement === startButton;
  started = value;
  startButton.hidden = value;
  newClipButton.hidden = !value;
  if (moveFocus) newClipButton.focus({ preventScroll: true });
}

function progress() {
  captionStylePreview.dataset.style = captionAnimation;
  captionStylePreview.dataset.font = captionFont.value || DEFAULT_CAPTION_FONT;
  captionStylePreview.style.setProperty("--caption-font-scale", String(options?.font_sizes?.[captionFont.value] ?? 1));
  captionStyleName.textContent = (CAPTION_PRESETS[captionPreset.value]?.label ?? captionAnimation).toLowerCase();
  // Aesthetic always renders lowercase, whatever the case picker says.
  const shownCase = captionAnimation === "aesthetic" ? "lower" : sel.case.value;
  captionStyleMeta.textContent = [captionFont.selectedOptions[0]?.textContent ?? "", captionMode.selectedOptions[0]?.textContent ?? "", CAPTION_CASE_TAGS[shownCase] ?? ""]
    .filter(Boolean).join(" · ").toLowerCase();
  settingsSummary.textContent = summarizeSettings();
  captionStylePreview.dataset.display = captionMode.value;
  captionStylePreview.dataset.case = sel.case.value;
  captionStylePreview.style.setProperty("--caption-preview-accent", options?.colors[color] ?? "");
  const staleCaptionEngine = options !== null && !captionEngineReady();
  if (captionStyleStatus.hidden === staleCaptionEngine) {
    captionStyleStatus.hidden = !staleCaptionEngine;
    setHint(captionStyleStatus, staleCaptionEngine ? STALE_CAPTION_ENGINE : "", staleCaptionEngine);
  }
  shapeFrame();
  updateMusicRange();
  sel.titleStyle.parentElement!.hidden = thumbTextMode.value === "none";
  thumbText.hidden = thumbTextMode.value !== "manual";
  thumbText.required = !thumbText.hidden;
  const noTitle = sel.titleStyle.querySelector<HTMLOptionElement>('option[value="none"]');
  if (noTitle) {
    noTitle.hidden = noTitle.disabled = true;
    if (thumbTextMode.value !== "none" && sel.titleStyle.value === "none") sel.titleStyle.value = THUMBNAIL_DEFAULTS.titleStyle;
  }
  const missing = missingFields();
  startButton.setAttribute("aria-disabled", String(
    !steps.start.classList.contains("show") || starting || started || staleCaptionEngine || missing.length > 0,
  ));
  if (showMissingFields) {
    highlightMissingFields(missing);
    if (!missing.length) {
      showMissingFields = false;
      setHint(startHint, "");
    }
  }
  syncPreviews.forEach((sync) => sync());
}

Object.values(sel).forEach((s) => s.addEventListener("change", progress));
for (const [buttonId, step] of [["#film-episodes-up", 1], ["#film-episodes-down", -1]] as const) {
  $<HTMLButtonElement>(buttonId).addEventListener("click", () => {
    if (step > 0) filmEpisodes.stepUp();
    else filmEpisodes.stepDown();
    filmEpisodes.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
document.querySelectorAll<HTMLButtonElement>("[data-step-input]").forEach((button) => {
  const field = $<HTMLInputElement>(`#${button.dataset.stepInput}`);
  button.addEventListener("click", () => {
    if (button.dataset.step === "1") field.stepUp();
    else field.stepDown();
    field.value = Number(field.value).toFixed(1);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
});
thumbText.addEventListener("input", progress);
thumbTextMode.addEventListener("change", progress);
[clipBackground, filmBackground, filmDuration, filmVoice, filmRatio, filmStyle, captionPosition]
  .forEach((field) => field.addEventListener("change", progress));
[filmEpisodes, filmDubSpeed].forEach((field) => field.addEventListener("input", progress));
captionMode.addEventListener("change", () => {
  progress();
  playCaptionPreview();
});
captionPreset.addEventListener("change", () => {
  applyCaptionPreset(captionPreset.value);
  progress();
  playCaptionPreview();
});
captionFont.addEventListener("change", () => {
  progress();
  playCaptionPreview();
});
captionStyleReplay.addEventListener("click", playCaptionPreview);
reducedCaptionMotion.addEventListener("change", stopCaptionPreview);
sel.source.addEventListener("change", () => {
  imagePick.hidden = sel.source.value !== "upload";
  if (sel.source.value === "upload" && !imageInput.files?.length) imageInput.click();
});
imagePick.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => {
  imagePick.textContent = imageInput.files?.[0]?.name ?? "choose image";
  progress();
});

logoPick.addEventListener("click", () => logoInput.click());
logoInput.addEventListener("change", () => {
  const file = logoInput.files?.[0];
  if (logoPreview.src) URL.revokeObjectURL(logoPreview.src);
  logoPreview.hidden = !file;
  logoPreview.src = file ? URL.createObjectURL(file) : "";
  logoName.textContent = file ? file.name : "insert logo";
});

// ---------- API key (asked once, then skipped) ----------

function showKeyBadge(k: KeyState) {
  keyBadge.hidden = !k.set;
  keyBadge.textContent = k.set ? `${k.label} key ${k.masked} · change` : "";
}

function openFlow(k: KeyState, focus = true) {
  apiKeyReady = k.set;
  showKeyBadge(k);
  if (k.set) steps.key.classList.remove("show");
  else reveal(steps.key);
  revealSettings();
  progress();
  if (focus && !k.set) setTimeout(() => keyInput.focus({ preventScroll: true }), 300);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!ready() || button.disabled || starting) return;
  if (started) resetAll(false, true);
  try {
    await loadOptions();
    const res = await fetch("/api/key");
    if (!res.ok) throw new Error(`status ${res.status}`);
    openFlow(await res.json());
  } catch (err) {
    setHint(hint, `can't reach the clipping server (${(err as Error).message})`, true);
  }
});

keyInput.addEventListener("input", () => {
  keyInsert.disabled = !keyInput.value.trim();
  setHint(keyHint, "insert API Key");
});

keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return;
  keyInsert.disabled = true;
  setHint(keyHint, "checking key…");
  try {
    const res = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail ?? `status ${res.status}`);
    keyInput.value = "";
    setHint(keyHint, "insert API Key");
    openFlow(data);
  } catch (err) {
    keyInsert.disabled = false;
    setHint(keyHint, (err as Error).message, true);
  }
});

keyBadge.addEventListener("click", () => {
  reveal(steps.key);
  keyInput.focus({ preventScroll: true });
});

// ---------- START / NEW CLIP ----------

function settings() {
  const layout = selectedClipLayout();
  const caption = {
    animation: captionAnimation, font: captionFont.value || DEFAULT_CAPTION_FONT, color, case: sel.case.value, position: Number(captionPosition.value),
    display: captionMode.value, max_lines: CAPTION_MAX_LINES,
  };
  if (mode === "filming") {
    return {
      mode: "filming",
      music_start: musicStartWanted, music_length: musicWindowLength() || null,
      film: { episodes: Number(filmEpisodes.value), max_duration: Number(filmDuration.value), style: filmStyle.value, additional_prompt: filmPrompt.value.trim(), voice: filmVoice.value, source_ratio: layout.clip_ratio, background: layout.background },
      clip: { ...layout, fit: "crop", count: Number(filmEpisodes.value), max_duration: Number(filmDuration.value), dubbing_speed: Number(filmDubSpeed.value) },
      caption,
      thumb: { source: sel.source.value, title_style: thumbTextMode.value === "none" ? "none" : sel.titleStyle.value, text: thumbTextMode.value === "manual" ? thumbText.value.trim() : "", text_mode: thumbTextMode.value, sequence: thumbNumber.value, position: thumbPosition, voice: null },
      brand: { position: logoPosition, text: brandText.value.trim(), style: brandStyle.value || BRAND_DEFAULTS.style, opacity: Number(brandOpacity.value || BRAND_DEFAULTS.opacity) },
    };
  }
  return {
    objective: clipObjective.value.trim(),
    music_start: musicStartWanted, music_length: musicWindowLength() || null,
    clip: { ...layout, fit: "crop", count: Number(sel.count.value), max_duration: Number(sel.duration.value) },
    caption,
    thumb: {
      source: sel.source.value,
      title_style: thumbTextMode.value === "none" ? "none" : sel.titleStyle.value,
      text: thumbTextMode.value === "manual" ? thumbText.value.trim() : "",
      text_mode: thumbTextMode.value,
      sequence: thumbNumber.value,
      position: thumbPosition,
      voice: sel.voice.value === "none" ? null : sel.voice.value,
    },
    brand: {
      position: logoPosition,
      text: brandText.value.trim(),
      style: brandStyle.value || BRAND_DEFAULTS.style,
      opacity: Number(brandOpacity.value || BRAND_DEFAULTS.opacity),
    },
  };
}

startButton.addEventListener("click", async () => {
  if (starting || started || !steps.start.classList.contains("show")) return;
  if (!captionEngineReady()) {
    const source = current;
    const submissionMode = mode;
    starting = true;
    try {
      await loadOptions();
    } catch {
      setHint(startHint, "Server CLIPY.ID belum dapat dihubungi. Coba lagi.", true);
      return;
    } finally {
      starting = false;
      progress();
    }
    if (current !== source || mode !== submissionMode || !steps.start.classList.contains("show")) return;
    if (!captionEngineReady()) {
      setHint(startHint, STALE_CAPTION_ENGINE, true);
      return;
    }
  }
  if (!current || missingFields().length) {
    showMissingFields = true;
    progress();
    setHint(startHint, "Periksa isian yang disorot.", true);
    return;
  }
  starting = true;
  startButton.setAttribute("aria-disabled", "true");
  setHint(startHint, "starting…");
  try {
    const body = new FormData();
    if (current.reuse) {
      // Clipping a video done before: the server takes the source from that project.
      body.append("reuse", current.reuse);
    } else if (current.kind === "file") {
      body.append("upload_id", current.uploadId ?? "");
      body.append("title", current.title);
    } else {
      // The raw link goes along so a ?t= timestamp is kept with it.
      body.append("url", input.value.trim());
    }
    body.append("settings", JSON.stringify(settings()));
    if (exportDir) body.append("export_dir", exportDir);
    if (mode === "filming" && subtitleInput.files?.[0]) body.append("subtitle", subtitleInput.files[0]);
    if (sel.source.value === "upload" && imageInput.files?.[0]) body.append("image", imageInput.files[0]);
    if (logoInput.files?.[0]) body.append("logo", logoInput.files[0]);
    if (musicInput.files?.[0]) body.append("music", musicInput.files[0]);
    else if (musicUrl.value.trim()) body.append("music_url", musicUrl.value.trim());
    const res = await fetch("/api/projects", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `status ${res.status}`);
    setStarted(true);
    setHint(startHint, "started · follow it in project result");
    await refreshProjects();
    resultsCollapsed = false;
    try { localStorage.setItem("clipy-results-collapsed", "false"); } catch {}
    updateResultsPanel();
    if (!projectsPanel.hidden) {
      const target = projectCards.get(data.id)?.node ?? projectsPanel;
      target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    }
  } catch (err) {
    setHint(startHint, (err as Error).message, true);
  } finally {
    starting = false;
    progress();
  }
});

/** Empty every field and fold the steps away, ready for the next video. */
function resetAll(focus = true, keepSource = false) {
  clipObjective.value = "";
  filmPrompt.value = "";
  setStarted(false);
  if (!keepSource) {
    input.value = "";
    clear();
  } else {
    clearSubtitle();
  }
  setHint(hint, HINT);
  Object.values(sel).forEach((s) => (s.selectedIndex = 0));
  sel.case.value = DEFAULT_CAPTION_CASE;
  sel.source.value = THUMBNAIL_DEFAULTS.source;
  sel.titleStyle.value = THUMBNAIL_DEFAULTS.titleStyle;
  sel.voice.value = THUMBNAIL_DEFAULTS.voice;
  color = DEFAULT_CAPTION_COLOR;
  swatches.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === color)));
  imageInput.value = "";
  thumbText.value = "";
  thumbTextMode.value = "auto";
  filmDubSpeed.value = "1.0";
  restoreRatio(sel.ratio, "9:16");
  restoreRatio(filmRatio, "9:16");
  sel.count.value = "4";
  sel.duration.value = "60";
  filmDuration.value = "60";
  filmStyle.selectedIndex = 0;
  filmVoice.selectedIndex = 0;
  clipBackground.value = "none";
  filmBackground.value = "none";
  filmEpisodes.value = filmEpisodes.defaultValue;
  thumbNumber.value = "off";
  setThumbPosition("bc");
  captionPosition.value = "6";
  captionMode.value = "sentence";
  applyCaptionPreset(DEFAULT_CAPTION_PRESET);
  document.querySelectorAll<HTMLDetailsElement>(".optional-section").forEach((section) => { section.open = false; });
  imagePick.hidden = true;
  imagePick.textContent = "choose image";
  musicInput.value = "";
  musicUrl.value = "";
  musicInput.dispatchEvent(new Event("change"));
  logoInput.value = "";
  logoInput.dispatchEvent(new Event("change"));
  setPosition("bc");
  resetBrand();
  Object.values(steps).forEach((s) => s.classList.remove("show"));
  stage.classList.remove("flowing");
  setHint(startHint, "");
  progress();
  if (focus) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    input.focus({ preventScroll: true });
  }
}
newClipButton.addEventListener("click", () => resetAll());

document.querySelectorAll<HTMLButtonElement>(".mode-select button").forEach((choice) => choice.addEventListener("click", () => {
  const next = choice.dataset.mode === "filming" ? "filming" : "clipping";
  if (next === mode) return;
  mode = next;
  if (mode !== "filming") clearSubtitle();
  subtitleUpload.hidden = mode !== "filming" || !current;
  document.querySelectorAll<HTMLButtonElement>(".mode-select button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  $("#mode-description").textContent = mode === "filming"
    ? "bikin alur cerita film jadi serial konten"
    : "potong moment menarik dari video panjang";
  $<HTMLElement>("#thumb-dubbing").hidden = mode === "filming";
  const wasOpen = steps.start.classList.contains("show");
  const keyVisible = steps.key.classList.contains("show");
  Object.values(steps).forEach((step) => step.classList.remove("show"));
  setStarted(false);
  setHint(startHint, "");
  stage.classList.remove("flowing");
  if (wasOpen) revealSettings();
  if (keyVisible) reveal(steps.key);
  progress();
}));

// ---------- project result ----------

const projectsPanel = $<HTMLElement>("#projects");
const projectsToggle = $<HTMLButtonElement>("#projects-toggle");
const resultsDesktop = window.matchMedia("(min-width: 1320px)");
let resultsCollapsed = false;
try { resultsCollapsed = localStorage.getItem("clipy-results-collapsed") === "true"; } catch {}
function updateResultsPanel() {
  const available = !projectsPanel.hidden;
  const collapsed = resultsDesktop.matches && resultsCollapsed;
  document.querySelector(".layout")!.classList.toggle("results-collapsed", collapsed || !available);
  projectsToggle.hidden = !available;
  projectsToggle.setAttribute("aria-expanded", String(!collapsed));
  projectsToggle.textContent = collapsed ? "← project result" : "hide results →";
  projectsPanel.inert = collapsed;
  if (collapsed) projectsPanel.setAttribute("aria-hidden", "true");
  else projectsPanel.removeAttribute("aria-hidden");
}
projectsToggle.addEventListener("click", () => {
  resultsCollapsed = !resultsCollapsed;
  try { localStorage.setItem("clipy-results-collapsed", String(resultsCollapsed)); } catch {}
  updateResultsPanel();
});
resultsDesktop.addEventListener("change", updateResultsPanel);
updateResultsPanel();
const projectList = $<HTMLOListElement>("#project-list");
const projectCards = new Map<string, { signature: string; node: HTMLLIElement }>();
let polling = 0;
let projectRefresh = 0;

const label = (group: keyof Options, key: string | null | undefined) => {
  const table = options?.[group] as Record<string, string> | undefined;
  const resolved = group === "animations" && key ? options?.animation_aliases?.[key] ?? key
    : group === "fonts" && key ? options?.font_aliases?.[key] ?? key : key;
  if (group === "cases" && resolved && CAPTION_CASE_LABELS[resolved]) return CAPTION_CASE_LABELS[resolved];
  return (resolved && table && !Array.isArray(table) && table[resolved]) || resolved || "";
};

const POSITION_NAMES: Record<string, string> = {
  tl: "top left", tc: "top", tr: "top right", ml: "left", mc: "center", mr: "right", bl: "bottom left", bc: "bottom", br: "bottom right",
};

function projectCard(p: Project): HTMLLIElement {
  const s = p.settings;
  const running = !["done", "error", "cancelled"].includes(p.status);
  const status =
    p.status === "cancelled" ? el("p", { className: "progress", textContent: "dihentikan" }) : p.status === "error"
      ? el("p", { className: "progress error", textContent: `failed · ${p.error ?? "unknown error"}` })
      : el("p", { className: `progress${running ? "" : " done"}`, textContent: running ? `${asciiBar(p.progress)} ${p.stage}` : `${p.clips.some((c) => c.status === "error") ? "selesai sebagian" : "done"} · ${p.clips.filter((c) => c.status === "done").length} clips` });
  const meta = mountProjectSettings({ project: p, label, colors: options?.colors ?? {}, positions: POSITION_NAMES });

  // Source media remains the title/thumbnail destination; dashboard gets its own explicit control.
  const sourceTitle = p.title || p.url;
  const sourceCover = el("img", { className: "project-thumb", src: p.thumbnail, alt: "" });
  const openSource = async (control: HTMLElement) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(p.id)}/source/open`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `status ${response.status}`);
    } catch (error) {
      control.title = error instanceof Error ? error.message : String(error);
    }
  };
  const cover = p.url
    ? el("a", { className: "project-open", href: p.url, target: "_blank", rel: "noopener", title: "Buka video sumber di YouTube" }, sourceCover)
    : el("button", { type: "button", className: "project-open", title: "Buka folder video sumber" }, sourceCover);
  const heading = p.url
    ? el("a", { className: "project-title", href: p.url, target: "_blank", rel: "noopener", textContent: sourceTitle, title: "Buka video sumber di YouTube" })
    : el("button", { type: "button", className: "project-title", textContent: sourceTitle, title: "Buka folder video sumber" });
  if (p.url) {
    openYoutubeInBrowser(cover, p.url);
    openYoutubeInBrowser(heading, p.url);
  } else {
    cover.addEventListener("click", () => { void openSource(cover); });
    heading.addEventListener("click", () => { void openSource(heading); });
  }
  const dashboard = el("button", { type: "button", className: "project-dashboard-open", title: "Buka dashboard project", textContent: "Open Dashboard" });
  dashboard.addEventListener("click", () => openEditor(p.id));
  const headingRow = el("div", { className: "project-heading" }, heading);
  // Gen more: extra clips from the saved transcript, never repeating an earlier clip.
  const moreCount = el("select", { className: "project-more-count", title: "Jumlah clip tambahan" },
    ...Array.from({ length: 10 }, (_, i) => el("option", { value: String(i + 1), textContent: String(i + 1), selected: i === 1 })));
  moreCount.setAttribute("aria-label", "Jumlah clip tambahan");
  const moreButton = el("button", { type: "button", className: "project-more-button", textContent: "Gen More",
    title: "Buat clip tambahan dari transkrip project ini, tanpa mengulang clip yang sudah ada" });
  const moreError = el("span", { className: "project-more-error", role: "status" });
  moreButton.addEventListener("click", async () => {
    moreButton.disabled = moreCount.disabled = true;
    moreError.textContent = "";
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(p.id)}/more`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: Number(moreCount.value) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        // FastAPI's own "Not Found" means the route is missing: the server is still the old one.
        throw new Error((response.status === 404 && body?.detail === "Not Found") || response.status === 405
          ? "Server belum dimuat ulang. Tutup CLIPY.ID, hentikan server, lalu buka lagi."
          : typeof body?.detail === "string" ? body.detail : `status ${response.status}`);
      }
      const queued: Project = await response.json();
      const node = projectCard(queued);
      projectCards.set(queued.id, { signature: JSON.stringify(queued), node });
      const previous = moreButton.closest(".project");
      previous?.replaceWith(node);
      if (previous) disposeProjectIslands(previous);
      await refreshProjects();
    } catch (err) {
      moreButton.disabled = moreCount.disabled = false;
      moreError.textContent = (err as Error).message;
    }
  });
  const more = el("div", { className: "project-more" }, moreButton, moreCount);
  // Older servers do not report can_more; infer it so the control is never silently missing.
  const canMore = p.can_more ?? ((["done", "error"] as string[]).includes(p.status) && p.settings.mode !== "filming");
  const source = el("div", { className: "project-source" }, cover, dashboard, canMore && more, canMore && moreError);

  const removable = p.status === "cancelled" || p.status === "error";
  const hasProjectControl = running || removable;
  const control = el("button", { type: "button", className: "text-button project-control", textContent: removable ? "hapus" : p.status === "stopping" ? "menghentikan…" : "stop" });
  control.hidden = !running && !removable;
  control.disabled = p.status === "stopping";
  control.addEventListener("click", async () => {
    if (removable && !window.confirm("Hapus proyek ini beserta hasilnya?")) return;
    control.disabled = true;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(p.id)}${removable ? "" : "/stop"}`, { method: removable ? "DELETE" : "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.detail === "string" ? body.detail : `status ${response.status}`);
      }
      if (!removable) {
        const stopped: Project = await response.json();
        const node = projectCard(stopped);
        projectCards.set(stopped.id, { signature: JSON.stringify(stopped), node });
        const previous = control.closest(".project");
        previous?.replaceWith(node);
        if (previous) disposeProjectIslands(previous);
      }
      await refreshProjects();
    } catch (err) {
      control.disabled = false;
      control.title = (err as Error).message;
    }
  });

  // Jobs stopped before producing anything can be resumed with their saved inputs.
  const restartable = ["cancelled", "error"].includes(p.status) && p.progress === 0 && p.clips.length === 0;
  const restart = el("button", { type: "button", className: "text-button", textContent: "lanjutkan proyek" });
  restart.addEventListener("click", async () => {
    restart.disabled = true;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(p.id)}/restart`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.detail === "string" ? body.detail : `status ${response.status}`);
      }
      await refreshProjects();
    } catch (err) {
      restart.disabled = false;
      restart.textContent = `gagal: ${(err as Error).message}`;
    }
  });

  return el(
    "li",
    { className: `project${hasProjectControl ? " has-project-control" : ""}` },
    control,
    source,
    el("div", {}, el("h3", {}, headingRow), status, p.notice && !running && el("p", { className: "progress project-notice", textContent: p.notice }), restartable && restart, meta),
    p.clips.length > 0 && mountClipResults({ project: p, onPreview: openPreview, onRetry: retryClip, onRefresh: () => { void refreshProjects(); } }),
    filmConcatControls(p),
  );
}

async function refreshProjects() {
  const refresh = ++projectRefresh;
  clearTimeout(polling);
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error(String(res.status));
    const list: Project[] = await res.json();
    if (!options && list.length) await loadOptions().catch(() => {});
    if (refresh !== projectRefresh) return;
    projectsPanel.hidden = list.length === 0;
    updateResultsPanel();
    const cards = list.map((project) => {
      const signature = JSON.stringify(project);
      const cached = projectCards.get(project.id);
      if (cached?.signature === signature) return cached.node;
      const node = projectCard(project);
      projectCards.set(project.id, { signature, node });
      return node;
    });
    const existing = [...projectList.children];
    if (cards.length !== existing.length || cards.some((node, i) => node !== existing[i])) {
      cards.forEach((node, i) => {
        if (projectList.children[i] !== node) projectList.insertBefore(node, projectList.children[i] ?? null);
      });
      while (projectList.children.length > cards.length) {
        const removed = projectList.lastElementChild!;
        removed.remove();
        disposeProjectIslands(removed);
      }
    }
    for (const id of projectCards.keys()) if (!list.some((p) => p.id === id)) projectCards.delete(id);
    const active = list.some((p) => !["done", "error", "cancelled"].includes(p.status));
    polling = window.setTimeout(refreshProjects, active ? 1500 : 15000);
  } catch {
    // The API may be restarting; try again shortly.
    if (refresh === projectRefresh) polling = window.setTimeout(refreshProjects, 5000);
  }
}
refreshProjects();

// Avoid opening the phone keyboard before the user chooses link or upload.
if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) input.focus();



