import Peer, { type DataConnection, type PeerError } from "peerjs";
import * as store from "./store";
import type { Project } from "./types";

/**
 * Synkronisering mellem enheder (fx mobil og computer) direkte via WebRTC.
 *
 * - PeerJS' gratis signalserver bruges kun til at finde hinanden; selve data (billeder og
 *   annoteringer) sendes krypteret direkte mellem enhederne.
 * - Parring: den ene enhed viser en QR-kode/kode med en engangsnøgle. Den anden forbinder
 *   med nøglen og en ny fælles hemmelighed, som begge gemmer. Senere forbindelser kræver
 *   hemmeligheden, så fremmede ikke kan forbinde selv om de kender enhedens id.
 * - Konflikter løses med "seneste ændring vinder" pr. projekt.
 */

type Msg =
  | { type: "hello"; name: string; manifest: [string, number][]; deleted: Record<string, number> }
  | { type: "welcome"; name: string }
  | { type: "project"; project: string; image?: ArrayBuffer; imageType?: string }
  | { type: "need"; id: string }
  | { type: "needPhoto"; id: string; photoId: string }
  | { type: "photo"; id: string; photoId: string; image: ArrayBuffer; imageType: string }
  | { type: "delete"; id: string; ts: number };

interface ConnMeta {
  from: string;
  name: string;
  secret: string;
  pairToken?: string;
}

export type SyncState = "off" | "connecting" | "ready" | "error";

export type SyncEvent =
  | { type: "status" }
  | { type: "received"; id: string; isNew: boolean; from: string }
  | { type: "deleted"; id: string; from: string }
  | { type: "paired"; name: string };

export interface DeviceStatus extends store.PairedDevice {
  online: boolean;
}

const PEER_PREFIX = "pcbfs-";
const RETRY_MS = 20_000;
const PUSH_DELAY_MS = 600;
const PAIR_TOKEN_TTL_MS = 10 * 60_000;

/** Kode til manuel indtastning: 8 tegn enheds-id + 6 tegn engangsnøgle. */
export function formatPairCode(deviceId: string, token: string): string {
  const s = deviceId.slice(PEER_PREFIX.length) + token;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export function parsePairCode(code: string): { peerId: string; token: string } | null {
  const s = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length !== 14 || [...s].some((ch) => !store.CODE_ALPHABET.includes(ch))) return null;
  return { peerId: PEER_PREFIX + s.slice(0, 8), token: s.slice(8) };
}

export function pairUrl(code: string): string {
  return `${location.origin}${location.pathname}#pair=${code}`;
}

class SyncManager {
  state: SyncState = "off";
  error = "";
  device = store.loadDevice();
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private connecting = new Map<string, DataConnection>();
  /** Hvad hver forbundet enhed har: projekt-id -> updated. */
  private known = new Map<string, Map<string, number>>();
  private pairToken: { token: string; expires: number } | null = null;
  private pendingJoin: { conn: DataConnection; secret: string; resolve: (name: string) => void; reject: (e: Error) => void } | null = null;
  private pushTimers = new Map<string, number>();
  private retryTimer = 0;
  private idRetries = 0;
  private listeners = new Set<(e: SyncEvent) => void>();
  private stopStore: (() => void) | null = null;

  on(fn: (e: SyncEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SyncEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private setState(s: SyncState, error = ""): void {
    this.state = s;
    this.error = error;
    this.emit({ type: "status" });
  }

  devices(): DeviceStatus[] {
    return store.loadPaired().map((d) => ({ ...d, online: !!this.conns.get(d.id)?.open }));
  }

  get onlineCount(): number {
    return this.devices().filter((d) => d.online).length;
  }

  // ---------- Livscyklus ----------

  start(): void {
    if (this.peer && !this.peer.destroyed) return;
    this.setState("connecting");
    const peer = new Peer(this.device.id, { debug: 0, ...serverOptions(store.loadSettings().signalServer) });
    this.peer = peer;

    peer.on("open", () => {
      this.idRetries = 0;
      this.setState("ready");
      this.reconnectAll();
    });
    peer.on("connection", (conn) => this.onIncoming(conn));
    peer.on("disconnected", () => {
      if (peer.destroyed) return;
      this.setState("connecting");
      setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 3000);
    });
    peer.on("error", (err: PeerError<string>) => this.onPeerError(err));

    if (!this.stopStore) this.stopStore = store.onLocalChange((e) => this.onLocalChange(e));
    clearInterval(this.retryTimer);
    this.retryTimer = window.setInterval(() => this.reconnectAll(), RETRY_MS);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop(): void {
    clearInterval(this.retryTimer);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.peer?.destroy();
    this.peer = null;
    this.conns.clear();
    this.connecting.clear();
    this.setState("off");
  }

  private onVisible = () => {
    if (document.visibilityState !== "visible" || !this.peer) return;
    if (this.peer.destroyed) {
      this.peer = null;
      this.start();
    } else if (this.peer.disconnected) {
      this.peer.reconnect();
    } else {
      this.reconnectAll();
    }
  };

  private onPeerError(err: PeerError<string>): void {
    const id = this.connectingIdFromError(err);
    switch (err.type) {
      case "peer-unavailable":
        // Den anden enhed er ikke online lige nu – helt normalt.
        if (id) this.connecting.delete(id);
        if (this.pendingJoin && (!id || id === this.pendingJoin.conn.peer)) {
          this.failJoin("Den anden enhed blev ikke fundet. Er appen åben på den, og er koden rigtig?");
        }
        break;
      case "unavailable-id":
        // Efter en genindlæsning kan serveren kortvarigt holde på det gamle id – prøv igen.
        if (this.idRetries++ < 4) {
          this.setState("connecting");
          this.peer?.destroy();
          this.peer = null;
          setTimeout(() => this.peer || this.start(), 3000);
        } else {
          this.setState("error", "Appen er allerede åben i en anden fane eller et andet vindue på denne enhed.");
        }
        break;
      case "browser-incompatible":
        this.setState("error", "Denne browser understøtter ikke direkte forbindelser (WebRTC).");
        break;
      case "network":
      case "server-error":
      case "socket-error":
      case "socket-closed":
        this.setState("error", "Ingen forbindelse til signalserveren. Tjek internetforbindelsen – der prøves igen automatisk.");
        if (this.pendingJoin) this.failJoin("Ingen forbindelse til signalserveren.");
        break;
      default:
        console.warn("PeerJS:", err.type, err);
    }
  }

  private connectingIdFromError(err: PeerError<string>): string | undefined {
    const m = String(err.message).match(/peer (\S+)/i);
    return m?.[1];
  }

  // ---------- Parring ----------

  /** Opretter en engangsnøgle og returnerer koden der skal vises som QR. */
  startPairing(): string {
    this.start();
    const token = store.randomCode(6);
    this.pairToken = { token, expires: Date.now() + PAIR_TOKEN_TTL_MS };
    return formatPairCode(this.device.id, token);
  }

  cancelPairing(): void {
    this.pairToken = null;
  }

  /** Forbinder til en enhed der viser en parringskode. Returnerer den anden enheds navn. */
  async join(code: string): Promise<string> {
    const parsed = parsePairCode(code);
    if (!parsed) throw new Error("Koden er ugyldig. Den består af 14 tegn, fx ABCD-EFGH-K7M2Q9.");
    if (parsed.peerId === this.device.id) throw new Error("Det er denne enheds egen kode – indtast den på den anden enhed.");
    this.start();
    await this.waitReady();
    if (this.pendingJoin) this.failJoin("Afbrudt");

    const secret = store.randomCode(24);
    const meta: ConnMeta = { from: this.device.id, name: this.device.name, secret, pairToken: parsed.token };
    const conn = this.peer!.connect(parsed.peerId, { metadata: meta, reliable: true });
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.failJoin("Ingen svar fra den anden enhed. Er koden stadig gyldig?"), 20_000);
      this.pendingJoin = {
        conn,
        secret,
        resolve: (n) => {
          clearTimeout(timer);
          resolve(n);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      conn.on("open", () => this.attach(conn));
      conn.on("close", () => {
        if (this.pendingJoin?.conn === conn) this.failJoin("Den anden enhed afviste forbindelsen. Koden er måske udløbet eller allerede brugt.");
      });
    });
  }

  private failJoin(msg: string): void {
    const j = this.pendingJoin;
    this.pendingJoin = null;
    if (!j) return;
    j.conn.close();
    j.reject(new Error(msg));
  }

  private waitReady(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(this.error || "Kunne ikke forbinde til signalserveren."));
      }, 15_000);
      const off = this.on(() => {
        if (this.state === "ready") {
          clearTimeout(timer);
          off();
          resolve();
        } else if (this.state === "error") {
          clearTimeout(timer);
          off();
          reject(new Error(this.error));
        }
      });
    });
  }

  rename(name: string): void {
    this.device = { ...this.device, name: name.trim() || this.device.name };
    store.saveDevice(this.device);
  }

  unpair(id: string): void {
    store.savePaired(store.loadPaired().filter((d) => d.id !== id));
    this.conns.get(id)?.close();
    this.conns.delete(id);
    this.emit({ type: "status" });
  }

  // ---------- Forbindelser ----------

  private reconnectAll(): void {
    if (!this.peer || this.peer.disconnected || this.state !== "ready") return;
    for (const d of store.loadPaired()) {
      if (this.conns.get(d.id)?.open || this.connecting.has(d.id)) continue;
      const meta: ConnMeta = { from: this.device.id, name: this.device.name, secret: d.secret };
      const conn = this.peer.connect(d.id, { metadata: meta, reliable: true });
      this.connecting.set(d.id, conn);
      const timeout = setTimeout(() => {
        if (this.connecting.get(d.id) === conn) {
          this.connecting.delete(d.id);
          if (!conn.open) conn.close();
        }
      }, 15_000);
      conn.on("open", () => {
        clearTimeout(timeout);
        this.connecting.delete(d.id);
        this.attach(conn);
      });
      conn.on("close", () => {
        if (this.connecting.get(d.id) === conn) this.connecting.delete(d.id);
      });
    }
  }

  private onIncoming(conn: DataConnection): void {
    const m = (conn.metadata ?? {}) as Partial<ConnMeta>;
    const paired = store.loadPaired();
    const known = paired.find((d) => d.id === conn.peer);
    const tok = this.pairToken;

    if (m.pairToken && tok && tok.expires > Date.now() && m.pairToken === tok.token && typeof m.secret === "string" && m.secret.length >= 16) {
      this.pairToken = null; // engangsnøgle
      const name = String(m.name || "Enhed").slice(0, 40);
      store.savePaired([...paired.filter((d) => d.id !== conn.peer), { id: conn.peer, name, secret: m.secret, lastSeen: Date.now() }]);
      conn.on("open", () => {
        conn.send({ type: "welcome", name: this.device.name } satisfies Msg);
        this.attach(conn);
        this.emit({ type: "paired", name });
      });
      return;
    }
    if (known && m.secret === known.secret) {
      conn.on("open", () => this.attach(conn));
      return;
    }
    // Ukendt enhed eller forkert hemmelighed.
    conn.on("open", () => conn.close());
    setTimeout(() => conn.open || conn.close(), 5000);
  }

  private attach(conn: DataConnection): void {
    const peerId = conn.peer;
    const existing = this.conns.get(peerId);
    if (existing && existing !== conn && existing.open) {
      const initiator = (c: DataConnection) => (c.metadata as ConnMeta | undefined)?.from;
      if (initiator(existing) !== initiator(conn)) {
        // Begge enheder forbandt samtidig: behold den der er startet af enheden med det laveste id.
        const preferred = this.device.id < peerId ? this.device.id : peerId;
        if (initiator(existing) === preferred) {
          conn.close();
          return;
        }
      }
      // Samme afsender forbinder igen (fx efter genindlæsning): den gamle forbindelse er død.
      existing.close();
    }
    this.conns.set(peerId, conn);
    this.known.set(peerId, new Map());
    conn.on("data", (d) => this.onData(conn, d as Msg).catch((e) => console.error("Synk-fejl:", e)));
    conn.on("close", () => {
      if (this.conns.get(peerId) === conn) {
        this.conns.delete(peerId);
        this.emit({ type: "status" });
      }
    });
    conn.on("error", (e) => console.warn("Forbindelsesfejl:", e));
    this.touch(peerId);
    this.sendHello(conn);
    this.emit({ type: "status" });
  }

  private touch(peerId: string, name?: string): void {
    const list = store.loadPaired();
    const d = list.find((x) => x.id === peerId);
    if (!d) return;
    d.lastSeen = Date.now();
    if (name) d.name = name.slice(0, 40);
    store.savePaired(list);
  }

  private nameOf(peerId: string): string {
    return store.loadPaired().find((d) => d.id === peerId)?.name ?? "anden enhed";
  }

  private async sendHello(conn: DataConnection): Promise<void> {
    const projects = await store.listProjects();
    conn.send({
      type: "hello",
      name: this.device.name,
      manifest: projects.map((p) => [p.id, p.updated]),
      deleted: store.loadTombstones(),
    } satisfies Msg);
  }

  // ---------- Modtagelse ----------

  private async onData(conn: DataConnection, msg: Msg): Promise<void> {
    const peerId = conn.peer;
    const known = this.known.get(peerId) ?? new Map<string, number>();
    switch (msg.type) {
      case "welcome": {
        const j = this.pendingJoin;
        if (j?.conn === conn) {
          this.pendingJoin = null;
          const list = store.loadPaired().filter((d) => d.id !== peerId);
          store.savePaired([...list, { id: peerId, name: String(msg.name).slice(0, 40), secret: j.secret, lastSeen: Date.now() }]);
          j.resolve(msg.name);
          this.emit({ type: "paired", name: msg.name });
          this.emit({ type: "status" });
        }
        break;
      }
      case "hello": {
        this.touch(peerId, msg.name);
        for (const [id, updated] of msg.manifest) known.set(id, updated);
        for (const [id, ts] of Object.entries(msg.deleted ?? {})) await this.applyDelete(id, ts, peerId);
        const theirDeleted = msg.deleted ?? {};
        for (const p of await store.listProjects()) {
          if ((theirDeleted[p.id] ?? 0) >= p.updated) continue;
          const theirs = known.get(p.id);
          if (theirs === undefined || theirs < p.updated) await this.sendProject(conn, p.id);
          // Hent nærbilleder vi mangler (fx hvis forbindelsen blev afbrudt under overførslen).
          await this.requestMissingPhotos(conn, p);
        }
        this.emit({ type: "status" });
        break;
      }
      case "project": {
        const p = JSON.parse(msg.project) as Project;
        if (!p?.id || typeof p.updated !== "number") return;
        known.set(p.id, p.updated);
        const tomb = store.loadTombstones();
        if ((tomb[p.id] ?? 0) >= p.updated) return;
        const local = await store.getProject(p.id);
        if (local && local.updated >= p.updated) return;
        let image: Blob | undefined;
        if (msg.image) image = new Blob([msg.image], { type: msg.imageType || "image/jpeg" });
        else if (!local || !(await store.getImage(p.id))) {
          conn.send({ type: "need", id: p.id } satisfies Msg);
          return;
        }
        await store.putProjectRaw(p, image);
        if (tomb[p.id]) {
          delete tomb[p.id];
          store.saveTombstones(tomb);
        }
        // Ryd op i nærbilleder der er slettet på den anden enhed, og hent nye.
        const listed = new Set((p.photos ?? []).map((x) => x.id));
        for (const pid of await store.storedPhotoIds(p.id)) if (!listed.has(pid)) await store.deletePhotoImage(p.id, pid);
        await this.requestMissingPhotos(conn, p);
        this.emit({ type: "received", id: p.id, isNew: !local, from: this.nameOf(peerId) });
        break;
      }
      case "needPhoto": {
        const img = await store.getPhotoImage(msg.id, msg.photoId);
        if (img && conn.open) {
          conn.send({ type: "photo", id: msg.id, photoId: msg.photoId, image: await img.arrayBuffer(), imageType: img.type } satisfies Msg);
        }
        break;
      }
      case "photo": {
        const p = await store.getProject(msg.id);
        if (!p?.photos?.some((x) => x.id === msg.photoId)) return;
        await store.putPhotoImage(msg.id, msg.photoId, new Blob([msg.image], { type: msg.imageType || "image/jpeg" }));
        this.emit({ type: "received", id: msg.id, isNew: false, from: this.nameOf(peerId) });
        break;
      }
      case "need":
        known.delete(msg.id);
        await this.sendProject(conn, msg.id);
        break;
      case "delete":
        await this.applyDelete(msg.id, msg.ts, peerId);
        break;
    }
  }

  private async applyDelete(id: string, ts: number, peerId: string): Promise<void> {
    const tomb = store.loadTombstones();
    if ((tomb[id] ?? 0) < ts) {
      tomb[id] = ts;
      store.saveTombstones(tomb);
    }
    const local = await store.getProject(id);
    if (local && local.updated <= ts) {
      await store.deleteProjectRaw(id);
      this.emit({ type: "deleted", id, from: this.nameOf(peerId) });
    }
  }

  private async requestMissingPhotos(conn: DataConnection, p: Project): Promise<void> {
    if (!p.photos?.length) return;
    const have = new Set(await store.storedPhotoIds(p.id));
    for (const ph of p.photos) {
      if (!have.has(ph.id) && conn.open) conn.send({ type: "needPhoto", id: p.id, photoId: ph.id } satisfies Msg);
    }
  }

  // ---------- Afsendelse ----------

  private async sendProject(conn: DataConnection, id: string): Promise<void> {
    const p = await store.getProject(id);
    if (!p || !conn.open) return;
    const known = this.known.get(conn.peer);
    const msg: Msg = { type: "project", project: JSON.stringify(p) };
    if (!known?.has(id)) {
      const img = await store.getImage(id);
      if (img) {
        msg.image = await img.arrayBuffer();
        msg.imageType = img.type;
      }
    }
    conn.send(msg);
    known?.set(id, p.updated);
  }

  private onLocalChange(e: store.StoreEvent): void {
    if (e.type === "delete") {
      clearTimeout(this.pushTimers.get(e.id));
      const ts = store.loadTombstones()[e.id] ?? Date.now();
      for (const c of this.conns.values()) if (c.open) c.send({ type: "delete", id: e.id, ts } satisfies Msg);
      return;
    }
    // Saml hurtige ændringer (fx mens man trækker en boks) til én afsendelse.
    clearTimeout(this.pushTimers.get(e.id));
    this.pushTimers.set(
      e.id,
      window.setTimeout(() => {
        this.pushTimers.delete(e.id);
        for (const c of this.conns.values()) if (c.open) this.sendProject(c, e.id).catch((err) => console.warn(err));
      }, PUSH_DELAY_MS),
    );
  }
}

function serverOptions(url: string): { host?: string; port?: number; path?: string; secure?: boolean } {
  if (!url.trim()) return {};
  try {
    const u = new URL(url.trim());
    const secure = u.protocol === "https:" || u.protocol === "wss:";
    return { host: u.hostname, port: u.port ? Number(u.port) : secure ? 443 : 80, path: u.pathname || "/", secure };
  } catch {
    return {};
  }
}

export const sync = new SyncManager();
