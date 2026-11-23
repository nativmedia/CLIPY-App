/**
 * Result views: the clip preview pop-up and the project editor page, where each finished
 * clip has three editable description options.
 */

import { openClipEditor } from "./clip-editor";
import { askDeleteProject, icon } from "./project-delete";

export type Clip = {
  n: number;
  title: string;
  reason?: string;
  status: string;
  error?: string;
  note?: string;
  video?: string;
  thumb?: string;
  srt?: string;
  start: number;
  end: number;
};

export type Project = {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  /** True when "gen more" can add clips from this project's saved transcript. */
  can_more?: boolean;
  notice?: string | null;
  transcript_origin?: string | null;
  transcript_note?: string | null;
  transcription_backend?: string | null;
  transcription_note?: string | null;
  settings: {
    mode?: string;
    film?: { episodes: number; max_duration: number; style: string; voice: string; source_ratio?: string; background?: string; additional_prompt?: string } | null;
    mood?: string;
    objective?: string;
    music_start?: number;
    music_length?: number | null;
    clip: { ratio: string; fit: string; count: number; max_duration: number; dubbing_speed?: number; clip_ratio?: string | null; background?: string | null; background_inset?: boolean };
    caption: { animation: string; font?: string | null; color: string; case: string; position?: number | null; display?: string | null; max_lines?: number };
    thumb: { source: string; title_style: string; text?: string; text_mode?: "auto" | "manual" | "none"; numbered?: boolean; sequence?: string | null; position?: string | null; voice: string | null };
    brand?: { position: string; text?: string; style?: string; opacity?: number };
  };
  has_logo?: boolean;
  has_export_dir?: boolean;
  export_ready?: boolean;
  export_status?: "pending" | "copying" | "done" | "error" | null;
  export_error?: string | null;
  music?: string | null;
  clips: Clip[];
};

export function clipLayout(settings: Project["settings"]): string {
  const film = settings.mode === "filming" ? settings.film : null;
  const crop = film?.source_ratio ?? settings.clip.clip_ratio;
  const background = film?.background ?? settings.clip.background;
  const ratio = settings.clip.ratio;
  if (background === "none") return `${ratio} · no background`;
  if (crop == null) return `${ratio} ${settings.clip.fit === "crop" ? "crop" : "no crop"}`;
  const color = background === "white" ? "putih" : background === "blur" ? "blur" : "hitam";
  if (crop === "auto" || crop === ratio) {
    const label = color === "hitam" && !settings.clip.background_inset ? "no background" : color;
    return `${ratio} · ${label}`;
  }
  return `${crop === "none" ? "no crop" : crop} · hasil ${ratio} · ${color}`;
}

const descriptionOptions = { pendek: "Opsi 1", sedang: "Opsi 2", panjang: "Opsi 3" } as const;
type DescriptionField = keyof typeof descriptionOptions;
type DashboardText = { title?: string; pendek: string; sedang: string; panjang: string };
type DashboardTexts = Record<string, DashboardText>;

/** Small DOM builder; text always goes in as text, never as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string | null | false | undefined)[]) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c): c is Node | string => !!c));
  return node;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Ask the server to make a failed clip again. */
export async function retryClip(projectId: string, n: number) {
  const res = await fetch(`/api/projects/${projectId}/clips/${n}/retry`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `status ${res.status}`);
}

// ---------- preview pop-up ----------

const modal = $<HTMLDivElement>("#preview-modal");
const modalVideo = $<HTMLVideoElement>("#modal-video");
const modalTitle = $<HTMLParagraphElement>("#modal-title");
const modalEdit = $<HTMLButtonElement>("#modal-edit");
const modalEditStatus = $<HTMLParagraphElement>("#modal-edit-status");
let preview: { project: Project; clip: Clip; request?: AbortController; error?: string } | null = null;

export function isProjectProcessing(project: Project): boolean {
  return !["done", "error", "cancelled"].includes(project.status) || project.export_status === "copying";
}

function hasClipEditor(project: Project, clip: Clip): boolean {
  return clip.status === "done" && !!clip.video && project.settings.mode !== "filming";
}

const clipEditTitle = "Perpanjang/potong clip dan perbaiki caption";

function clipEditBlock(project: Project): string {
  if (project.status === "cancelled") return "Pengeditan tidak tersedia karena proyek dihentikan.";
  return isProjectProcessing(project) ? "Tunggu proses proyek selesai untuk mengedit." : "";
}

function updatePreviewEdit(): void {
  if (!preview) return;
  const available = hasClipEditor(preview.project, preview.clip);
  const blocked = available ? clipEditBlock(preview.project) : "";
  const message = blocked || (available ? preview.error : "") || "";
  modalEdit.hidden = !available;
  modalEdit.disabled = !available || !!blocked || !!preview.request;
  modalEdit.textContent = preview.request ? "Membuka…" : "Edit";
  modalEdit.title = available ? blocked || clipEditTitle : "";
  modalEditStatus.hidden = !message;
  if (modalEditStatus.textContent !== message) modalEditStatus.textContent = message;
  modalEditStatus.classList.toggle("error", !!preview.error && !blocked);
}

/** Keep the Edit control current without interrupting video playback. */
export function updatePreviewProject(project: Project): void {
  const current = preview;
  if (!current || current.project.id !== project.id) return;
  const clip = project.clips.find((item) => item.n === current.clip.n);
  if (!clip?.video) {
    closePreview();
    return;
  }
  current.project = project;
  current.clip = clip;
  updatePreviewEdit();
}

export function openPreview(project: Project, clip: Clip) {
  if (!clip.video) return;
  preview?.request?.abort();
  preview = { project, clip };
  updatePreviewEdit();
  modalVideo.src = clip.video;
  modalVideo.poster = clip.thumb ?? "";
  modalVideo.style.aspectRatio = project.settings.clip.ratio.replace(":", " / ");
  modalTitle.textContent = clip.title;
  modal.hidden = false;
  document.body.classList.add("locked");
  modalVideo.play().catch(() => {});
  modal.querySelector<HTMLElement>(".modal-box")?.focus({ preventScroll: true });
}

function closePreview() {
  if (modal.hidden) return;
  preview?.request?.abort();
  preview = null;
  modalVideo.pause();
  modalVideo.removeAttribute("src");
  modalVideo.load();
  modal.hidden = true;
  if (editor.hidden && !document.querySelector(".modal:not([hidden]), .ce-modal")) document.body.classList.remove("locked");
}

$<HTMLButtonElement>("#modal-close").addEventListener("click", closePreview);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closePreview();
});
// Space plays/pauses the open preview instead of scrolling the page behind it.
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || modal.hidden) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("button, a[href], input, textarea, select, video, [contenteditable]")) return;
  e.preventDefault();
  if (modalVideo.paused) modalVideo.play().catch(() => {});
  else modalVideo.pause();
});
modalEdit.addEventListener("click", async () => {
  const current = preview;
  if (!current || modalEdit.disabled) return;
  const { project, clip } = current;
  const id = project.id;
  const request = new AbortController();
  current.request = request;
  current.error = undefined;
  updatePreviewEdit();
  modalVideo.pause();
  try {
    // After saving, the project page shows the re-render progress.
    await openClipEditor(id, clip.n, project.settings.clip.ratio, (pending) => {
      if (editing !== id) openEditor(id);
      else if (pending) followUntilDone(id);
      else void renderEditor(id);
    }, request.signal);
    if (preview === current) closePreview();
  } catch (err) {
    if (preview !== current) return;
    current.request = undefined;
    current.error = `Edit gagal: ${(err as Error).message}`;
    updatePreviewEdit();
  }
});

// ---------- editor page ----------

const editor = $<HTMLElement>("#editor");
const editorClips = $<HTMLOListElement>("#editor-clips");
const otherProjects = $<HTMLDivElement>("#editor-other-projects");
const editorIntro = document.querySelector<HTMLElement>("#editor-intro");
const editorPrimaryRow = document.querySelector<HTMLElement>("#editor-primary-row");
const editorHint = $<HTMLParagraphElement>("#editor-hint");
let editing = "";
const pendingSaves = new Map<string, number>();
const saveQueues = new Map<string, Promise<void>>();

export function openEditor(id: string) {
  location.hash = `#/project/${id}`;
}

function closeEditor() {
  if (location.hash.startsWith("#/project/")) history.pushState("", "", location.pathname + location.search);
  route();
}

$<HTMLButtonElement>("#editor-back").addEventListener("click", closeEditor);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!modal.hidden) closePreview();
  else if (!editor.hidden) closeEditor();
});

function queueSave(projectId: string, n: string, field: string, text: string, status: HTMLElement) {
  const key = `${projectId}:${n}:${field}`;
  status.textContent = "saving…";
  clearTimeout(pendingSaves.get(key));
  pendingSaves.set(key, window.setTimeout(() => {
    pendingSaves.delete(key);
    const next = (saveQueues.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/dashboard-text`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item: n, field, text }),
        });
        if (!res.ok) throw new Error(String(res.status));
        if (saveQueues.get(key) === next && !pendingSaves.has(key)) status.textContent = "saved";
      } catch {
        if (saveQueues.get(key) === next && !pendingSaves.has(key)) status.textContent = "couldn't save";
      }
    });
    saveQueues.set(key, next);
    void next.then(() => { if (saveQueues.get(key) === next) saveQueues.delete(key); });
  }, 700));
}

async function copy(text: string, button: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "copied";
  } catch {
    button.textContent = "copy failed";
  }
  setTimeout(() => (button.textContent = "copy"), 1400);
}

/** Three independently editable descriptions, shared by clips and sequence. */
function postsPanel(projectId: string, n: string, values: DashboardText): HTMLElement {
  const box = el("div", { className: "posts" });
  const tabs = el("div", { className: "tabs" });
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Pilihan deskripsi");
  const body = el("div", { className: "post-fields" });
  const status = el("span", { className: "save-status" });
  status.setAttribute("role", "status");
  const copyButton = el("button", { type: "button", className: "text-button", textContent: "copy" });
  let currentArea: HTMLTextAreaElement | null = null;
  copyButton.addEventListener("click", () => { if (currentArea) void copy(currentArea.value, copyButton); });
  const show = (field: DescriptionField) => {
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.field === field)));
    const area = el("textarea", {
      value: values[field] ?? "", maxLength: 600, spellcheck: true, rows: 2,
    });
    area.setAttribute("aria-label", `Deskripsi ${descriptionOptions[field]}`);
    const wrapper = el("div", { className: "post-field description-field" }, area);
    wrapper.dataset.value = area.value;
    currentArea = area;
    area.addEventListener("input", () => {
      wrapper.dataset.value = area.value;
      values[field] = area.value;
      queueSave(projectId, n, field, area.value, status);
    });
    body.replaceChildren(wrapper);
  };
  for (const field of ["pendek", "sedang", "panjang"] as const) {
    const b = el("button", { type: "button", textContent: descriptionOptions[field] });
    b.dataset.field = field;
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => show(field));
    tabs.append(b);
  }
  box.append(el("div", { className: "field-head posts-head" }, el("h4", { className: "posts-title", textContent: "Deskripsi" }), tabs, copyButton), body, status);
  show("pendek");
  return box;
}

function textPlaceholder(id: string): HTMLElement {
  const slot = el("div");
  slot.dataset.textId = id;
  slot.append(el("p", { className: "hint", textContent: "Menyiapkan deskripsi…" }));
  return slot;
}

function clipCard(p: Project, c: Clip): HTMLLIElement {
  const ratio = p.settings.clip.ratio.replace(":", " / ");
  const ratioValue = p.settings.clip.ratio.replace(":", "/");
  const previousVersion = !!c.video && !["done", "error", "cancelled"].includes(c.status);
  const renderNote = el("p", {
    className: "hint",
    role: "status",
    hidden: !previousVersion,
    textContent: "Render ulang berlangsung. Versi sebelumnya bisa diputar.",
  });
  const player = c.video ? el("video", {
    src: c.video, poster: c.thumb ?? "", controls: true, preload: c.thumb ? "none" : "metadata", playsInline: true,
  }) : null;
  let media: HTMLElement;
  if (player) {
    player.style.aspectRatio = ratio;
    media = player;
  } else {
    const empty = el("div", { className: "video-empty", textContent: c.status === "error" ? "failed" : c.status });
    empty.style.aspectRatio = ratio;
    media = empty;
  }

  const actions = el("div", { className: "clip-actions" });
  const playerFrame = player ? el("div", { className: "clip-player-frame" }, player) : null;
  if (c.status === "error" && p.status !== "cancelled") {
    const retry = el("button", { type: "button", className: "text-button warn", textContent: "retry" });
    const running = isProjectProcessing(p);
    retry.disabled = running;
    if (running) retry.textContent = "tunggu proses selesai";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.textContent = "retrying…";
      try {
        await retryClip(p.id, c.n);
        if (player) renderNote.hidden = false;
        followUntilDone(p.id);
      } catch (err) {
        retry.textContent = `retry failed: ${(err as Error).message}`;
        retry.disabled = false;
      }
    });
    actions.append(retry);
  }
  if (hasClipEditor(p, c)) {
    const edit = el("button", { type: "button", className: "text-button clip-edit", textContent: "edit" });
    const blocked = clipEditBlock(p);
    edit.disabled = !!blocked;
    edit.title = blocked || clipEditTitle;
    edit.addEventListener("click", async () => {
      edit.disabled = true;
      edit.textContent = "membuka…";
      try {
        await openClipEditor(p.id, c.n, p.settings.clip.ratio, (pending) => {
          if (pending) {
            edit.disabled = true;
            renderNote.hidden = false;
            followUntilDone(p.id);
          } else if (editing) {
            void renderEditor(editing);
          }
        });
        if (player && !player.paused) player.pause();
        edit.textContent = "edit";
      } catch (err) {
        edit.textContent = `edit gagal: ${(err as Error).message}`;
      } finally {
        edit.disabled = false;
      }
    });
    playerFrame?.append(edit);
  }


  media.style.setProperty("--ar", ratioValue);
  playerFrame?.style.setProperty("--ar", ratioValue);
  return el(
    "li",
    { className: "editor-clip" },
    el("div", { className: "clip-media" }, playerFrame ?? media),
    el(
      "div",
      { className: "clip-body" },
      el("p", { className: "kicker" }, el("span", { textContent: `clip ${String(c.n).padStart(2, "0")} · ${clock(c.start)}–${clock(c.end)}` })),
      el("h3", { textContent: c.title }),
      c.error ? el("p", {
        className: "hint error",
        textContent: c.video ? "Render ulang gagal. Versi sebelumnya masih bisa diputar." : c.error,
        title: c.error,
      }) : null,
      c.note ? el("p", { className: "hint", textContent: c.note }) : null,
      renderNote,
      actions,
      c.video ? textPlaceholder(String(c.n)) : null,
    ),
  );
}

function resultStatus(p: Project): HTMLElement {
  const stateName = isProjectProcessing(p) ? "processing" : p.status === "done" ? "complete" : p.status === "error" ? "failed" : "stopped";
  const labels = { processing: "Sedang memproses", complete: "Proses selesai", failed: "Proses gagal", stopped: "Proses dihentikan" };
  const icons = {
    processing: '<circle cx="10" cy="10" r="7"/>',
    complete: '<path d="m4 10 3.5 3.5L16 5"/>',
    failed: '<path d="m5 5 10 10m0-10L5 15"/>',
    stopped: '<rect x="5" y="5" width="10" height="10"/>',
  };
  const state = el("button", {
    type: "button",
    disabled: true,
    className: `result-state is-${stateName}`,
    title: labels[stateName],
    ariaLabel: labels[stateName],
  });
  state.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${icons[stateName]}</svg>`;
  return state;
}

function titleActions(p: Project): HTMLElement[] {
  const actions: HTMLElement[] = [resultStatus(p)];
  const busy = isProjectProcessing(p);
  const remove = el("button", { type: "button", className: "text-button outline-button is-danger project-delete" }, icon("trash"), "Hapus");
  remove.disabled = busy;
  remove.title = busy ? "Hentikan proses dulu sebelum menghapus" : "Hapus project ini";
  remove.addEventListener("click", async () => {
    if (await askDeleteProject(p)) closeEditor();
  });
  if (p.has_export_dir) {
    const open = el("button", { type: "button", className: "text-button result-open", textContent: "Buka" });
    open.disabled = !p.export_ready;
    open.title = p.export_ready ? "Buka folder hasil" : "Folder hasil disiapkan setelah proses selesai";
    open.addEventListener("click", async () => {
      open.disabled = true;
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}/output/open`, { method: "POST" });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `status ${res.status}`);
      } catch (err) {
        open.title = (err as Error).message;
      } finally {
        open.disabled = !p.export_ready;
      }
    });
    actions.push(open);
  }
  actions.push(remove);
  return actions;
}

async function loadDashboardTexts(id: string, scope: HTMLElement, routeId: string) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/dashboard-text`);
    const data: DashboardTexts & { detail?: string } = await response.json();
    if (!response.ok) throw new Error(data.detail ?? `status ${response.status}`);
    if (editing !== routeId || editor.hidden || !scope.isConnected) return;
    scope.querySelectorAll<HTMLElement>("[data-text-id]").forEach((slot) => {
      const textId = slot.dataset.textId!;
      if (data[textId] && slot.dataset.loaded !== "true") {
        if (textId === "sequence") {
          const input = slot.closest(".clip-body")?.querySelector<HTMLInputElement>("[data-sequence-title]");
          if (input && input.dataset.edited !== "true") {
            input.value = data[textId].title ?? "";
            input.dispatchEvent(new window.Event("sequence-title-ready"));
          }
        }
        slot.replaceChildren(postsPanel(id, textId, data[textId]));
        slot.dataset.loaded = "true";
      }
    });
  } catch (error) {
    if (editing !== routeId || editor.hidden || !scope.isConnected) return;
    scope.querySelectorAll<HTMLElement>("[data-text-id]:not([data-loaded])").forEach((slot) => {
      const retry = el("button", { type: "button", className: "text-button", textContent: "coba lagi" });
      retry.addEventListener("click", () => { retry.disabled = true; void loadDashboardTexts(id, scope, routeId); });
      slot.replaceChildren(el("p", { className: "hint error", textContent: `Deskripsi belum tersedia: ${(error as Error).message}` }), retry);
    });
  }
}

type SequenceState = { status: "idle" | "running" | "done" | "error"; progress: number; message: string };
type CoverState = { status: "idle" | "running" | "done" | "error"; progress: number; message: string; has_applied: boolean; title: string };
const sequenceActivators = new WeakMap<Element, () => void>();
const projectObservers = new Map<HTMLElement, IntersectionObserver>();
const rowObservers = new Map<HTMLOListElement, ResizeObserver>();

function scrollButtons(grid: HTMLOListElement, row: HTMLElement) {
  grid.tabIndex = 0;
  grid.setAttribute("aria-label", "Daftar video proyek, dapat digeser ke samping");
  const icon = (direction: "left" | "right") => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", direction === "left" ? "M14.5 4 6.5 12l8 8" : "m9.5 4 8 8-8 8");
    svg.append(path);
    return svg;
  };
  const left = el("button", { type: "button", className: "editor-scroll-button", title: "Geser video ke kiri" }, icon("left"));
  const right = el("button", { type: "button", className: "editor-scroll-button", title: "Geser video ke kanan" }, icon("right"));
  left.setAttribute("aria-label", "Geser video ke kiri");
  right.setAttribute("aria-label", "Geser video ke kanan");
  const update = () => {
    const max = Math.max(0, grid.scrollWidth - grid.clientWidth);
    row.classList.toggle("can-scroll-left", grid.scrollLeft > 1);
    row.classList.toggle("can-scroll-right", grid.scrollLeft < max - 1);
    left.disabled = grid.scrollLeft <= 1;
    right.disabled = grid.scrollLeft >= max - 1;
  };
  grid.onscroll = update;
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(update);
    rowObservers.set(grid, observer);
    observer.observe(grid);
  }
  window.setTimeout(update, 0);
  const clipStep = () => {
    const card = grid.querySelector<HTMLElement>(".editor-clip");
    const gap = Number.parseFloat(window.getComputedStyle(grid).columnGap) || 0;
    return (card?.getBoundingClientRect().width || grid.clientWidth) + gap;
  };
  left.addEventListener("click", () => grid.scrollBy({ left: -clipStep(), behavior: "smooth" }));
  right.addEventListener("click", () => grid.scrollBy({ left: clipStep(), behavior: "smooth" }));
  return el("div", { className: "editor-scroll-controls" }, left, right);
}

/** Each project's combined video stays inside its own project grid. */
function sequenceCard(p: Project, scope: HTMLElement, routeId: string): HTMLLIElement {
  const endpoint = `/api/projects/${encodeURIComponent(p.id)}/film-sequence`;
  const media = el("div", { className: "clip-media" });
  const placeholder = el("div", { className: "video-empty", textContent: "Memeriksa video gabungan…" });
  placeholder.style.aspectRatio = p.settings.clip.ratio.replace(":", " / ");
  media.append(placeholder);
  const body = el("div", { className: "clip-body" });
  const actions = el("div", { className: "clip-actions" });
  const note = el("p", { className: "hint" });
  note.setAttribute("role", "status");
  const button = el("button", { type: "button", className: "text-button", textContent: `Gabungkan Clip 1-${p.settings.film?.episodes ?? p.clips.length}` });
  const complete = p.status === "done" && p.clips.length === p.settings.film?.episodes && p.clips.every((c) => c.status === "done" && !!c.video);
  button.disabled = !complete;
  actions.append(button);
  body.append(el("p", { className: "kicker" }, el("span", { textContent: "video gabungan" })), actions, note);
  const card = el("li", { className: "editor-clip" }, media, body);
  let timer = 0;
  const show = (state: SequenceState) => {
    if (!card.isConnected || editing !== routeId) return;
    clearTimeout(timer);
    if (state.status === "done") {
      const video = el("video", { src: `${endpoint}/video`, controls: true, preload: "metadata", playsInline: true });
      video.style.aspectRatio = p.settings.clip.ratio.replace(":", " / ");
      media.replaceChildren(video);
      const title = el("input", { maxLength: 120, placeholder: "Judul thumbnail" });
      title.dataset.sequenceTitle = "";
      title.setAttribute("aria-label", "Judul video gabungan");
      const titleStatus = el("span", { className: "save-status" });
      titleStatus.setAttribute("role", "status");
      const titleCopy = el("button", { type: "button", className: "text-button", textContent: "copy" });
      titleCopy.addEventListener("click", () => { void copy(title.value, titleCopy); });
      const titleBox = el("div", { className: "post-field sequence-title" },
        el("div", { className: "field-head" }, el("span", { textContent: "judul" }), titleCopy), title, titleStatus);
      const download = el("a", { className: "text-button", href: `${endpoint}/download`, download: "", textContent: "download" });
      const apply = el("button", { type: "button", className: "text-button", textContent: "apply", disabled: true });
      apply.setAttribute("aria-label", "Terapkan judul sebagai thumbnail");
      const coverNote = el("p", { className: "hint sequence-cover-status" });
      coverNote.setAttribute("role", "status");
      const coverLink = el("a", { className: "text-button", href: `${endpoint}/cover/image`, download: "thumbnail-gabungan.jpg", textContent: "download thumbnail", hidden: true });
      actions.classList.add("sequence-actions");
      actions.replaceChildren(download, apply);
      body.insertBefore(titleBox, actions);
      body.insertBefore(coverNote, note);
      body.insertBefore(coverLink, note);
      note.textContent = "";
      let coverTimer = 0;
      let covering = false;
      title.addEventListener("sequence-title-ready", () => { apply.disabled = covering || !title.value.trim(); });
      title.addEventListener("input", () => {
        title.dataset.edited = "true";
        apply.disabled = covering || !title.value.trim();
        queueSave(p.id, "sequence", "title", title.value, titleStatus);
      });
      const showCover = (cover: CoverState) => {
        if (!card.isConnected || editing !== routeId) return;
        clearTimeout(coverTimer);
        covering = cover.status === "running";
        apply.disabled = covering || !title.value.trim();
        apply.textContent = covering ? "menerapkan…" : "apply";
        coverNote.classList.toggle("error", cover.status === "error");
        coverNote.textContent = covering ? `${cover.message || "Menerapkan thumbnail"} · ${Math.round(cover.progress * 100)}%`
          : cover.status === "error" ? cover.message : cover.has_applied ? `Thumbnail diterapkan: ${cover.title}` : "";
        coverLink.hidden = !cover.has_applied;
        if (cover.has_applied) {
          const imageUrl = `${endpoint}/cover/image?v=${Date.now()}`;
          video.poster = imageUrl;
          coverLink.href = imageUrl;
        }
        if (covering) coverTimer = window.setTimeout(checkCover, 1000);
      };
      const checkCover = async () => {
        if (!card.isConnected || editing !== routeId) return;
        try {
          const response = await fetch(`${endpoint}/cover`, { cache: "no-store" });
          if (!response.ok) throw new Error(`status ${response.status}`);
          showCover(await response.json());
        } catch {
          if (card.isConnected) { coverNote.textContent = "Status thumbnail tidak dapat diperiksa."; coverNote.classList.add("error"); }
        }
      };
      apply.addEventListener("click", async () => {
        if (!title.value.trim()) return;
        covering = true;
        apply.disabled = true;
        coverNote.textContent = "Menyiapkan thumbnail…";
        try {
          const response = await fetch(`${endpoint}/cover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.value }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.detail ?? `status ${response.status}`);
          showCover(data);
        } catch (error) {
          covering = false;
          apply.disabled = !title.value.trim();
          coverNote.textContent = (error as Error).message;
          coverNote.classList.add("error");
        }
      });
      void checkCover();
      if (!body.querySelector("[data-text-id]")) {
        body.append(textPlaceholder("sequence"));
        void loadDashboardTexts(p.id, scope, routeId);
      }
      return;
    }
    const running = state.status === "running";
    button.disabled = !complete || running;
    button.textContent = running ? "Menggabungkan…" : `Gabungkan Clip 1-${p.settings.film?.episodes ?? p.clips.length}`;
    placeholder.textContent = running ? `Menggabungkan · ${Math.round(state.progress * 100)}%` : "Video gabungan belum tersedia";
    note.textContent = state.status === "error" ? state.message : !complete ? "Selesaikan atau ulangi semua clip terlebih dahulu." : running ? state.message : "";
    note.classList.toggle("error", state.status === "error");
    if (running) timer = window.setTimeout(check, 1000);
  };
  const check = async () => {
    if (!card.isConnected || editing !== routeId) return;
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      show(await response.json());
    } catch {
      if (card.isConnected) { note.textContent = "Status gabungan tidak dapat diperiksa. Coba buka dashboard kembali."; note.classList.add("error"); }
    }
  };
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const state = await response.json();
      if (!response.ok) throw new Error(state.detail ?? `status ${response.status}`);
      show(state);
    } catch (error) {
      button.disabled = !complete;
      note.textContent = (error as Error).message;
      note.classList.add("error");
    }
  });
  sequenceActivators.set(card, () => { void check(); });
  if (scope === editorClips) window.setTimeout(check, 0);
  return card;
}

const follow = new Map<string, number>();
/** Follow every running project shown in the dashboard. */
function followUntilDone(id: string, routeId = editing) {
  if (!routeId || follow.has(id)) return;
  const timer = window.setTimeout(async () => {
    let project: Project | undefined;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (response.ok) project = await response.json();
    } catch { /* Try again while the dashboard is open. */ }
    if (follow.get(id) !== timer) return;
    follow.delete(id);
    if (editing !== routeId) return;
    if (project && !isProjectProcessing(project)) refreshDashboardProject(project, routeId);
    else followUntilDone(id, routeId);
  }, 2000);
  follow.set(id, timer);
}

export function openYoutubeInBrowser(control: HTMLElement, url: string, event?: MouseEvent): void {
  if (window.location.origin !== "http://127.0.0.1:4757") return;
  if (!event) {
    control.addEventListener("click", click => openYoutubeInBrowser(control, url, click));
    return;
  }
  event.preventDefault();
  void fetch("/api/source/open-youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then(response => {
    if (!response.ok) throw new Error("Browser default tidak dapat dibuka.");
  }).catch(error => { control.title = error.message; });
}

function youtubeLink(url: string, content: HTMLElement | string, label: string): HTMLElement | string {
  if (!url) return content;
  const link = el("a", { href: url, target: "_blank", rel: "noopener noreferrer", ariaLabel: label }, content);
  openYoutubeInBrowser(link, url);
  return link;
}

/** One project section, kept in the same order as the Project Result list. */
function dashboardProject(p: Project, routeId: string, selected: boolean): HTMLElement {
  const grid = el("ol", { className: "editor-clips" });
  const row = el("div", { className: "editor-row" }, grid);
  const done = p.clips.filter((c) => c.status === "done").length;
  // Desktop: one project fills the screen, its details on the left and its clips on the right.
  const section = el("section", { className: `editor-project${selected ? " is-target" : ""}` },
    el("aside", { className: "editor-aside" },
      el("div", { className: "editor-intro" },
        youtubeLink(p.url, el("img", { className: "editor-thumb", src: p.thumbnail, alt: "" }), "Buka video sumber di YouTube"),
        el("div", { className: "editor-intro-text" },
          el("div", { className: "editor-title-row" }, el("h2", {}, youtubeLink(p.url, p.title || p.url, p.title || "Buka video sumber di YouTube")),
            el("div", { className: "editor-title-actions" }, ...titleActions(p))),
          el("p", { className: "editor-meta", textContent: `${clipLayout(p.settings)} · ${done}/${p.clips.length} clips` }))),
      scrollButtons(grid, row)),
    el("div", { className: "editor-main" }, row));
  section.dataset.projectId = p.id;
  section.id = `project-dashboard-${p.id}`;

  const combined = p.settings.mode === "filming" ? sequenceCard(p, grid, routeId) : null;
  grid.replaceChildren(...p.clips.map((c) => clipCard(p, c)), ...(combined ? [combined] : []));
  if (isProjectProcessing(p)) followUntilDone(p.id, routeId);

  // Keep off-screen projects inexpensive, but the project the user opened is ready immediately.
  const load = () => {
    if (combined) sequenceActivators.get(combined)?.();
    if (p.clips.some((c) => c.video)) void loadDashboardTexts(p.id, grid, routeId);
  };
  const activate = () => {
    if (!section.isConnected || editing !== routeId) return;
    load();
  };
  // It is only connected after renderEditor appends it. Defer activation so the sequence card
  // can query its endpoint instead of deciding it is off-screen during construction.
  window.setTimeout(() => {
    if (selected || !("IntersectionObserver" in window)) {
      activate();
      return;
    }
    if (!section.isConnected || editing !== routeId) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        projectObservers.delete(section);
        activate();
      }
    }, { root: editor, rootMargin: "300px" });
    projectObservers.set(section, observer);
    observer.observe(section);
  }, 0);
  return section;
}

function refreshDashboardProject(project: Project, routeId: string) {
  const current = document.getElementById(`project-dashboard-${project.id}`);
  const currentGrid = current?.querySelector<HTMLOListElement>(".editor-clips");
  if (!current || !currentGrid) return;
  const next = dashboardProject(project, routeId, current.classList.contains("is-target"));
  const nextGrid = next.querySelector<HTMLOListElement>(".editor-clips")!;
  const focused = document.activeElement as HTMLElement | null;
  const descriptions = new Map([...currentGrid.querySelectorAll<HTMLElement>("[data-text-id]:not([data-text-id='sequence'])[data-loaded='true']")]
    .map((slot) => [slot.dataset.textId, slot]));
  nextGrid.querySelectorAll<HTMLElement>("[data-text-id]").forEach((slot) => {
    const loaded = descriptions.get(slot.dataset.textId);
    if (loaded) slot.replaceWith(loaded);
  });
  projectObservers.get(current)?.disconnect();
  projectObservers.delete(current);
  rowObservers.get(currentGrid)?.disconnect();
  rowObservers.delete(currentGrid);
  const scrollLeft = currentGrid.scrollLeft;
  current.replaceWith(next);
  nextGrid.scrollLeft = scrollLeft;
  if (focused && nextGrid.contains(focused)) focused.focus({ preventScroll: true });
}

function scrollToDashboardProject(section: HTMLElement, routeId: string) {
  const reveal = () => {
    if (editing !== routeId || editor.hidden || !section.isConnected || typeof section.scrollIntoView !== "function") return;
    section.scrollIntoView({ behavior: "auto", block: "start" });
  };
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(reveal);
  else window.setTimeout(reveal, 0);
}

async function renderEditor(id: string) {
  editing = id;
  editorHint.textContent = "";
  editorHint.classList.remove("error");
  const res = await fetch(`/api/projects/${id}`, { cache: "no-store" });
  if (editing !== id || editor.hidden) return;
  if (!res.ok) {
    editorClips.replaceChildren();
    otherProjects.replaceChildren();
    editorHint.textContent = "project not found";
    editorHint.classList.add("error");
    return;
  }
  const selected: Project = await res.json();

  projectObservers.forEach((observer) => observer.disconnect());
  projectObservers.clear();
  rowObservers.forEach((observer) => observer.disconnect());
  rowObservers.clear();
  editorIntro && (editorIntro.hidden = true);
  editorPrimaryRow && (editorPrimaryRow.hidden = true);
  editorClips.replaceChildren();
  otherProjects.replaceChildren();

  try {
    const listResponse = await fetch("/api/projects", { cache: "no-store" });
    if (!listResponse.ok) throw new Error("status " + listResponse.status);
    const listed: Project[] = await listResponse.json();
    if (editing !== id || editor.hidden) return;
    // The API already returns the same newest-first order as Project Result. Do not promote the selected project.
    const ordered = listed.some((project) => project.id === selected.id) ? listed : [selected, ...listed];
    let target: HTMLElement | null = null;
    for (const project of ordered) {
      if (!project.clips.length && project.id !== selected.id) continue;
      const section = dashboardProject(project, id, project.id === selected.id);
      otherProjects.append(section);
      if (project.id === selected.id) target = section;
    }
    if (target) scrollToDashboardProject(target, id);
  } catch {
    // The requested project remains usable if the surrounding list cannot be fetched.
    if (editing !== id || editor.hidden) return;
    const target = dashboardProject(selected, id, true);
    otherProjects.replaceChildren(target);
    scrollToDashboardProject(target, id);
    editorHint.textContent = "Proyek lain belum dapat ditampilkan.";
  }
}

/** #/project/<id> opens the editor; anything else closes it. */
function route() {
  for (const timer of follow.values()) window.clearTimeout(timer);
  follow.clear();
  const m = location.hash.match(/^#\/project\/([\w-]+)$/);
  if (m) {
    editor.hidden = false;
    document.body.classList.add("locked");
    editor.scrollTop = 0;
    renderEditor(m[1]);
  } else {
    editing = "";
    projectObservers.forEach((observer) => observer.disconnect());
    projectObservers.clear();
    rowObservers.forEach((observer) => observer.disconnect());
    rowObservers.clear();
    editor.hidden = true;
    editorClips.querySelectorAll("video").forEach((v) => v.pause());
    otherProjects.querySelectorAll("video").forEach((v) => v.pause());
    if (modal.hidden) document.body.classList.remove("locked");
  }
}

window.addEventListener("hashchange", route);
route();
