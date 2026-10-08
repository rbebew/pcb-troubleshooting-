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

export function saveProject(p: Project): Promise<unknown> {
  p.updated = Date.now();
  return tx(["projects"], "readwrite", (t) => t.objectStore("projects").put(p));
}

export function getImage(id: string): Promise<Blob | undefined> {
  return tx(["images"], "readonly", (t) => t.objectStore("images").get(id));
}

export function createProject(p: Project, image: Blob): Promise<unknown> {
  return tx(["projects", "images"], "readwrite", (t) => {
    t.objectStore("projects").put(p);
    t.objectStore("images").put(image, p.id);
  });
}

export function deleteProject(id: string): Promise<unknown> {
  return tx(["projects", "images"], "readwrite", (t) => {
    t.objectStore("projects").delete(id);
    t.objectStore("images").delete(id);
  });
}

// --- Indstillinger (kun på denne enhed) ---

export interface Settings {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
}

const SETTINGS_KEY = "pcb-settings";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (bedst)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (hurtigere)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (billigst)" },
];

export function loadSettings(): Settings {
  const defaults: Settings = { apiKey: "", model: "claude-opus-5-5", effort: "medium" };
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
