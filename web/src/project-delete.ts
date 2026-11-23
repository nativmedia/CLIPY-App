/**
 * Delete a project, asking first. With an export folder there are two ways:
 * remove only the project from CLIPY (the exported clips stay in the user's
 * folder), or remove the exported clips as well to free disk space.
 */

type Deletable = { id: string; title?: string; has_export_dir?: boolean };

const ICONS = {
  stop: '<rect x="5" y="5" width="10" height="10" fill="currentColor" stroke="none"/>',
  close: '<path d="m5 5 10 10m0-10L5 15"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6"/>',
};

/** A small inline SVG icon, drawn like the rest of the dashboard icons. */
export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return holder.firstElementChild as SVGSVGElement;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text) n.textContent = text;
  return n;
}

/** Resolves true once the project is deleted, false when the user backs out. */
export function askDeleteProject(project: Deletable): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = node("div", "modal delete-modal");
    const box = node("div", "modal-box delete-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Hapus project");
    const close = node("button", "modal-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "tutup");
    const kicker = node("p", "kicker");
    kicker.append(node("span", "", "hapus project"));
    const title = node("h3", "delete-title", project.title || "Project ini");
    const note = node("p", "delete-note", "Pilih yang mau dihapus. Langkah ini tidak bisa dibatalkan.");
    const options = node("div", "delete-options");
    const error = node("p", "delete-error");
    error.setAttribute("role", "alert");
    const cancel = node("button", "text-button", "batal");
    cancel.type = "button";
    const actions = node("div", "delete-actions");
    actions.append(cancel);

    const option = (heading: string, detail: string, files: boolean, danger = false) => {
      const b = node("button", `delete-option${danger ? " is-danger" : ""}`);
      b.type = "button";
      b.append(node("b", "", heading), node("span", "", detail));
      b.addEventListener("click", () => run(files));
      return b;
    };
    options.append(
      option(
        "Hapus project saja",
        project.has_export_dir
          ? "Project dan data kerjanya hilang dari CLIPY. Klip yang sudah tersimpan di folder kamu tetap aman."
          : "Project beserta video dan klipnya dihapus dari CLIPY.",
        false,
      ),
    );
    if (project.has_export_dir) {
      options.append(
        option(
          "Hapus project + file klipnya",
          "Folder hasil project ini di komputer kamu ikut dihapus, jadi ruang penyimpanan lega lagi.",
          true,
          true,
        ),
      );
    }
    box.append(close, kicker, title, note, options, error, actions);
    modal.append(box);

    const wasLocked = document.body.classList.contains("locked");
    const finish = (deleted: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      modal.remove();
      if (!wasLocked) document.body.classList.remove("locked");
      resolve(deleted);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      }
    };
    async function run(files: boolean) {
      const buttons = [...box.querySelectorAll<HTMLButtonElement>("button")];
      buttons.forEach((b) => (b.disabled = true));
      error.textContent = "";
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}${files ? "?files=true" : ""}`, { method: "DELETE" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(typeof body?.detail === "string" ? body.detail : `status ${res.status}`);
        }
        window.dispatchEvent(new CustomEvent("clipy:project-deleted", { detail: project.id }));
        finish(true);
      } catch (err) {
        error.textContent = (err as Error).message;
        buttons.forEach((b) => (b.disabled = false));
      }
    }
    close.addEventListener("click", () => finish(false));
    cancel.addEventListener("click", () => finish(false));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(modal);
    document.body.classList.add("locked");
    options.querySelector<HTMLButtonElement>("button")?.focus();
  });
}
