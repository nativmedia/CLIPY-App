/**
 * Clip editor in the spirit of Remotion / CapCut: a live preview player with a
 * caption overlay, a timeline with in/out handles and a caption track, and the
 * transcript as one editable box per sentence with its time range. Saving
 * re-renders the clip in place.
 */

import "./clip-editor.css";

type EditWord = { text: string; start: number; end: number };
type CaptionLook = {
  font: string;
  accent_font: string;
  accent: string;
  case: string;
  position: number | null;
  display: string;
  animation: string;
  size: number;
  max_lines?: number;
};
type EditInfo = {
  n: number;
  title: string;
  start: number;
  end: number;
  min_duration: number;
  max_duration: number;
  window: [number, number];
  duration: number;
  intro: number;
  video?: string | null;
  caption: CaptionLook;
  words: EditWord[];
};
type Fix = { start: number; end: number; text: string; orig: string; kind?: "word" | "line" };
type Edge = "start" | "end";
type Sentence = { key: string; words: EditWord[]; start: number; end: number };
type Source = { url: string; offset: number; from: number; to: number; full: boolean };

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: Child[]
) {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children.filter((c): c is Node | string => !!c));
  return node;
}

const round1 = (s: number) => Math.round(s * 10) / 10;
/** Clips render at 30 fps, so one frame is the finest trim step. */
const FPS = 30;
const snapFrame = (s: number) => Math.round(s * FPS) / FPS;
/** CapCut-style clip time: 00:03.4 */
function tc(s: number): string {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}
function clockText(s: number): string {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function signed(s: number): string {
  // Small trims read better in frames (30 fps), larger ones in seconds.
  const frames = Math.round(s * 30);
  if (frames === 0) return "±0";
  const sign = frames > 0 ? "+" : "−";
  return Math.abs(s) < 1 ? `${sign}${Math.abs(frames)}f` : `${sign}${Math.abs(round1(s))}s`;
}
function bar(value: number, max: number, cells = 16): string {
  const filled = Math.max(0, Math.min(cells, Math.round((value / max) * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}
const tokens = (text: string) => text.split(/\s+/).filter(Boolean);

/** Group words into CapCut-like sentences: punctuation, pauses and a length cap. */
function sentencesOf(words: EditWord[]): Sentence[] {
  const out: Sentence[] = [];
  let current: EditWord[] = [];
  const flush = () => {
    if (!current.length) return;
    out.push({ key: current[0].start.toFixed(3), words: current, start: current[0].start, end: current[current.length - 1].end });
    current = [];
  };
  words.forEach((w, i) => {
    const prev = current[current.length - 1];
    if (prev && (w.start - prev.end > 0.8 || current.length >= 12 || w.end - current[0].start > 6.5)) flush();
    current.push(w);
    const next = words[i + 1];
    if (/[.!?…]$/.test(w.text) && (!next || current.length >= 3)) flush();
  });
  flush();
  return out;
}

let active: { close: () => void } | null = null;

export async function openClipEditor(projectId: string, clipNumber: number, ratio: string, onSaved: () => void): Promise<void> {
  active?.close();
  const base = `/api/projects/${encodeURIComponent(projectId)}/clips/${clipNumber}/edit`;
  const res = await fetch(base);
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(res.status === 404 && !detail ? "Server belum dimuat ulang" : detail ?? `status ${res.status}`);
  }
  buildEditor(base, (await res.json()) as EditInfo, ratio, onSaved);
}

function buildEditor(base: string, info: EditInfo, ratio: string, onSaved: () => void) {
  const [lo, hi] = info.window;
  const original = { start: info.start, end: info.end };
  const range = { start: info.start, end: info.end };
  const words = info.words;
  /** Edited sentence text, keyed by the sentence's first word start. */
  const edits = new Map<string, string>();
  let sentences: Sentence[] = [];
  let source: Source | null = info.video
    ? { url: info.video, offset: original.start - info.intro, from: original.start, to: original.end, full: false }
    : null;
  let loop = true;
  let raf = 0;
  let dragging = false;

  // ---------- frame ----------
  const video = h("video", { className: "ce-video", playsInline: true, preload: "auto" });
  const capLine = h("div", { className: "ce-cap", ariaHidden: "true" });
  const stageNote = h("div", { className: "ce-stage-note" });
  const stage = h("div", { className: "ce-stage" }, video, capLine, stageNote);
  const [rw, rh] = ratio.split(":").map(Number);
  stage.style.aspectRatio = `${rw} / ${rh}`;
  stage.style.width = `min(100%, calc(var(--stage-h) * ${rw} / ${rh}))`;
  const loading = h("div", { className: "ce-loading", hidden: true }, h("span", { className: "ce-spinner" }), h("span", { textContent: "menyiapkan preview…" }));
  stage.append(loading);
  const look = info.caption;
  stage.style.setProperty("--cap-font", `"Caption ${look.font}"`);
  stage.style.setProperty("--cap-accent", look.accent);
  stage.style.setProperty("--cap-scale", String(look.size || 1));
  stage.dataset.case = look.case;
  const capTop = look.position ? 17 + (look.position - 1) * 11 : 72;
  capLine.style.top = `${capTop}%`;

  const playBtn = h("button", { type: "button", className: "ce-play", ariaLabel: "putar", title: "putar / jeda (spasi)" });
  const timeNow = h("span", { className: "ce-time" });
  const loopBtn = h("button", { type: "button", className: "ce-chip is-on", textContent: "⟲ loop", title: "ulang dalam rentang clip" });
  const sourceNote = h("span", { className: "ce-source" });
  const retryPreview = h("button", { type: "button", className: "ce-chip", textContent: "coba lagi", hidden: true });
  const transport = h("div", { className: "ce-transport" }, playBtn, timeNow, loopBtn);
  const status = h("div", { className: "ce-status" }, sourceNote, retryPreview);

  const list = h("div", { className: "ce-list" });
  const listCount = h("span", { className: "ce-count" });
  const listPanel = h(
    "div",
    { className: "ce-script" },
    h("div", { className: "ce-script-head" }, h("span", { textContent: "// transkrip" }), listCount),
    list,
  );

  // timeline
  const ruler = h("div", { className: "ce-ruler", ariaHidden: "true" });
  const outLeft = h("div", { className: "ce-dim" });
  const outRight = h("div", { className: "ce-dim" });
  const ghost = h("div", { className: "ce-ghost", title: "potongan asli" });
  const selection = h("div", { className: "ce-sel" }, h("span", { className: "ce-sel-label" }));
  const handle = (edge: Edge) =>
    h("button", {
      type: "button",
      className: `ce-handle ce-handle-${edge}`,
      role: "slider",
      ariaLabel: edge === "start" ? "awal clip" : "akhir clip",
      title: "geser · ←/→ 1 detik · shift 5 detik",
    });
  const handleStart = handle("start");
  const handleEnd = handle("end");
  const videoTrack = h("div", { className: "ce-track ce-track-video" }, outLeft, outRight, ghost, selection, handleStart, handleEnd);
  const captionTrack = h("div", { className: "ce-track ce-track-cap" });
  const playhead = h("div", { className: "ce-playhead", ariaHidden: "true" });
  const lanes = h(
    "div",
    { className: "ce-lanes" },
    ruler,
    h("div", { className: "ce-lane" }, h("span", { className: "ce-lane-name", textContent: "clip" }), videoTrack),
    h("div", { className: "ce-lane" }, h("span", { className: "ce-lane-name", textContent: "caption" }), captionTrack),
    playhead,
  );

  const meter = h("span", { className: "ce-meter" });
  const lengthText = h("b");
  const limitNote = h("span", { className: "ce-limit" });
  const nudges = (edge: Edge) =>
    h(
      "div",
      { className: "ce-nudge" },
      // Each side only adds time outward: the start moves earlier, the end later.
      // The biggest step sits farthest from the duration in the middle.
      ...(edge === "start"
        ? [[5 * FPS, "5s"], [FPS, "1s"], [10, "10f"], [1, "1f"]] as const
        : [[1, "1f"], [10, "10f"], [FPS, "1s"], [5 * FPS, "5s"]] as const).map(([frames, label]) =>
        h("button", {
          type: "button",
          className: "ce-chip",
          // Left moves the start back in time (−), right moves the end forward (+).
          textContent: `${edge === "start" ? "−" : "+"}${label}`,
          title: edge === "start" ? `mulai ${label} lebih awal` : `selesai ${label} lebih lama`,
          onclick: () => move(edge, range[edge] + (edge === "start" ? -frames : frames) / FPS),
        }),
      ),
    );
  const timelineFoot = h(
    "div",
    { className: "ce-tl-foot" },
    nudges("start"),
    h("p", { className: "ce-length" }, "durasi ", lengthText, " ", meter, " ", limitNote),
    nudges("end"),
  );

  const summary = h("p", { className: "ce-summary", ariaLive: "polite" });
  const error = h("p", { className: "hint error ce-error" });
  const cancel = h("button", { type: "button", className: "text-button", textContent: "batal" });
  const reset = h("button", { type: "button", className: "text-button", textContent: "reset semua" });
  const save = h("button", { type: "button", className: "ce-save", textContent: "simpan & render ulang" });

  const close = () => {
    cancelAnimationFrame(raf);
    video.pause();
    video.removeAttribute("src");
    video.load();
    root.remove();
    document.removeEventListener("keydown", onKey);
    if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("locked");
    active = null;
  };
  active = { close };

  const root = h(
    "div",
    { className: "modal ce-modal" },
    h(
      "div",
      { className: "modal-box ce-box", role: "dialog", ariaModal: "true", ariaLabel: `Edit clip ${info.n}` },
      h("button", { type: "button", className: "modal-close", ariaLabel: "tutup", textContent: "×", onclick: close }),
      h(
        "div",
        { className: "ce-head" },
        h("p", { className: "kicker" }, h("span", { textContent: `edit clip ${String(info.n).padStart(2, "0")}` })),
        h("h3", { className: "ce-title", textContent: info.title }),
        h("p", { className: "ce-help", textContent: "spasi putar/jeda · seret pegangan sian untuk memotong · klik kalimat untuk mengubah teks" }),
      ),
      h("div", { className: `ce-grid${rw > rh ? " is-landscape" : ""}` }, h("div", { className: "ce-player" }, stage, transport, status), listPanel),
      h("div", { className: "ce-timeline" }, lanes, timelineFoot),
      h("div", { className: "ce-foot" }, summary, error, h("div", { className: "ce-foot-actions" }, reset, cancel, save)),
    ),
  );
  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });
  cancel.addEventListener("click", close);

  // ---------- player ----------
  const now = () => (source ? source.offset + video.currentTime : range.start);
  function covered(t: number) {
    return !!source && t >= source.from - 0.05 && t <= source.to + 0.05;
  }
  function seek(t: number) {
    t = Math.max(lo, Math.min(hi, t));
    if (source && covered(t)) video.currentTime = Math.max(0, t - source.offset);
    paint(t);
  }
  function setPlaying(on: boolean) {
    if (on) {
      if (!source) return;
      const t = now();
      if (t < range.start - 0.05 || t >= range.end - 0.05) seek(range.start);
      video.play().catch(() => {});
    } else video.pause();
  }
  playBtn.addEventListener("click", () => setPlaying(video.paused));
  loopBtn.addEventListener("click", () => {
    loop = !loop;
    loopBtn.classList.toggle("is-on", loop);
  });
  video.addEventListener("play", () => {
    playBtn.classList.add("is-playing");
    playBtn.ariaLabel = "jeda";
    tick();
  });
  video.addEventListener("pause", () => {
    playBtn.classList.remove("is-playing");
    playBtn.ariaLabel = "putar";
    cancelAnimationFrame(raf);
    paint(now());
  });
  video.addEventListener("seeked", () => paint(now()));
  video.addEventListener("loadedmetadata", () => seek(range.start));

  function tick() {
    cancelAnimationFrame(raf);
    const t = now();
    if (!dragging && t >= range.end) {
      if (loop) seek(range.start);
      else {
        video.pause();
        seek(range.end);
        return;
      }
    }
    paint(t);
    if (!video.paused) raf = requestAnimationFrame(tick);
  }

  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    if (e.key === "Escape" && !typing) close();
    if (e.key === " " && !typing && !(e.target instanceof HTMLButtonElement && e.target.classList.contains("ce-handle"))) {
      e.preventDefault();
      setPlaying(video.paused);
    }
  };
  document.addEventListener("keydown", onKey);

  // ---------- live caption overlay ----------
  function textOf(s: Sentence) {
    return edits.get(s.key) ?? s.words.map((w) => w.text).join(" ");
  }
  function paintCaption(t: number) {
    if (!source?.full) {
      // The rendered clip already carries its captions; drawing ours on top would double them.
      capLine.replaceChildren();
      return;
    }
    const s = sentences.find((x) => t >= x.start - 0.05 && t < x.end + 0.35);
    if (!s || t < range.start || t > range.end) {
      capLine.replaceChildren();
      return;
    }
    const shown = tokens(textOf(s));
    let at: number;
    if (!edits.has(s.key) || shown.length === s.words.length) {
      at = s.words.findIndex((w) => t >= w.start && t < w.end);
      if (at < 0) at = s.words.filter((w) => w.end <= t).length - 1;
    } else {
      at = Math.min(shown.length - 1, Math.floor(((t - s.start) / Math.max(0.1, s.end - s.start)) * shown.length));
    }
    if (look.display === "word") {
      const one = shown[Math.max(0, at)] ?? "";
      capLine.replaceChildren(h("span", { className: "is-on", textContent: one }));
      return;
    }
    // Like the render: a long sentence is shown a page (max lines) at a time.
    const page = pagesOf(shown).find((indexes) => indexes.includes(Math.max(0, at))) ?? [];
    capLine.replaceChildren(
      ...page.flatMap((i, k) => [
        k ? " " : "",
        h("span", { className: i === at ? "is-on" : i < at ? "is-said" : "", textContent: shown[i] }),
      ]),
    );
  }

  const measure = document.createElement("canvas").getContext("2d");
  const maxLines = look.display === "sentence" ? Math.max(1, look.max_lines ?? 2) : 1;
  function pagesOf(shown: string[]): number[][] {
    const width = capLine.clientWidth;
    if (!measure || !width) return [shown.map((_, i) => i)];
    const css = getComputedStyle(capLine);
    measure.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    const shape = (t: string) => (look.case === "upper" ? t.toUpperCase() : look.case === "lower" ? t.toLowerCase() : t);
    const space = measure.measureText(" ").width;
    const lines: number[][] = [[]];
    let used = 0;
    shown.forEach((token, i) => {
      const w = measure.measureText(shape(token)).width;
      if (lines[lines.length - 1].length && used + space + w > width) {
        lines.push([]);
        used = 0;
      }
      used += (lines[lines.length - 1].length ? space : 0) + w;
      lines[lines.length - 1].push(i);
    });
    const pages: number[][] = [];
    for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines).flat());
    return pages;
  }

  // ---------- transcript boxes ----------
  const boxes = new Map<string, { box: HTMLElement; area: HTMLTextAreaElement; block: HTMLElement }>();
  function grow(area: HTMLTextAreaElement) {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }
  function renderSentences() {
    const inRange = words.filter((w) => w.end > range.start + 0.02 && w.start < range.end - 0.02);
    sentences = sentencesOf(inRange);
    boxes.clear();
    list.replaceChildren(
      ...sentences.map((s) => {
        const fresh = s.end <= original.start + 0.02 || s.start >= original.end - 0.02;
        const time = h("button", {
          type: "button",
          className: "ce-box-time",
          textContent: `${tc(s.start - range.start)}  →  ${tc(s.end - range.start)}`,
          title: "putar dari kalimat ini",
          onclick: () => {
            seek(s.start);
            setPlaying(true);
          },
        });
        const undo = h("button", { type: "button", className: "ce-undo", textContent: "↺", title: "kembalikan teks asli" });
        const area = h("textarea", { className: "ce-area", rows: 1, spellcheck: false, value: textOf(s) });
        area.ariaLabel = `kalimat ${tc(s.start - range.start)}`;
        const box = h("div", { className: "ce-sentence" }, h("div", { className: "ce-sentence-head" }, time, fresh ? h("span", { className: "ce-tag", textContent: "baru" }) : null, undo), area);
        const sync = () => {
          const originalText = s.words.map((w) => w.text).join(" ");
          const value = area.value.replace(/\s+/g, " ").trim();
          if (value === originalText) edits.delete(s.key);
          else edits.set(s.key, value);
          box.classList.toggle("is-edited", edits.has(s.key));
          box.classList.toggle("is-removed", edits.has(s.key) && !value);
          boxes.get(s.key)?.block.classList.toggle("is-edited", edits.has(s.key));
          paint(now());
          refresh();
        };
        area.addEventListener("input", () => {
          grow(area);
          sync();
        });
        area.addEventListener("focus", () => {
          if (now() < s.start || now() >= s.end) seek(s.start);
        });
        area.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const keys = [...boxes.keys()];
            boxes.get(keys[keys.indexOf(s.key) + 1])?.area.focus();
          }
        });
        undo.addEventListener("click", () => {
          area.value = s.words.map((w) => w.text).join(" ");
          grow(area);
          sync();
        });
        box.classList.toggle("is-edited", edits.has(s.key));
        box.classList.toggle("is-new", fresh);
        const block = h("button", { type: "button", className: "ce-block", title: textOf(s) });
        block.style.left = `${pct(s.start)}%`;
        block.style.width = `${Math.max(0.4, pct(s.end) - pct(s.start))}%`;
        block.classList.toggle("is-edited", edits.has(s.key));
        block.addEventListener("click", () => {
          seek(s.start);
          area.focus({ preventScroll: true });
          box.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
        boxes.set(s.key, { box, area, block });
        requestAnimationFrame(() => grow(area));
        return box;
      }),
    );
    captionTrack.replaceChildren(...[...boxes.values()].map((b) => b.block));
    listCount.textContent = `${sentences.length} kalimat`;
  }

  let lastActive = "";
  function paintActiveSentence(t: number) {
    const s = sentences.find((x) => t >= x.start && t < x.end + 0.35);
    const key = s?.key ?? "";
    if (key === lastActive) return;
    boxes.get(lastActive)?.box.classList.remove("is-active");
    boxes.get(lastActive)?.block.classList.remove("is-active");
    lastActive = key;
    const entry = boxes.get(key);
    if (!entry) return;
    entry.box.classList.add("is-active");
    entry.block.classList.add("is-active");
    // Follow the playhead while playing and while scrubbing the timeline.
    if ((!video.paused || dragging) && document.activeElement?.closest(".ce-list") == null) {
      list.scrollTo({ top: entry.box.offsetTop - list.offsetTop - 8, behavior: "smooth" });
    }
  }

  function paint(t: number) {
    playhead.style.left = `calc(var(--lane-name) + (100% - var(--lane-name)) * ${pct(t) / 100})`;
    timeNow.textContent = `${tc(Math.max(0, t - range.start))} / ${tc(range.end - range.start)}`;
    stageNote.textContent = source && !covered(t) ? "bagian ini terlihat setelah render ulang" : "";
    stage.classList.toggle("is-outside", t < range.start - 0.05 || t > range.end + 0.05);
    paintCaption(t);
    paintActiveSentence(t);
  }

  // ---------- timeline & range ----------
  const pct = (t: number) => ((t - lo) / (hi - lo)) * 100;
  const atPx = (clientX: number) => {
    const box = videoTrack.getBoundingClientRect();
    return lo + Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * (hi - lo);
  };
  const step = [5, 10, 15, 30, 60, 120].find((s) => (hi - lo) / s <= 8) ?? 300;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    const tick = h("span", { textContent: clockText(t) });
    tick.style.left = `${pct(t)}%`;
    ruler.append(tick);
  }
  ghost.style.left = `${pct(original.start)}%`;
  ghost.style.width = `${pct(original.end) - pct(original.start)}%`;

  function flash(text: string) {
    limitNote.textContent = text;
    limitNote.classList.remove("is-flash");
    void limitNote.offsetWidth;
    limitNote.classList.add("is-flash");
  }

  function move(edge: Edge, value: number, preview = false) {
    value = snapFrame(value);
    if (edge === "start") {
      const min = Math.max(lo, range.end - info.max_duration);
      const max = range.end - info.min_duration;
      if (value < min) flash(value < lo ? "awal area edit" : `maks ${info.max_duration}s`);
      if (value > max) flash(`min ${info.min_duration}s`);
      range.start = snapFrame(Math.min(max, Math.max(min, value)));
    } else {
      const max = Math.min(hi, range.start + info.max_duration);
      const min = range.start + info.min_duration;
      if (value > max) flash(value > hi ? "akhir area edit" : `maks ${info.max_duration}s`);
      if (value < min) flash(`min ${info.min_duration}s`);
      range.end = snapFrame(Math.max(min, Math.min(max, value)));
    }
    renderRange();
    // Show the frame at the edge being moved, live.
    seek(edge === "start" ? range.start : Math.max(range.start, range.end - 0.1));
    if (preview && edge === "end") {
      seek(Math.max(range.start, range.end - 2));
      setPlaying(true);
    }
  }

  function renderRange() {
    const length = range.end - range.start;
    selection.style.left = `${pct(range.start)}%`;
    selection.style.width = `${pct(range.end) - pct(range.start)}%`;
    (selection.firstChild as HTMLElement).textContent = `${clockText(length)}`;
    outLeft.style.width = `${pct(range.start)}%`;
    outRight.style.left = `${pct(range.end)}%`;
    outRight.style.right = "0";
    handleStart.style.left = `${pct(range.start)}%`;
    handleEnd.style.left = `${pct(range.end)}%`;
    for (const [el, edge] of [[handleStart, "start"], [handleEnd, "end"]] as const) {
      el.setAttribute("aria-valuemin", String(lo));
      el.setAttribute("aria-valuemax", String(hi));
      el.setAttribute("aria-valuenow", String(range[edge]));
      el.setAttribute("aria-valuetext", tc(range[edge] - original.start));
    }
    lengthText.textContent = `${clockText(length)} / ${clockText(info.max_duration)}`;
    meter.textContent = `[${bar(length, info.max_duration)}]`;
    meter.classList.toggle("is-full", length >= info.max_duration - 0.05);
    renderSentences();
    refresh();
  }

  function drag(edge: Edge, el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      video.pause();
      dragging = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
      const onMove = (ev: PointerEvent) => move(edge, atPx(ev.clientX));
      const onUp = () => {
        dragging = false;
        el.classList.remove("is-dragging");
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    });
    el.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      move(edge, range[edge] + d * (e.shiftKey ? 5 : 1));
    });
  }
  drag("start", handleStart);
  drag("end", handleEnd);

  // Clicking or dragging anywhere else on the timeline scrubs the playhead.
  lanes.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ce-handle, .ce-block")) return;
    e.preventDefault();
    const wasPlaying = !video.paused;
    video.pause();
    dragging = true;
    lanes.setPointerCapture(e.pointerId);
    seek(atPx(e.clientX));
    const onMove = (ev: PointerEvent) => seek(atPx(ev.clientX));
    const onUp = () => {
      dragging = false;
      lanes.removeEventListener("pointermove", onMove);
      lanes.removeEventListener("pointerup", onUp);
      lanes.removeEventListener("pointercancel", onUp);
      if (wasPlaying) setPlaying(true);
    };
    lanes.addEventListener("pointermove", onMove);
    lanes.addEventListener("pointerup", onUp);
    lanes.addEventListener("pointercancel", onUp);
  });

  // ---------- source: rendered clip first, then the full live window ----------
  function useSource(next: Source) {
    const t = now();
    const playing = !video.paused;
    source = next;
    video.src = next.url;
    video.addEventListener(
      "loadedmetadata",
      () => {
        seek(covered(t) ? t : range.start);
        if (playing) setPlaying(true);
      },
      { once: true },
    );
  }
  function setStatus(state: "loading" | "live" | "failed", detail = "") {
    stage.classList.toggle("is-loading", state === "loading");
    loading.hidden = state !== "loading";
    retryPreview.hidden = state !== "failed";
    sourceNote.className = `ce-source is-${state}`;
    sourceNote.textContent =
      state === "live" ? "● preview live — perubahan langsung terlihat"
      : state === "loading" ? "◌ menyiapkan preview penuh… (klip lama diputar dulu)"
      : "preview penuh gagal · caption baru terlihat setelah render";
    sourceNote.title = detail;
  }
  function loadPreview() {
    setStatus("loading");
    fetch(`${base}/preview`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `status ${res.status}`);
        const data = (await res.json()) as { url: string; offset: number; from: number; to: number };
        if (!root.isConnected) return;
        useSource({ ...data, full: true });
        setStatus("live");
      })
      .catch((err) => {
        if (root.isConnected) setStatus("failed", (err as Error).message);
      });
  }
  retryPreview.addEventListener("click", loadPreview);
  if (source) useSource(source);
  loadPreview();

  // ---------- save ----------
  function fixes(): Fix[] {
    const out: Fix[] = [];
    for (const s of sentences) {
      const text = edits.get(s.key);
      if (text == null) continue;
      const next = tokens(text);
      if (!next.length) {
        s.words.forEach((w) => out.push({ start: w.start, end: w.end, text: "", orig: w.text, kind: "word" }));
      } else if (next.length === s.words.length) {
        s.words.forEach((w, i) => {
          if (next[i] !== w.text) out.push({ start: w.start, end: w.end, text: next[i], orig: w.text, kind: "word" });
        });
      } else {
        out.push({ start: s.start, end: s.end, text: next.join(" "), orig: s.words.map((w) => w.text).join(" "), kind: "line" });
      }
    }
    return out;
  }

  function refresh() {
    const ds = range.start - original.start;
    const de = range.end - original.end;
    const parts: string[] = [];
    if (Math.abs(ds) > 0.01) parts.push(`awal ${signed(ds)}`);
    if (Math.abs(de) > 0.01) parts.push(`akhir ${signed(de)}`);
    const edited = sentences.filter((s) => edits.has(s.key)).length;
    if (edited) parts.push(`${edited} kalimat diubah`);
    summary.textContent = parts.length ? `> perubahan: ${parts.join(" · ")}` : "> belum ada perubahan";
    save.disabled = !parts.length;
    reset.hidden = !parts.length;
    listCount.textContent = `${sentences.length} kalimat${edited ? ` · ${edited} diubah` : ""}`;
  }

  reset.addEventListener("click", () => {
    range.start = original.start;
    range.end = original.end;
    edits.clear();
    renderRange();
    seek(range.start);
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "menyimpan…";
    error.textContent = "";
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: range.start, end: range.end, fixes: fixes() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `status ${res.status}`);
      close();
      onSaved();
    } catch (err) {
      error.textContent = (err as Error).message;
      save.textContent = "simpan & render ulang";
      save.disabled = false;
    }
  });

  document.body.append(root);
  document.body.classList.add("locked");
  renderRange();
  paint(range.start);
  playBtn.focus();
}
