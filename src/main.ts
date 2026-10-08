import "./style.css";
import { describeApiError, detectWithClaude } from "./ai";
import { $, download, formatDate, h, toast } from "./dom";
import { Editor, type Tool } from "./editor";
import { nextDesignator } from "./geometry";
import { blobToDataUrl, canvasToBlob, loadAndResize, scaledCanvas } from "./image";
import { detectComponentsLocal } from "./localDetect";
import { Panel } from "./panel";
import * as store from "./store";
import { COMPONENT_TYPES, NET_PRESETS, STATUS_COLORS, uid, type PcbComponent, type Project } from "./types";

let settings = store.loadSettings();
let editor: Editor | null = null;
let panel: Panel | null = null;
let saveTimer = 0;

// ---------- Forside ----------

async function renderHome(): Promise<void> {
  const list = $("#project-list");
  const projects = await store.listProjects();
  if (!projects.length) {
    list.replaceChildren(h("li", { class: "empty" }, "Ingen projekter endnu. Tag et billede af et printkort for at komme i gang."));
    return;
  }
  const items = await Promise.all(
    projects.map(async (p) => {
      const blob = await store.getImage(p.id);
      const url = blob ? URL.createObjectURL(blob) : "";
      const faulty = p.components.filter((c) => c.status === "faulty").length;
      const suspect = p.components.filter((c) => c.status === "suspect").length;
      return h(
        "li",
        null,
        h(
          "button",
          { class: "project", onclick: () => openProject(p.id) },
          url ? h("img", { src: url, alt: "", loading: "lazy", onload: () => setTimeout(() => URL.revokeObjectURL(url), 1000) }) : h("div", { class: "thumb" }),
          h(
            "span",
            { class: "project-info" },
            h("b", null, p.name),
            h("span", { class: "muted small" }, formatDate(p.updated)),
            h(
              "span",
              { class: "small" },
              `${p.components.length} komponenter · ${p.traces.length} baner · ${p.probes.length} målinger`,
            ),
            faulty || suspect
              ? h(
                  "span",
                  { class: "small" },
                  faulty ? h("span", { class: "chip", style: `--c:${STATUS_COLORS.faulty}` }, `${faulty} defekt`) : null,
                  suspect ? h("span", { class: "chip", style: `--c:${STATUS_COLORS.suspect}` }, `${suspect} mistænkt`) : null,
                )
              : null,
          ),
        ),
      );
    }),
  );
  list.replaceChildren(...items);
}

async function newProjectFromFile(file: File): Promise<void> {
  try {
    toast("Indlæser billede …");
    const { blob, width, height } = await loadAndResize(file);
    const now = Date.now();
    const p: Project = {
      id: uid(),
      name: `Print ${new Date(now).toLocaleDateString("da-DK")} ${new Date(now).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}`,
      created: now,
      updated: now,
      width,
      height,
      components: [],
      nets: NET_PRESETS.filter((n) => n.name === "VIN" || n.name === "GND").map((n) => ({ id: uid(), ...n, visible: true })),
      traces: [],
      probes: [],
    };
    await store.createProject(p, blob);
    await openProject(p.id);
  } catch (err) {
    console.error(err);
    toast(`Kunne ikke indlæse billedet: ${err instanceof Error ? err.message : err}`, "error");
  }
}

async function importProject(file: File): Promise<void> {
  try {
    const data = JSON.parse(await file.text());
    if (data?.format !== "pcb-fejlsoegning" || !data.project || typeof data.image !== "string") {
      throw new Error("Filen er ikke et eksporteret projekt");
    }
    const blob = await (await fetch(data.image)).blob();
    const p = data.project as Project;
    p.id = uid();
    p.components ??= [];
    p.nets ??= [];
    p.traces ??= [];
    p.probes ??= [];
    await store.createProject(p, blob);
    toast(`Importerede "${p.name}"`);
    await renderHome();
  } catch (err) {
    toast(`Import fejlede: ${err instanceof Error ? err.message : err}`, "error");
  }
}

// ---------- Editor ----------

async function openProject(id: string): Promise<void> {
  const p = await store.getProject(id);
  const blob = await store.getImage(id);
  if (!p || !blob) {
    toast("Projektet kunne ikke åbnes", "error");
    return;
  }
  const image = await createImageBitmap(blob);
  closeEditor();
  $("#home").hidden = true;
  $("#editor").hidden = false;
  history.pushState({ project: id }, "", `#${id}`);

  const ed = new Editor($("#board") as HTMLCanvasElement, p, image);
  editor = ed;
  panel = new Panel($("#panel"), ed, { runAi: openAiDialog, runLocal: runLocalDetect });
  ($("#project-name") as HTMLInputElement).value = p.name;

  ed.onChange = () => {
    scheduleSave();
    panel?.render();
    updateChrome();
  };
  ed.onUi = () => {
    panel?.render();
    updateChrome();
  };
  ed.onNewComponent = (rect) => askComponentType(rect);
  let lastSel = "";
  const origUi = ed.onUi;
  ed.onUi = () => {
    origUi();
    const key = ed.selection ? `${ed.selection.kind}:${ed.selection.id}` : "";
    if (key && key !== lastSel && ed.tool === "select" && isNarrow()) setPanelOpen(true);
    lastSel = key;
  };
  panel.render();
  updateChrome();
  if (!p.components.length && !p.traces.length) {
    setTimeout(() => toast("Tryk ✨ Find komponenter for at lade AI finde komponenterne, eller tegn dem selv."), 400);
  }
}

function closeEditor(): void {
  if (editor) {
    flushSave();
    editor.destroy();
    editor.image.close();
  }
  editor = null;
  panel = null;
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}

function flushSave(): void {
  clearTimeout(saveTimer);
  if (editor) store.saveProject(editor.project).catch((e) => toast(`Kunne ikke gemme: ${e}`, "error"));
}

const HINTS: Record<Tool, string> = {
  select: "Tryk på en komponent, bane eller måling for at vælge den. Træk for at flytte. Knib for at zoome.",
  component: "Træk en ramme rundt om komponenten.",
  trace: "Tryk langs kobberbanen fra kilde mod last. Dobbelttryk eller “Færdig” afslutter.",
  probe: "Tryk hvor du har målt med multimeteret.",
};

function updateChrome(): void {
  const ed = editor;
  if (!ed) return;
  document.querySelectorAll<HTMLButtonElement>(".toolbar .tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === ed.tool));
  ($("#undo") as HTMLButtonElement).disabled = !ed.canUndo;
  ($("#redo") as HTMLButtonElement).disabled = !ed.canRedo;

  const bar = $("#trace-bar");
  bar.hidden = ed.tool !== "trace";
  if (ed.tool === "trace") {
    const sel = $("#active-net") as HTMLSelectElement;
    sel.replaceChildren(
      ...ed.project.nets.map((n) => h("option", { value: n.id, selected: n.id === ed.activeNetId }, `● ${n.name}`)),
      h("option", { value: "__new" }, "+ Nyt net …"),
    );
    const net = ed.activeNetId ? ed.net(ed.activeNetId) : undefined;
    sel.style.color = net?.color ?? "";
    ($("#trace-done") as HTMLButtonElement).disabled = !ed.draft || ed.draft.length < 2;
    ($("#trace-undo") as HTMLButtonElement).disabled = !ed.draft;
    ($("#trace-cancel") as HTMLButtonElement).disabled = !ed.draft;
  }
  let hint = HINTS[ed.tool];
  if (ed.tool === "trace" && !ed.activeNetId) hint = "Opret først et net (fx 5V) under Strømveje.";
  if (ed.tool === "trace" && ed.draft) hint = `${ed.draft.length} punkt${ed.draft.length === 1 ? "" : "er"} – fortsæt langs banen.`;
  $("#hint").textContent = hint;
}

function isNarrow(): boolean {
  return window.matchMedia("(max-width: 860px)").matches;
}

function setPanelOpen(open: boolean): void {
  $("#editor").classList.toggle("panel-open", open);
  $("#panel-toggle").classList.toggle("active", open);
}

function askComponentType(rect: { x: number; y: number; w: number; h: number }): void {
  const ed = editor;
  if (!ed) return;
  const dlg = $("#comp-dialog") as HTMLDialogElement;
  const grid = $("#type-grid");
  grid.replaceChildren(
    ...COMPONENT_TYPES.map((t) =>
      h(
        "button",
        {
          class: "type-btn",
          type: "button",
          onclick: () => {
            ed.checkpoint();
            const c: PcbComponent = {
              id: uid(),
              ...rect,
              designator: nextDesignator(t.prefix, ed.project.components),
              type: t.id,
              value: "",
              status: "unknown",
              notes: "",
              source: "manual",
            };
            ed.project.components.push(c);
            dlg.close();
            ed.setTool("select");
            ed.select({ kind: "component", id: c.id });
            ed.changed();
            if (isNarrow()) setPanelOpen(true);
          },
        },
        h("b", null, t.prefix),
        h("span", null, t.label),
      ),
    ),
  );
  dlg.showModal();
}

// ---------- Detektering ----------

function openAiDialog(): void {
  if (!editor) return;
  if (!settings.apiKey) {
    toast("Angiv din Anthropic API-nøgle først.");
    openSettings();
    return;
  }
  const dlg = $("#ai-dialog") as HTMLDialogElement;
  dlg.returnValue = "";
  dlg.showModal();
}

async function runAi(): Promise<void> {
  const ed = editor;
  if (!ed) return;
  const context = ($("#ai-context") as HTMLTextAreaElement).value;
  const replace = ($("#ai-replace") as HTMLInputElement).checked;
  const ctrl = new AbortController();
  const done = showBusy("Claude analyserer printet … det kan tage et minut.", () => ctrl.abort());
  try {
    const { components, ai } = await detectWithClaude(ed.image, settings, context, ctrl.signal);
    if (editor !== ed) return;
    ed.checkpoint();
    if (replace) ed.project.components = ed.project.components.filter((c) => c.source === "manual");
    ed.project.components.push(...components);
    ed.project.ai = ai;
    ed.selection = null;
    ed.changed();
    if (panel) {
      panel.tab = "overview";
      panel.render();
    }
    if (isNarrow()) setPanelOpen(true);
    const damaged = components.filter((c) => c.damage).length;
    toast(`Fandt ${components.length} komponenter${damaged ? ` – ${damaged} med synlige skader` : ""}.`);
  } catch (err) {
    if (ctrl.signal.aborted) toast("Analysen blev annulleret.");
    else {
      console.error(err);
      toast(describeApiError(err), "error", 8000);
    }
  } finally {
    done();
  }
}

function runLocalDetect(): void {
  const ed = editor;
  if (!ed) return;
  const small = scaledCanvas(ed.image, 640);
  const data = small.getContext("2d")!.getImageData(0, 0, small.width, small.height);
  const k = ed.image.width / small.width;
  const rects = detectComponentsLocal(data);
  ed.checkpoint();
  ed.project.components = ed.project.components.filter((c) => c.source !== "local");
  for (const r of rects) {
    ed.project.components.push({
      id: uid(),
      x: r.x * k,
      y: r.y * k,
      w: r.w * k,
      h: r.h * k,
      designator: "",
      type: "other",
      value: "",
      status: "unknown",
      notes: "",
      source: "local",
    });
  }
  ed.changed();
  toast(
    rects.length
      ? `Fandt ${rects.length} mulige komponenter. Tryk på dem for at angive type – eller brug AI for bedre resultat.`
      : "Fandt ingen tydelige komponenter. Prøv AI eller tegn dem selv.",
    "info",
    6000,
  );
}

function showBusy(text: string, onCancel: () => void): () => void {
  const el = $("#busy");
  $("#busy-text").textContent = text;
  el.hidden = false;
  const btn = $("#busy-cancel");
  const handler = () => onCancel();
  btn.addEventListener("click", handler);
  return () => {
    el.hidden = true;
    btn.removeEventListener("click", handler);
  };
}

// ---------- Indstillinger ----------

function openSettings(): void {
  const dlg = $("#settings-dialog") as HTMLDialogElement;
  ($("#api-key") as HTMLInputElement).value = settings.apiKey;
  const model = $("#model") as HTMLSelectElement;
  model.replaceChildren(...store.MODELS.map((m) => h("option", { value: m.id, selected: m.id === settings.model }, m.label)));
  ($("#effort") as HTMLSelectElement).value = settings.effort;
  dlg.returnValue = "";
  dlg.showModal();
}

$("#settings-dialog").addEventListener("close", () => {
  const dlg = $("#settings-dialog") as HTMLDialogElement;
  if (dlg.returnValue !== "save") return;
  settings = {
    apiKey: ($("#api-key") as HTMLInputElement).value.trim(),
    model: ($("#model") as HTMLSelectElement).value,
    effort: ($("#effort") as HTMLSelectElement).value as store.Settings["effort"],
  };
  store.saveSettings(settings);
  toast("Indstillinger gemt");
});

$("#ai-dialog").addEventListener("close", () => {
  if (($("#ai-dialog") as HTMLDialogElement).returnValue === "run") runAi();
});

// ---------- Eksport ----------

async function exportPng(): Promise<void> {
  if (!editor) return;
  const blob = await canvasToBlob(editor.renderFullRes(), "image/png");
  download(`${safeName(editor.project.name)}.png`, blob);
}

async function exportJson(): Promise<void> {
  if (!editor) return;
  flushSave();
  const blob = await store.getImage(editor.project.id);
  if (!blob) return;
  const payload = { format: "pcb-fejlsoegning", version: 1, project: editor.project, image: await blobToDataUrl(blob) };
  download(`${safeName(editor.project.name)}.json`, new Blob([JSON.stringify(payload)], { type: "application/json" }));
}

function safeName(s: string): string {
  return s.replace(/[^\wæøåÆØÅ-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "print";
}

// ---------- Hændelser ----------

function bindFileInput(sel: string, fn: (f: File) => void): void {
  const input = $(sel) as HTMLInputElement;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) fn(f);
  });
}

bindFileInput("#take-photo", newProjectFromFile);
bindFileInput("#pick-photo", newProjectFromFile);
bindFileInput("#import-project", importProject);
$("#open-settings").addEventListener("click", openSettings);

$("#back").addEventListener("click", () => {
  if (history.state?.project) history.back();
  else showHome();
});

function showHome(): void {
  closeEditor();
  setPanelOpen(false);
  $("#editor").hidden = true;
  $("#home").hidden = false;
  renderHome();
}

window.addEventListener("popstate", () => {
  const id = location.hash.slice(1);
  if (id && !editor) openProject(id);
  else if (!id) showHome();
});

$("#project-name").addEventListener("input", (e) => {
  if (!editor) return;
  editor.project.name = (e.target as HTMLInputElement).value;
  scheduleSave();
});

$("#undo").addEventListener("click", () => editor?.undo());
$("#redo").addEventListener("click", () => editor?.redo());
$("#ai-btn").addEventListener("click", openAiDialog);
$("#zoom-in").addEventListener("click", () => editor?.zoomBy(1.4));
$("#zoom-out").addEventListener("click", () => editor?.zoomBy(1 / 1.4));
$("#zoom-fit").addEventListener("click", () => editor?.fit());
$("#panel-toggle").addEventListener("click", () => setPanelOpen(!$("#editor").classList.contains("panel-open")));

document.querySelectorAll<HTMLButtonElement>(".toolbar .tool[data-tool]").forEach((b) =>
  b.addEventListener("click", () => {
    editor?.setTool(b.dataset.tool as Tool);
    if (isNarrow() && b.dataset.tool !== "select") setPanelOpen(false);
  }),
);

$("#trace-done").addEventListener("click", () => editor?.finishTrace());
$("#trace-cancel").addEventListener("click", () => editor?.cancelTrace());
$("#trace-undo").addEventListener("click", () => editor?.undoTracePoint());
$("#active-net").addEventListener("change", (e) => {
  const ed = editor;
  if (!ed) return;
  const v = (e.target as HTMLSelectElement).value;
  if (v === "__new") {
    const name = prompt("Navn på nyt net (fx 12V, 5V, VBAT):");
    if (name?.trim()) {
      ed.checkpoint();
      const used = ed.project.nets.length;
      const preset = NET_PRESETS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      const net = { id: uid(), name: name.trim(), color: preset?.color ?? ["#bf5af2", "#ff375f", "#32d74b", "#64d2ff"][used % 4], voltage: preset?.voltage ?? "", visible: true };
      ed.project.nets.push(net);
      ed.activeNetId = net.id;
      ed.changed();
    }
  } else {
    ed.activeNetId = v;
  }
  if (ed.focusNetId && ed.focusNetId !== ed.activeNetId) ed.focusNetId = null;
  ed.requestDraw();
  updateChrome();
});

const menuBtn = $("#menu-btn");
const menu = $("#menu");
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", () => {
  menu.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
});
menu.addEventListener("click", async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.action;
  const ed = editor;
  if (!action || !ed) return;
  switch (action) {
    case "local":
      runLocalDetect();
      break;
    case "labels":
      ed.showLabels = !ed.showLabels;
      ed.requestDraw();
      break;
    case "toggle-components":
      ed.showComponents = !ed.showComponents;
      ed.requestDraw();
      break;
    case "clear-ai": {
      const n = ed.project.components.filter((c) => c.source !== "manual").length;
      if (n && confirm(`Fjern ${n} automatisk fundne komponenter?`)) {
        ed.checkpoint();
        ed.project.components = ed.project.components.filter((c) => c.source === "manual");
        ed.selection = null;
        ed.changed();
      }
      break;
    }
    case "export-png":
      exportPng();
      break;
    case "export-json":
      exportJson();
      break;
    case "settings":
      openSettings();
      break;
    case "delete":
      if (confirm(`Slet projektet "${ed.project.name}"? Det kan ikke fortrydes.`)) {
        const id = ed.project.id;
        closeEditor();
        await store.deleteProject(id);
        history.replaceState(null, "", location.pathname);
        showHome();
      }
      break;
  }
});

document.addEventListener("keydown", (e) => {
  const ed = editor;
  if (!ed || $("#editor").hidden) return;
  if (document.querySelector("dialog[open]")) return;
  const t = e.target as HTMLElement;
  if (t.matches("input, textarea, select")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) ed.redo();
    else ed.undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    ed.redo();
  } else if (e.key === "Escape") {
    if (ed.draft) ed.cancelTrace();
    else if (ed.tool !== "select") ed.setTool("select");
    else ed.select(null);
  } else if (e.key === "Enter" && ed.draft) {
    ed.finishTrace();
  } else if (e.key === "Backspace" && ed.draft) {
    e.preventDefault();
    ed.undoTracePoint();
  } else if ((e.key === "Delete" || e.key === "Backspace") && ed.selection) {
    e.preventDefault();
    ed.deleteSelection();
  } else if (!mod && ["1", "2", "3", "4"].includes(e.key)) {
    ed.setTool((["select", "component", "trace", "probe"] as Tool[])[Number(e.key) - 1]);
  } else if (e.key === "f") {
    ed.fit();
  }
});

window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

// ---------- Start ----------

(async () => {
  const id = location.hash.slice(1);
  if (id && (await store.getProject(id))) {
    history.replaceState(null, "", location.pathname);
    await renderHome();
    await openProject(id);
  } else {
    await renderHome();
  }
})();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
