/**
 * A small Figma-style colour picker: a saturation/brightness square, a hue
 * slider, an eyedropper (where the browser has one) and a HEX field.
 * It opens as a popover next to the element that opened it.
 */

import "./color-picker.css";

type HSV = { h: number; s: number; v: number };

export const HEX_RE = /^#[0-9a-f]{6}$/i;

export function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: HSV): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Relative lightness, to pick dark or white letters on top of a colour. */
export function isLightColor(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) >= 0.4;
}

let open: { close: () => void } | null = null;

export type Swatch = { value: string; hex: string; label: string };

/**
 * `onChange` gets a hex for a picked colour, or a swatch's `value` when one of
 * the ready-made swatches is clicked.
 */
export function openColorPicker(anchor: HTMLElement, initial: string, onChange: (value: string) => void, swatches: Swatch[] = []): void {
  open?.close();
  let hsv = hexToHsv(HEX_RE.test(initial) ? initial : "#FFD60A");

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };
  const panel = make("div", "cp");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "pilih warna");
  const square = make("div", "cp-square");
  const squareKnob = make("span", "cp-knob");
  square.append(squareKnob);
  const hue = make("div", "cp-hue");
  const hueKnob = make("span", "cp-knob");
  hue.append(hueKnob);
  const row = make("div", "cp-row");
  const chip = make("span", "cp-chip");
  const hash = make("span", "cp-hash");
  hash.textContent = "#";
  const input = make("input", "cp-hex");
  input.maxLength = 6;
  input.spellcheck = false;
  input.setAttribute("aria-label", "kode warna HEX");
  const field = make("label", "cp-field");
  field.append(hash, input);
  row.append(chip, field);
  const EyeDropperApi = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (EyeDropperApi) {
    const pipette = make("button", "cp-pipette");
    pipette.type = "button";
    pipette.title = "ambil warna dari layar";
    pipette.setAttribute("aria-label", "ambil warna dari layar");
    pipette.addEventListener("click", async () => {
      try {
        const { sRGBHex } = await new EyeDropperApi().open();
        set(hexToHsv(sRGBHex.toUpperCase()), true);
      } catch {
        /* cancelled */
      }
    });
    row.prepend(pipette);
  }
  const presets = make("div", "cp-swatches");
  for (const swatch of swatches) {
    const b = make("button", "cp-swatch");
    b.type = "button";
    b.title = swatch.label;
    b.setAttribute("aria-label", swatch.label);
    b.style.background = swatch.hex;
    b.dataset.hex = swatch.hex.toUpperCase();
    b.addEventListener("click", () => {
      set(hexToHsv(swatch.hex), false);
      onChange(swatch.value);
    });
    presets.append(b);
  }
  panel.append(square, hue, row);
  if (swatches.length) panel.append(presets);

  function paint(fromInput = false) {
    const hex = hsvToHex(hsv);
    square.style.setProperty("--hue", `hsl(${hsv.h} 100% 50%)`);
    squareKnob.style.left = `${hsv.s * 100}%`;
    squareKnob.style.top = `${(1 - hsv.v) * 100}%`;
    squareKnob.style.background = hex;
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
    hueKnob.style.background = `hsl(${hsv.h} 100% 50%)`;
    chip.style.background = hex;
    presets.querySelectorAll<HTMLElement>(".cp-swatch").forEach((b) => b.classList.toggle("is-on", b.dataset.hex === hex));
    if (!fromInput) input.value = hex.slice(1);
  }
  function set(next: HSV, emit: boolean, fromInput = false) {
    hsv = next;
    paint(fromInput);
    if (emit) onChange(hsvToHex(hsv));
  }

  function drag(target: HTMLElement, apply: (x: number, y: number) => void) {
    target.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const box = target.getBoundingClientRect();
        apply(
          Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)),
          Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height)),
        );
      };
      move(e);
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
    });
  }
  drag(square, (x, y) => set({ h: hsv.h, s: x, v: 1 - y }, true));
  drag(hue, (x) => set({ h: Math.min(359.9, x * 360), s: hsv.s, v: hsv.v }, true));
  input.addEventListener("input", () => {
    const value = `#${input.value.trim().replace(/^#/, "")}`;
    if (HEX_RE.test(value)) set(hexToHsv(value.toUpperCase()), true, true);
  });
  input.addEventListener("blur", () => paint());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") close();
  });

  const onDown = (e: PointerEvent) => {
    if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  const place = () => {
    const box = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 240, height = panel.offsetHeight || 290;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width));
    const below = box.bottom + 8 + height <= window.innerHeight;
    panel.style.left = `${left}px`;
    panel.style.top = `${below ? box.bottom + 8 : Math.max(8, box.top - height - 8)}px`;
  };
  function close() {
    panel.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    open = null;
  }
  open = { close };

  document.body.append(panel);
  paint();
  place();
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  input.focus({ preventScroll: true });
  input.select();
}
