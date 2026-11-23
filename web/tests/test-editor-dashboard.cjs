const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { build } = require("esbuild");
const { JSDOM } = require("jsdom");
const Module = require("node:module");
const path = require("node:path");

test("Gen More preview keeps Edit visible and enables it when the project finishes", async () => {
  const markup = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost:4747/" });
  Object.assign(global, { window: dom.window, document: dom.window.document, location: dom.window.location,
                          history: dom.window.history, cancelAnimationFrame: () => {} });
  dom.window.HTMLMediaElement.prototype.play = async function () {};
  dom.window.HTMLMediaElement.prototype.pause = function () {};
  dom.window.HTMLMediaElement.prototype.load = function () {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const clip = { n: 4, title: "Klip tambahan", status: "done", video: "/four.mp4", start: 5, end: 20 };
  const project = { id: "more", status: "clipping", settings: { mode: "clipping", clip: { ratio: "9:16" } }, clips: [clip] };
  const endpoint = "/api/projects/more/clips/4/edit";
  const response = { ok: true, json: async () => ({ ...clip, intro: 0, min_duration: 5, max_duration: 30, window: [0, 30], duration: 30,
    words: [], caption: { font: "Poppins", accent: "#fff", case: "sentence", display: "sentence", animation: "focus", size: 42 } }) };
  const editRequests = [];
  let editResponse = response;
  global.fetch = async (url, options) => {
    if (url === `${endpoint}/preview`) return new Promise(() => {});
    assert.equal(url, endpoint);
    assert.equal(options?.method ?? "GET", "GET");
    editRequests.push(options);
    return editResponse;
  };

  try {
    const result = await build({ entryPoints: ["src/editor.ts"], bundle: true, write: false, platform: "node", format: "cjs", loader: { ".css": "empty" } });
    const compiled = new Module(path.join(__dirname, "editor-preview.cjs"), module);
    compiled._compile(result.outputFiles[0].text, compiled.id);
    const { openPreview, updatePreviewProject } = compiled.exports;
    const modal = document.querySelector("#preview-modal");

    openPreview(project, clip);
    assert.equal(modal.hidden, false);
    assert.doesNotMatch(modal.textContent, /open project/i);
    const edit = modal.querySelector(".modal-video-frame > #modal-edit.clip-edit");
    const status = modal.querySelector("#modal-edit-status[role='status']");
    assert.ok(edit);
    assert.ok(status);
    assert.equal(edit.hidden, false);
    assert.match(edit.textContent, /^edit$/i);
    assert.equal(edit.disabled, true);
    assert.match(status.textContent, /selesai/i);
    edit.click();
    assert.equal(editRequests.length, 0);

    updatePreviewProject({ ...project, id: "different", status: "done" });
    assert.equal(edit.disabled, true);
    const finished = { ...project, status: "done" };
    updatePreviewProject(finished);
    assert.equal(edit.disabled, false);
    assert.equal(modal.hidden, false);
    assert.equal(modal.querySelector("video").getAttribute("src"), "/four.mp4");
    edit.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(editRequests.length, 1);
    assert.ok(document.querySelector(".ce-modal"));
    assert.equal(modal.hidden, true);
    assert.equal(dom.window.location.hash, "");
    document.querySelector(".ce-modal").click();

    let finishRequest;
    editResponse = new Promise((resolve) => { finishRequest = resolve; });
    openPreview(finished, clip);
    edit.click();
    assert.equal(editRequests.length, 2);
    modal.querySelector("#modal-close").click();
    assert.equal(editRequests[1].signal.aborted, true);
    finishRequest(response);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.querySelector(".ce-modal"), null);

    openPreview({ ...finished, settings: { ...finished.settings, mode: "filming" } }, clip);
    assert.equal(edit.hidden, true);
    assert.doesNotMatch(modal.textContent, /open project/i);
    openPreview({ ...finished, status: "cancelled" }, clip);
    assert.ok(edit.hidden || edit.disabled);
  } finally {
    dom.window.close();
  }
});

test("dashboard displays clip descriptions and the combined video for one project", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="preview-modal" hidden></div><video id="modal-video"></video><p id="modal-title"></p>
    <a id="modal-download"></a><button id="modal-edit"></button><button id="modal-close"></button>
    <section id="editor" hidden><button id="editor-back"></button><img id="editor-thumb">
    <h2 id="editor-title"></h2><p id="editor-meta"></p><p id="editor-hint"></p><div id="editor-scroll-controls"></div>
    <div id="editor-primary-row" class="editor-row"><ol id="editor-clips"></ol></div><div id="editor-other-projects"></div></section>
    </body>`, { url: "http://localhost:4747/#/project/test" });
  Object.assign(global, { window: dom.window, document: dom.window.document, location: dom.window.location,
                          history: dom.window.history });
  dom.window.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = "true"; };
  const project = { id: "test", title: "Film", url: "", thumbnail: "", status: "done",
    settings: { mode: "filming", film: { episodes: 2 }, clip: { ratio: "9:16", fit: "crop" } },
    clips: [{ n: 1, title: "Klip satu", status: "done", video: "/1.mp4", start: 0, end: 1 },
            { n: 2, title: "Klip dua", status: "done", video: "/2.mp4", start: 1, end: 2 }] };
  const descriptions = { pendek: "Pendek", sedang: "Sedang", panjang: "Panjang" };
  const other = { id: "other", title: "Proyek lain", url: "", thumbnail: "", status: "done",
    settings: { mode: "filming", film: { episodes: 1 }, clip: { ratio: "9:16", fit: "crop" } },
    clips: [{ n: 1, title: "Hasil proyek lain", status: "done", video: "/other.mp4", start: 0, end: 1 }] };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push([url, options]);
    let data;
    if (url.endsWith("/dashboard-text")) data = { "1": { ...descriptions }, "2": { ...descriptions }, sequence: { ...descriptions, title: "Judul utuh" } };
    else if (url.endsWith("/film-sequence/cover")) data = options?.method === "POST"
      ? { status: "done", progress: 1, message: "Siap", has_applied: true, title: "Judul pilihan" }
      : { status: "idle", progress: 0, message: "", has_applied: false, title: "" };
    else if (url.endsWith("/film-sequence")) data = { status: "done", progress: 1, message: "Siap" };
    else if (url === "/api/projects") data = [project, other];
    else data = url.endsWith("/other") ? other : project;
    return { ok: true, json: async () => data };
  };
  const result = await build({ entryPoints: ["src/editor.ts"], bundle: true, write: false, platform: "node", format: "cjs", loader: { ".css": "empty" } });
  const compiled = new Module(path.join(process.cwd(), "tests", "editor-bundle.cjs"), module);
  compiled.filename = path.join(process.cwd(), "tests", "editor-bundle.cjs");
  compiled.paths = Module._nodeModulePaths(process.cwd());
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sections = [...document.querySelectorAll("#editor-other-projects .editor-project")];
  assert.equal(sections.length, 2);
  assert.match(sections[0].querySelector("h2").textContent, /Film/);
  assert.match(sections[1].querySelector("h2").textContent, /Proyek lain/);
  assert.equal(sections[0].dataset.scrolled, "true");
  const cards = [...sections[0].querySelectorAll(".editor-clip")];
  assert.equal(cards.length, 3);
  assert.equal(sections[1].querySelectorAll(".editor-clip").length, 2);
  const grid = sections[0].querySelector(".editor-clips");
  Object.defineProperty(grid, "clientWidth", { value: 400 });
  Object.defineProperty(grid, "scrollWidth", { value: 1000 });
  cards[0].getBoundingClientRect = () => ({ width: 320 });
  grid.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(sections[0].querySelector(".editor-row").classList.contains("can-scroll-right"), true);
  let distance = 0;
  grid.scrollBy = (options) => { distance = options.left; };
  sections[0].querySelector('[aria-label="Geser video ke kanan"]').click();
  assert.equal(distance, 320);
  grid.scrollLeft = 100;
  grid.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(sections[0].querySelector(".editor-row").classList.contains("can-scroll-left"), true);
  assert.equal(cards[2].querySelector("video").getAttribute("src"), "/api/projects/test/film-sequence/video");
  assert.equal(cards[2].querySelector("a[download]").getAttribute("href"), "/api/projects/test/film-sequence/download");
  assert.equal(cards[2].querySelector('input[aria-label="Judul video gabungan"]').value, "Judul utuh");
  assert.doesNotMatch(cards[2].textContent, /Gabungan clip/);
  const titleInput = cards[2].querySelector('input[aria-label="Judul video gabungan"]');
  const apply = cards[2].querySelector('button[aria-label="Terapkan judul sebagai thumbnail"]');
  const download = cards[2].querySelector('a[download]');
  assert.equal(download.textContent, "download");
  assert.ok(titleInput.compareDocumentPosition(download) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(download.compareDocumentPosition(apply) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  titleInput.value = "Judul pilihan";
  titleInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  apply.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const coverCall = calls.find(([url, options]) => url === "/api/projects/test/film-sequence/cover" && options?.method === "POST");
  assert.equal(JSON.parse(coverCall[1].body).title, "Judul pilihan");
  assert.match(cards[2].querySelector("video").poster, /film-sequence\/cover\/image/);
  assert.equal(cards[2].querySelector('a[download="thumbnail-gabungan.jpg"]').hidden, false);
  assert.deepEqual([...cards[0].querySelectorAll('[role="tab"]')].map((b) => b.textContent), ["Opsi 1", "Opsi 2", "Opsi 3"]);
  const panel = cards[0].querySelector(".posts");
  assert.equal(panel.querySelector("h4").textContent, "Deskripsi");
  assert.ok(panel.querySelector('[role="tablist"]'));
  assert.equal(cards[0].querySelector("textarea").value, "Pendek");
  assert.equal(cards[0].querySelector("textarea").maxLength, 600);
  assert.equal(panel.querySelector(".description-field").dataset.value, "Pendek");
  cards[0].querySelector('[data-field="sedang"]').click();
  assert.equal(cards[0].querySelector("textarea").value, "Sedang");
  assert.equal(panel.querySelector(".description-field").dataset.value, "Sedang");
  assert.equal(cards[0].querySelector(".count"), null);
  assert.ok(calls.some(([url]) => url.endsWith("/dashboard-text")));
  const otherDescription = sections[1].querySelector("textarea");
  otherDescription.value = "Edit untuk proyek lain\n\nParagraf kedua.";
  otherDescription.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(otherDescription.parentElement.dataset.value, otherDescription.value);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const saveCall = calls.find(([url, options]) => url === "/api/projects/other/dashboard-text" && options?.method === "PUT");
  assert.ok(saveCall, "edit harus disimpan ke proyek yang benar");
  assert.equal(JSON.parse(saveCall[1].body).text, "Edit untuk proyek lain\n\nParagraf kedua.");
  dom.window.location.hash = "#/project/other";
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rerendered = [...document.querySelectorAll("#editor-other-projects .editor-project")];
  assert.match(rerendered[0].querySelector("h2").textContent, /Film/);
  assert.match(rerendered[1].querySelector("h2").textContent, /Proyek lain/);
  assert.equal(rerendered[1].dataset.scrolled, "true");
  const otherCards = [...rerendered[1].querySelectorAll(".editor-clip")];
  assert.equal(otherCards.length, 2);
  assert.match(otherCards[0].textContent, /Hasil proyek lain/);
  assert.match(rerendered[0].textContent, /Klip satu/);
  dom.window.close();
});

test("combined video can download or apply an edited title before generated text loads", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="preview-modal" hidden></div><video id="modal-video"></video>
    <p id="modal-title"></p><a id="modal-download"></a><button id="modal-edit"></button><button id="modal-close"></button>
    <section id="editor" hidden><button id="editor-back"></button><img id="editor-thumb"><h2 id="editor-title"></h2>
    <p id="editor-meta"></p><p id="editor-hint"></p><div id="editor-scroll-controls"></div>
    <div id="editor-primary-row"><ol id="editor-clips"></ol></div><div id="editor-other-projects"></div></section></body>`,
    { url: "http://localhost:4747/#/project/delayed" });
  Object.assign(global, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history });
  const project = { id: "delayed", title: "Film", url: "", thumbnail: "", status: "done",
    settings: { mode: "filming", film: { episodes: 1 }, clip: { ratio: "9:16", fit: "crop" } },
    clips: [{ n: 1, title: "Bagian", status: "done", video: "/1.mp4", start: 0, end: 1 }] };
  let resolveText;
  const delayed = new Promise((resolve) => { resolveText = resolve; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith("/dashboard-text") && options?.method !== "PUT") return delayed;
    let data = project;
    if (url === "/api/projects") data = [project];
    else if (url.endsWith("/film-sequence")) data = { status: "done", progress: 1 };
    else if (url.endsWith("/cover")) data = options?.method === "POST"
      ? { status: "done", has_applied: true, title: "Judul saya", progress: 1 }
      : { status: "idle", has_applied: false, progress: 0 };
    return { ok: true, json: async () => data };
  };
  const result = await build({ entryPoints: ["src/editor.ts"], bundle: true, write: false, platform: "node", format: "cjs", loader: { ".css": "empty" } });
  const compiled = new Module(path.join(process.cwd(), "tests", "editor-delayed.cjs"), module);
  compiled.filename = path.join(process.cwd(), "tests", "editor-delayed.cjs");
  compiled.paths = Module._nodeModulePaths(process.cwd());
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const card = [...document.querySelectorAll("#editor-other-projects .editor-clip")][1];
  assert.equal(card.querySelector('a[download]').textContent, "download");
  const input = card.querySelector('input[aria-label="Judul video gabungan"]');
  input.value = "Judul saya";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  card.querySelector('button[aria-label="Terapkan judul sebagai thumbnail"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(calls.find(([url, opts]) => url.endsWith("/cover") && opts?.method === "POST")[1].body).title, "Judul saya");
  const generated = { pendek: "p", sedang: "s", panjang: "l", title: "Judul otomatis" };
  resolveText({ ok: true, json: async () => ({ "1": generated, sequence: generated }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(input.value, "Judul saya");
  dom.window.close();
});

test("clip edit keeps the published video during pending and failed renders, then loads the new version", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="preview-modal" hidden></div><video id="modal-video"></video><p id="modal-title"></p>
    <button id="modal-edit"></button><button id="modal-close"></button>
    <section id="editor" hidden><button id="editor-back"></button><p id="editor-hint"></p>
    <ol id="editor-clips"></ol><div id="editor-other-projects"></div></section>
    </body>`, { url: "http://localhost:4747/#/project/edit" });
  Object.assign(global, { window: dom.window, document: dom.window.document, location: dom.window.location,
                          history: dom.window.history, cancelAnimationFrame: () => {} });
  dom.window.HTMLMediaElement.prototype.pause = function () {};
  dom.window.HTMLMediaElement.prototype.load = function () {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const originalTimer = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (handler, delay) => originalTimer(handler, delay === 2000 ? 10 : delay);
  const original = { n: 1, title: "Klip", status: "done", video: "/first.mp4", thumb: "/first.jpg", start: 5, end: 20 };
  const project = { id: "edit", title: "Project", url: "", thumbnail: "", status: "done",
    settings: { mode: "clipping", clip: { ratio: "9:16", fit: "crop" } }, clips: [original] };
  const other = { ...project, id: "more", title: "Proyek lain", status: "clipping", clips: [original] };
  const descriptions = { "1": { pendek: "Opsi lama", sedang: "Sudut lain", panjang: "Opsi lain" } };
  const calls = [];
  let noOp = true;
  let finishSave;
  const saveResponse = new Promise((resolve) => { finishSave = resolve; });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 60; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Dashboard did not reach the expected state");
  };
  global.fetch = async (url, opts) => {
    calls.push([url, opts]);
    if (url.endsWith("/preview")) return new Promise(() => {});
    if (url.endsWith("/clips/1/edit") && opts?.method === "POST") {
      if (noOp) return { ok: true, json: async () => project };
      project.status = "clipping";
      project.clips = [{ ...original, status: "pending" }];
      await saveResponse;
    }
    if (url.endsWith("/retry")) {
      project.status = "clipping";
      project.clips = [{ ...original, status: "pending" }];
    }
    const data = url.endsWith("/clips/1/edit") && !opts?.method
      ? { ...original, intro: 0, min_duration: 5, max_duration: 30, window: [0, 30], duration: 30, words: [],
          caption: { font: "Poppins", accent_font: "Poppins", accent: "#fff", case: "sentence", display: "sentence", animation: "focus", size: 42 } }
      : url === "/api/projects" ? [project, other] : url.endsWith("/dashboard-text") ? descriptions
        : url === "/api/projects/more" ? other : project;
    return { ok: true, json: async () => data };
  };
  try {
    const result = await build({ entryPoints: ["src/editor.ts"], bundle: true, write: false, platform: "node", format: "cjs", loader: { ".css": "empty" } });
    const compiled = new Module(path.join(process.cwd(), "tests", "editor-edit.cjs"), module);
    compiled._compile(result.outputFiles[0].text, compiled.id);
    const card = () => document.querySelector("#project-dashboard-edit .editor-clip");
    const otherSection = () => document.querySelector("#project-dashboard-more");
    await waitFor(() => !!card()?.querySelector(".clip-edit"));
    await waitFor(() => !!otherSection()?.querySelector("textarea"));
    const selectedCard = card();
    otherSection().querySelector('[data-field="sedang"]').click();
    const description = otherSection().querySelector("textarea");
    description.focus();
    assert.equal(otherSection().querySelector(".clip-edit").disabled, true);
    other.status = "done";
    other.clips = [original, { ...original, n: 2, title: "Klip tambahan", video: "/new.mp4" }];
    await waitFor(() => otherSection().querySelectorAll(".editor-clip").length === 2);
    assert.equal(otherSection().querySelector(".clip-edit").disabled, false);
    assert.equal(otherSection().querySelector("textarea"), description);
    assert.equal(description.value, "Sudut lain");
    assert.equal(document.activeElement, description);
    assert.equal(card(), selectedCard);

    card().querySelector(".clip-edit").click();
    await waitFor(() => !!document.querySelector(".ce-video"));
    document.querySelector(".ce-video").dispatchEvent(new dom.window.Event("error"));
    assert.equal(calls.filter(([url]) => url.endsWith("/preview")).length, 1);
    document.querySelector('[title="selesai 1f lebih lama"]').click();
    document.querySelector(".ce-save").click();
    await waitFor(() => !document.querySelector(".ce-modal"));
    assert.equal(card().querySelector('[role="status"]').hidden, true);
    assert.equal(card().querySelector(".clip-edit").disabled, false);

    noOp = false;
    card().querySelector(".clip-edit").click();
    await waitFor(() => !!document.querySelector(".ce-video"));
    document.querySelector('[title="selesai 1f lebih lama"]').click();
    const save = document.querySelector(".ce-save");
    save.click();
    document.querySelector('[title="selesai 1f lebih lama"]').click();
    assert.equal(save.disabled, true);
    finishSave();
    await waitFor(() => !document.querySelector(".ce-modal"));
    assert.match(card().querySelector('[role="status"]').textContent, /Render ulang berlangsung/);
    assert.equal(card().querySelector("video").getAttribute("src"), "/first.mp4");

    project.status = "error";
    project.clips = [{ ...original, status: "error", error: "Render failed" }];
    await waitFor(() => !!card().querySelector(".hint.error"));
    assert.match(card().querySelector(".hint.error").textContent, /Versi sebelumnya masih bisa diputar/);
    assert.equal(card().querySelector("video").getAttribute("src"), "/first.mp4");
    card().querySelector(".warn").click();
    await waitFor(() => calls.some(([url]) => url.endsWith("/retry")));
    project.status = "done";
    project.clips = [{ ...original, video: "/second.mp4" }];
    await waitFor(() => card().querySelector("video").getAttribute("src") === "/second.mp4");
    assert.ok(calls.some(([url, opts]) => url === "/api/projects/edit" && opts?.cache === "no-store"));
  } finally {
    dom.window.close();
  }
});
