import "./style.css";
import { describeApiError, detectWithClaude } from "./ai";
import { $, download, formatDate, h, toast } from "./dom";
import { Editor, type Tool } from "./editor";
import { nextDesignator } from "./geometry";
import { blobToDataUrl, canvasToBlob, loadAndResize, rotateBlob90, scaledCanvas } from "./image";
import { detectComponentsLocal } from "./localDetect";
import { Panel } from "./panel";
import * as store from "./store";
import type { SyncEvent } from "./sync";
import { COMPONENT_TYPES, NET_PRESETS, STATUS_COLORS, uid, type DetailPhoto, type PcbComponent, type Project, type Rect } from "./types";

let settings = store.loadSettings();
let editor: Editor | null = null;
let panel: Panel | null = null;
let saveTimer = 0;

/** Indlæste billeder for det åbne projekt. Nøgle "" = oversigtsbilledet, ellers nærbilledets id. */
const bitmaps = new Map<string, ImageBitmap>();
/** Nærbillede der er ved at blive placeret på oversigten. */
let placement: { photoId: string | null; blob: Blob; width: number; height: number; rotated: boolean } | null = null;

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
      const photos = p.photos?.length ?? 0;
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
              photos ? ` · ${photos} ${photos === 1 ? "nærbillede" : "nærbilleder"}` : "",
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
      photos: [],
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
    const photoData: Record<string, string> = data.photos ?? {};
    p.photos = (p.photos ?? []).filter((ph) => typeof photoData[ph.id] === "string");
    for (const ph of p.photos) await store.putPhotoImage(p.id, ph.id, await (await fetch(photoData[ph.id])).blob());
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
  if (location.hash !== `#${id}`) history.pushState({ project: id }, "", `#${id}`);
  p.photos ??= [];
  bitmaps.set("", image);

  const ed = new Editor($("#board") as HTMLCanvasElement, p, image);
  editor = ed;
  panel = new Panel($("#panel"), ed, { runAi: openAiDialog, runLocal: runLocalDetect });
  ($("#project-name") as HTMLInputElement).value = p.name;

  let lastSel = "";
  ed.onChange = () => {
    scheduleSave();
    panel?.render();
    updateChrome();
  };
  ed.onUi = () => {
    panel?.render();
    updateChrome();
    const key = ed.selection ? `${ed.selection.kind}:${ed.selection.id}` : "";
    if (key && key !== lastSel && ed.tool === "select" && isNarrow()) setPanelOpen(true);
    lastSel = key;
  };
  ed.onNewComponent = (rect) => askComponentType(rect);
  panel.render();
  updateChrome();
  renderPhotoStrip();
  refreshAvailablePhotos();
  if (!p.components.length && !p.traces.length) {
    setTimeout(() => toast("Tryk ✨ Find komponenter for at lade AI finde komponenterne, eller tegn dem selv."), 400);
  }
}

/** `save = false` når projektet er slettet – ellers ville det blive gemt (og genskabt) igen. */
function closeEditor(save = true): void {
  if (editor) {
    if (save) flushSave();
    else clearTimeout(saveTimer);
    editor.destroy();
  }
  for (const b of bitmaps.values()) b.close();
  bitmaps.clear();
  placement = null;
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

  $("#place-bar").hidden = !ed.placing;
  const bar = $("#trace-bar");
  bar.hidden = ed.tool !== "trace" || !!ed.placing;
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
  if (ed.placing) hint = "Læg nærbilledet over det sted på printet, det viser. Træk for at flytte, træk i hjørnerne for at ændre størrelse.";
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

// ---------- Nærbilleder ----------

function renderPhotoStrip(): void {
  const ed = editor;
  const strip = $("#photo-strip");
  if (!ed) return;
  const photos = ed.project.photos ?? [];
  const current = ed.photo?.id ?? "";
  const chip = (id: string, label: string, missing = false) =>
    h(
      "button",
      {
        class: `photo-chip ${current === id ? "active" : ""}`,
        disabled: missing || !!ed.placing,
        title: missing ? "Billedet hentes fra den anden enhed …" : label,
        onclick: () => showPhoto(id || null),
      },
      missing ? `⏳ ${label}` : label,
    );
  const input = h("input", { type: "file", accept: "image/*", hidden: true });
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) addDetailPhoto(f);
  });
  strip.replaceChildren(
    chip("", "Oversigt"),
    ...photos.map((ph) => chip(ph.id, ph.name, !bitmaps.has(ph.id) && !availablePhotoIds.has(ph.id))),
    h("label", { class: `photo-chip add ${ed.placing ? "disabled" : ""}`, title: "Tag et nærbillede af en del af printet" }, "＋ Nærbillede", ed.placing ? null : input),
  );
}

/** Nærbilleder hvis billeddata ligger lokalt (opdateres når projektet åbnes/modtages). */
let availablePhotoIds = new Set<string>();

async function refreshAvailablePhotos(): Promise<void> {
  if (!editor) return;
  availablePhotoIds = new Set(await store.storedPhotoIds(editor.project.id));
  renderPhotoStrip();
}

async function photoBitmap(photoId: string): Promise<ImageBitmap | null> {
  const cached = bitmaps.get(photoId);
  if (cached) return cached;
  if (!editor) return null;
  const blob = await store.getPhotoImage(editor.project.id, photoId);
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  bitmaps.set(photoId, bmp);
  return bmp;
}

async function showPhoto(photoId: string | null): Promise<void> {
  const ed = editor;
  if (!ed) return;
  if (!photoId) {
    ed.setPhoto(null, bitmaps.get("")!);
  } else {
    const ph = ed.project.photos?.find((x) => x.id === photoId);
    const bmp = await photoBitmap(photoId);
    if (!ph || !bmp || editor !== ed) {
      toast("Nærbilledet er ikke tilgængeligt endnu.", "error");
      return;
    }
    ed.setPhoto(ph, bmp);
  }
  renderPhotoStrip();
}

async function addDetailPhoto(file: File): Promise<void> {
  const ed = editor;
  if (!ed) return;
  try {
    const { blob, width, height } = await loadAndResize(file);
    if (ed.photo) await showPhoto(null);
    // Startplacering: en tredjedel af printets bredde, midt i det udsnit der vises nu.
    const W = ed.project.width;
    const H = ed.project.height;
    const w = W / 3;
    const hh = w * (height / width);
    const c = ed.toImage(($("#board") as HTMLCanvasElement).clientWidth / 2, ($("#board") as HTMLCanvasElement).clientHeight / 2);
    const cx = Math.max(w / 2, Math.min(W - w / 2, c.x));
    const cy = Math.max(hh / 2, Math.min(H - hh / 2, c.y));
    placement = { photoId: null, blob, width, height, rotated: false };
    ed.setTool("select");
    ed.startPlacing(await createImageBitmap(blob), { x: cx - w / 2, y: cy - hh / 2, w, h: hh });
    setPanelOpen(false);
    renderPhotoStrip();
  } catch (err) {
    toast(`Kunne ikke indlæse billedet: ${err instanceof Error ? err.message : err}`, "error");
  }
}

async function adjustPhotoPlacement(): Promise<void> {
  const ed = editor;
  const ph = ed?.photo;
  if (!ed || !ph) return;
  const blob = await store.getPhotoImage(ed.project.id, ph.id);
  if (!blob) return;
  await showPhoto(null);
  placement = { photoId: ph.id, blob, width: ph.width, height: ph.height, rotated: false };
  ed.startPlacing(await createImageBitmap(blob), { ...ph.region });
  setPanelOpen(false);
  renderPhotoStrip();
}

async function rotatePlacement(): Promise<void> {
  const ed = editor;
  if (!ed?.placing || !placement) return;
  const r = await rotateBlob90(placement.blob);
  const old = ed.placing.rect;
  const cx = old.x + old.w / 2;
  const cy = old.y + old.h / 2;
  const w = old.h;
  const hh = old.w;
  ed.placing.image.close();
  placement = { ...placement, blob: r.blob, width: r.width, height: r.height, rotated: true };
  ed.startPlacing(await createImageBitmap(r.blob), { x: cx - w / 2, y: cy - hh / 2, w, h: hh });
  ($("#place-opacity") as HTMLInputElement).value = "60";
}

function cancelPlacement(): void {
  const ed = editor;
  if (!ed?.placing) return;
  const editing = placement?.photoId;
  ed.placing.image.close();
  ed.stopPlacing();
  placement = null;
  renderPhotoStrip();
  if (editing) showPhoto(editing);
}

async function savePlacement(): Promise<void> {
  const ed = editor;
  const pl = placement;
  if (!ed?.placing || !pl) return;
  const region: Rect = { ...ed.placing.rect };
  const pid = ed.project.id;
  const photos = (ed.project.photos ??= []);
  let id = pl.photoId;

  if (!id || pl.rotated) {
    // Nyt billede (eller roteret billede = nyt id, så andre enheder henter den nye version).
    const newId = uid();
    await store.putPhotoImage(pid, newId, pl.blob);
    availablePhotoIds.add(newId);
    if (id) {
      const old = photos.find((x) => x.id === id)!;
      Object.assign(old, { id: newId, width: pl.width, height: pl.height, region });
      await store.deletePhotoImage(pid, id);
      bitmaps.get(id)?.close();
      bitmaps.delete(id);
    } else {
      const n = photos.length + 1;
      const ph: DetailPhoto = { id: newId, name: `Nærbillede ${n}`, width: pl.width, height: pl.height, region, created: Date.now() };
      photos.push(ph);
    }
    id = newId;
  } else {
    photos.find((x) => x.id === id)!.region = region;
  }
  bitmaps.set(id, ed.placing.image);
  ed.stopPlacing();
  placement = null;
  ed.changed();
  await showPhoto(id);
  toast("Nærbilledet er placeret. Markeringer vises nu på både oversigt og nærbillede.");
}

async function deleteCurrentPhoto(): Promise<void> {
  const ed = editor;
  const ph = ed?.photo;
  if (!ed || !ph) return;
  if (!confirm(`Slet "${ph.name}"? Markeringerne bevares på oversigten.`)) return;
  await showPhoto(null);
  ed.project.photos = (ed.project.photos ?? []).filter((x) => x.id !== ph.id);
  bitmaps.get(ph.id)?.close();
  bitmaps.delete(ph.id);
  await store.deletePhotoImage(ed.project.id, ph.id);
  ed.changed();
  renderPhotoStrip();
}

function renameCurrentPhoto(): void {
  const ed = editor;
  const ph = ed?.photo;
  if (!ed || !ph) return;
  const name = prompt("Navn på nærbilledet:", ph.name);
  if (!name?.trim()) return;
  ph.name = name.trim().slice(0, 40);
  ed.changed();
  renderPhotoStrip();
}

// ---------- Detektering ----------

function openAiDialog(): void {
  const ed = editor;
  if (!ed) return;
  if (!settings.apiKey) {
    toast("Angiv din Anthropic API-nøgle først.");
    openSettings();
    return;
  }
  $("#ai-title").textContent = ed.photo ? `✨ Find komponenter i "${ed.photo.name}"` : "✨ Find komponenter med AI";
  $("#ai-replace-label").textContent = ed.photo
    ? "Erstat tidligere AI-/auto-fundne komponenter i dette udsnit (manuelle beholdes)"
    : "Erstat tidligere AI-/auto-fundne komponenter (manuelle beholdes)";
  const dlg = $("#ai-dialog") as HTMLDialogElement;
  dlg.returnValue = "";
  dlg.showModal();
}

/** Fjerner automatisk fundne komponenter (af `sources`) – på et nærbillede kun dem i udsnittet. */
function removeAutoComponents(ed: Editor, sources: PcbComponent["source"][]): void {
  const region = ed.photo?.region;
  ed.project.components = ed.project.components.filter((c) => {
    if (!sources.includes(c.source)) return true;
    if (!region) return false;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    return !(cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h);
  });
}

async function runAi(): Promise<void> {
  const ed = editor;
  if (!ed) return;
  const context = ($("#ai-context") as HTMLTextAreaElement).value;
  const replace = ($("#ai-replace") as HTMLInputElement).checked;
  const isDetail = !!ed.photo;
  const ctrl = new AbortController();
  const done = showBusy("Claude analyserer billedet … det kan tage et minut.", () => ctrl.abort());
  try {
    const { components, ai } = await detectWithClaude(ed.image, settings, context, ctrl.signal, isDetail);
    if (editor !== ed) return;
    // Komponenterne er fundet i det viste billedes pixels – omregn til projektkoordinater.
    for (const c of components) Object.assign(c, ed.rectOut(c));
    ed.checkpoint();
    if (replace) removeAutoComponents(ed, ["ai", "local"]);
    ed.project.components.push(...components);
    if (!isDetail || !ed.project.ai) ed.project.ai = ai;
    ed.selection = null;
    ed.changed();
    if (panel) {
      panel.tab = isDetail ? "components" : "overview";
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
  removeAutoComponents(ed, ["local"]);
  for (const r of rects) {
    ed.project.components.push({
      id: uid(),
      ...ed.rectOut({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }),
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
  ($("#signal-server") as HTMLInputElement).value = settings.signalServer;
  dlg.returnValue = "";
  dlg.showModal();
}

$("#settings-dialog").addEventListener("close", () => {
  const dlg = $("#settings-dialog") as HTMLDialogElement;
  if (dlg.returnValue !== "save") return;
  const signalChanged = settings.signalServer !== ($("#signal-server") as HTMLInputElement).value.trim();
  settings = {
    apiKey: ($("#api-key") as HTMLInputElement).value.trim(),
    model: ($("#model") as HTMLSelectElement).value,
    effort: ($("#effort") as HTMLSelectElement).value as store.Settings["effort"],
    signalServer: ($("#signal-server") as HTMLInputElement).value.trim(),
  };
  store.saveSettings(settings);
  if (signalChanged && syncModule) {
    syncModule.sync.stop();
    syncModule.sync.start();
  }
  toast("Indstillinger gemt");
});

$("#ai-dialog").addEventListener("close", () => {
  if (($("#ai-dialog") as HTMLDialogElement).returnValue === "run") runAi();
});

// ---------- Synkronisering mellem enheder ----------

type SyncModule = typeof import("./sync");
let syncModule: SyncModule | null = null;

/** Synkroniseringen (og PeerJS) indlæses først når den bruges. */
async function loadSync(): Promise<SyncModule> {
  if (!syncModule) {
    syncModule = await import("./sync");
    syncModule.sync.on(onSyncEvent);
    syncModule.sync.start();
  }
  return syncModule;
}

async function openConnect(): Promise<void> {
  await loadSync();
  const { openConnectDialog } = await import("./connect");
  openConnectDialog();
}

function updateSyncBadge(): void {
  const s = syncModule?.sync;
  const online = s?.onlineCount ?? 0;
  for (const el of document.querySelectorAll<HTMLElement>(".sync-badge")) {
    el.classList.toggle("online", online > 0);
    el.classList.toggle("error", s?.state === "error");
    el.title = !s
      ? "Forbind mobil og computer"
      : online
        ? `Synkroniserer med ${s.devices().filter((d) => d.online).map((d) => d.name).join(", ")}`
        : s.state === "error"
          ? s.error
          : "Ingen forbundne enheder online";
  }
}

async function onSyncEvent(e: SyncEvent): Promise<void> {
  updateSyncBadge();
  if (e.type === "received") {
    const ed = editor;
    if (ed && ed.project.id === e.id) {
      const p = await store.getProject(e.id);
      if (!p || editor !== ed) return;
      if (p.updated >= ed.project.updated) {
        ed.replaceData(p);
        const nameInput = $("#project-name") as HTMLInputElement;
        if (document.activeElement !== nameInput) nameInput.value = p.name;
        if (ed.photo && !p.photos?.some((x) => x.id === ed.photo!.id)) await showPhoto(null);
      }
      await refreshAvailablePhotos();
    } else {
      if (!$("#home").hidden) renderHome();
      if (e.isNew) {
        const p = await store.getProject(e.id);
        toast(`Nyt print modtaget fra ${e.from}${p ? `: ${p.name}` : ""}`, "info", 8000, { label: "Åbn", run: () => openProject(e.id) });
      }
    }
  } else if (e.type === "deleted") {
    if (editor?.project.id === e.id) {
      closeEditor(false);
      history.replaceState(null, "", location.pathname);
      showHome();
      toast(`Projektet blev slettet på ${e.from}.`);
    } else if (!$("#home").hidden) {
      renderHome();
    }
  }
}

// ---------- Eksport ----------

async function exportPng(): Promise<void> {
  if (!editor) return;
  const blob = await canvasToBlob(editor.renderFullRes(), "image/png");
  const suffix = editor.photo ? `-${editor.photo.name}` : "";
  download(`${safeName(editor.project.name + suffix)}.png`, blob);
}

async function exportJson(): Promise<void> {
  if (!editor) return;
  flushSave();
  const p = editor.project;
  const blob = await store.getImage(p.id);
  if (!blob) return;
  const photos: Record<string, string> = {};
  for (const ph of p.photos ?? []) {
    const b = await store.getPhotoImage(p.id, ph.id);
    if (b) photos[ph.id] = await blobToDataUrl(b);
  }
  const payload = { format: "pcb-fejlsoegning", version: 2, project: p, image: await blobToDataUrl(blob), photos };
  download(`${safeName(p.name)}.json`, new Blob([JSON.stringify(payload)], { type: "application/json" }));
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
$("#open-connect").addEventListener("click", openConnect);

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
  if (id && !id.startsWith("pair=") && !editor) openProject(id);
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

$("#place-save").addEventListener("click", savePlacement);
$("#place-cancel").addEventListener("click", cancelPlacement);
$("#place-rotate").addEventListener("click", rotatePlacement);
$("#place-opacity").addEventListener("input", (e) => {
  if (!editor?.placing) return;
  editor.placing.opacity = Number((e.target as HTMLInputElement).value) / 100;
  editor.requestDraw();
});

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
  const onDetail = !!editor?.photo;
  menu.querySelectorAll<HTMLElement>("[data-detail-only]").forEach((el) => (el.hidden = !onDetail));
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
    case "photo-adjust":
      adjustPhotoPlacement();
      break;
    case "photo-rename":
      renameCurrentPhoto();
      break;
    case "photo-delete":
      deleteCurrentPhoto();
      break;
    case "export-png":
      exportPng();
      break;
    case "export-json":
      exportJson();
      break;
    case "connect":
      openConnect();
      break;
    case "settings":
      openSettings();
      break;
    case "delete":
      if (confirm(`Slet projektet "${ed.project.name}"? Det kan ikke fortrydes.`)) {
        const id = ed.project.id;
        closeEditor(false);
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
  if (ed.placing) {
    if (e.key === "Escape") cancelPlacement();
    if (e.key === "Enter") savePlacement();
    return;
  }
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
  const hash = location.hash.slice(1);
  if (hash.startsWith("pair=")) {
    // Åbnet via QR-kode fra en anden enhed.
    history.replaceState(null, "", location.pathname);
    await renderHome();
    await loadSync();
    const { joinWithCode } = await import("./connect");
    joinWithCode(decodeURIComponent(hash.slice(5)));
    return;
  }
  updateSyncBadge();
  if (store.loadPaired().length) loadSync();
  if (hash && (await store.getProject(hash))) {
    history.replaceState(null, "", location.pathname);
    await renderHome();
    await openProject(hash);
  } else {
    await renderHome();
  }
})();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
