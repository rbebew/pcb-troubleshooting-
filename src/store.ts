import type { Project } from "./types";

const DB_NAME = "pcb-fejlsoegning";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects", { keyPath: "id" });
        if (!d.objectStoreNames.contains("images")) d.createObjectStore("images");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => resolve(req ? req.result : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export async function listProjects(): Promise<Project[]> {
  const all = await tx<Project[]>(["projects"], "readonly", (t) => t.objectStore("projects").getAll());
  return all.sort((a, b) => b.updated - a.updated);
}

export function getProject(id: string): Promise<Project | undefined> {
  return tx(["projects"], "readonly", (t) => t.objectStore("projects").get(id));
}

export async function saveProject(p: Project): Promise<void> {
  p.updated = Date.now();
  await tx(["projects"], "readwrite", (t) => t.objectStore("projects").put(p));
  emit({ type: "save", id: p.id });
}

export function getImage(id: string): Promise<Blob | undefined> {
  return tx(["images"], "readonly", (t) => t.objectStore("images").get(id));
}

export async function createProject(p: Project, image: Blob): Promise<void> {
  await putProjectRaw(p, image);
  emit({ type: "save", id: p.id });
}

export async function deleteProject(id: string): Promise<void> {
  await deleteProjectRaw(id);
  const tomb = loadTombstones();
  tomb[id] = Date.now();
  saveTombstones(tomb);
  emit({ type: "delete", id });
}

// --- Rå skrivninger (bruges af synkronisering; ændrer ikke tidsstempler og udløser ingen hændelser) ---

export function putProjectRaw(p: Project, image?: Blob): Promise<unknown> {
  return tx(["projects", "images"], "readwrite", (t) => {
    t.objectStore("projects").put(p);
    if (image) t.objectStore("images").put(image, p.id);
  });
}

export function deleteProjectRaw(id: string): Promise<unknown> {
  return tx(["projects", "images"], "readwrite", (t) => {
    t.objectStore("projects").delete(id);
    t.objectStore("images").delete(id);
    t.objectStore("images").delete(photoRange(id));
  });
}

// --- Nærbilleder: gemmes under nøglen "<projekt-id>:<billede-id>" ---

const photoKey = (projectId: string, photoId: string) => `${projectId}:${photoId}`;
const photoRange = (projectId: string) => IDBKeyRange.bound(`${projectId}:`, `${projectId}:\uffff`);

export function getPhotoImage(projectId: string, photoId: string): Promise<Blob | undefined> {
  return tx(["images"], "readonly", (t) => t.objectStore("images").get(photoKey(projectId, photoId)));
}

export function putPhotoImage(projectId: string, photoId: string, image: Blob): Promise<unknown> {
  return tx(["images"], "readwrite", (t) => t.objectStore("images").put(image, photoKey(projectId, photoId)));
}

export function deletePhotoImage(projectId: string, photoId: string): Promise<unknown> {
  return tx(["images"], "readwrite", (t) => t.objectStore("images").delete(photoKey(projectId, photoId)));
}

/** Id'er på de nærbilleder der faktisk ligger billeddata for. */
export async function storedPhotoIds(projectId: string): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(["images"], "readonly", (t) => t.objectStore("images").getAllKeys(photoRange(projectId)));
  return keys.map((k) => String(k).slice(projectId.length + 1));
}

// --- Slettede projekter huskes, så de ikke kommer tilbage fra en anden enhed ---

const TOMB_KEY = "pcb-deleted";

export function loadTombstones(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(TOMB_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveTombstones(t: Record<string, number>): void {
  try {
    localStorage.setItem(TOMB_KEY, JSON.stringify(t));
  } catch {
    /* ignoreres */
  }
}

// --- Hændelser for lokale ændringer (lyttes på af synkroniseringen) ---

export type StoreEvent = { type: "save" | "delete"; id: string };
const listeners = new Set<(e: StoreEvent) => void>();

export function onLocalChange(fn: (e: StoreEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: StoreEvent): void {
  for (const fn of listeners) fn(e);
}

// --- Indstillinger (kun på denne enhed) ---

export interface Settings {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  /** Valgfri egen PeerJS-signalserver, fx "https://min-server.dk:9000/peerjs". Tom = PeerJS' gratis server. */
  signalServer: string;
}

const SETTINGS_KEY = "pcb-settings";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (bedst)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (hurtigere)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (billigst)" },
];

export function loadSettings(): Settings {
  const defaults: Settings = { apiKey: "", model: "claude-opus-5-5", effort: "medium", signalServer: "" };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* privat browsing e.l. – indstillingen gælder så kun denne session */
  }
}

// --- Enheder (synkronisering mellem mobil og computer) ---

export interface DeviceInfo {
  /** PeerJS-id, fx "pcbfs-K7M2Q9AB". */
  id: string;
  name: string;
}

export interface PairedDevice extends DeviceInfo {
  /** Fælles hemmelighed der aftales ved parring og kræves ved hver forbindelse. */
  secret: string;
  lastSeen?: number;
}

const DEVICE_KEY = "pcb-device";
const PAIRED_KEY = "pcb-paired";
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function randomCode(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function loadDevice(): DeviceInfo {
  try {
    const d = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null");
    if (d?.id && d?.name) return d;
  } catch {
    /* lav ny */
  }
  const isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const d: DeviceInfo = { id: `pcbfs-${randomCode(8)}`, name: isPhone ? "Mobil" : "Computer" };
  saveDevice(d);
  return d;
}

export function saveDevice(d: DeviceInfo): void {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
  } catch {
    /* ignoreres */
  }
}

export function loadPaired(): PairedDevice[] {
  try {
    const list = JSON.parse(localStorage.getItem(PAIRED_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function savePaired(list: PairedDevice[]): void {
  try {
    localStorage.setItem(PAIRED_KEY, JSON.stringify(list));
  } catch {
    /* ignoreres */
  }
}
