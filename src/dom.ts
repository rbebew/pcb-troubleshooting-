type Attrs = Record<string, unknown> & {
  class?: string;
  style?: string;
};

type Child = Node | string | number | null | undefined | false | Child[];

/** Lille hjælper til at bygge DOM uden innerHTML (så brugertekst aldrig tolkes som HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (k === "style") {
        el.setAttribute("style", String(v));
      } else if (k === "value" || k === "checked" || k === "selected" || k === "disabled") {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (k === "dataset" && typeof v === "object") {
        Object.assign(el.dataset, v);
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Mangler element: ${sel}`);
  return el as HTMLElement;
}

let toastTimer = 0;
export function toast(msg: string, kind: "info" | "error" = "info", ms = 3500): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), ms);
}

export function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short" });
}
