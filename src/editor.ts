import { componentsAlongNet, distToSegment, normalizeRect, pointInRect, probeVerdict } from "./geometry";
import { STATUS_COLORS, uid, type Net, type PcbComponent, type Point, type Probe, type Project, type Trace } from "./types";

export type Tool = "select" | "component" | "trace" | "probe";
export type Selection = { kind: "component" | "trace" | "probe" | "net"; id: string } | null;

type Snapshot = Pick<Project, "components" | "nets" | "traces" | "probes">;

type DragOp =
  | { kind: "pan"; startX: number; startY: number; tx: number; ty: number }
  | { kind: "tap"; startX: number; startY: number }
  | { kind: "move"; id: string; start: Point; orig: { x: number; y: number }; snap: boolean }
  | { kind: "resize"; id: string; handle: number; orig: PcbComponent; snap: boolean }
  | { kind: "moveProbe"; id: string; start: Point; orig: Point; snap: boolean }
  | { kind: "moveVertex"; traceId: string; index: number; snap: boolean }
  | { kind: "rect"; start: Point; end: Point }
  | { kind: "pinch"; startDist: number; startMid: Point; scale: number; tx: number; ty: number };

const TAP_SLOP = 7;
const HANDLE_PX = 11;

export class Editor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  project: Project;
  image: ImageBitmap;

  scale = 1;
  tx = 0;
  ty = 0;
  private dpr = 1;

  tool: Tool = "select";
  selection: Selection = null;
  activeNetId: string | null = null;
  focusNetId: string | null = null;
  draft: Point[] | null = null;
  showLabels = true;
  showComponents = true;

  private hover: Point | null = null;
  private pointers = new Map<number, Point>();
  private op: DragOp | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private raf = 0;
  private listeners = new AbortController();
  private resizeObserver: ResizeObserver;

  /** Kaldes når data er ændret (gem + opdater panel). */
  onChange: () => void = () => {};
  /** Kaldes når markering/værktøj/kladde ændres (opdater panel/UI). */
  onUi: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, project: Project, image: ImageBitmap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.project = project;
    this.image = image;
    this.activeNetId = project.nets[0]?.id ?? null;

    // Canvas-elementet genbruges mellem projekter, så lytterne fjernes igen i destroy().
    const signal = this.listeners.signal;
    canvas.addEventListener("pointerdown", this.onPointerDown, { signal });
    canvas.addEventListener("pointermove", this.onPointerMove, { signal });
    canvas.addEventListener("pointerup", this.onPointerUp, { signal });
    canvas.addEventListener("pointercancel", this.onPointerUp, { signal });
    canvas.addEventListener(
      "pointerleave",
      () => {
        this.hover = null;
        this.requestDraw();
      },
      { signal },
    );
    canvas.addEventListener("wheel", this.onWheel, { passive: false, signal });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement!);
    this.resize();
    this.fit();
  }

  destroy(): void {
    this.listeners.abort();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.raf);
    this.raf = -1; // forhindrer nye tegninger
  }

  // ---------- Koordinater ----------

  toImage(sx: number, sy: number): Point {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  toScreen(p: Point): Point {
    return { x: p.x * this.scale + this.tx, y: p.y * this.scale + this.ty };
  }

  private eventPoint(e: PointerEvent | WheelEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    this.dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const hgt = parent.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(hgt * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.requestDraw();
  }

  private get viewW(): number {
    return this.canvas.width / this.dpr;
  }

  private get viewH(): number {
    return this.canvas.height / this.dpr;
  }

  fit(): void {
    const pad = 16;
    const s = Math.min((this.viewW - pad * 2) / this.image.width, (this.viewH - pad * 2) / this.image.height);
    this.scale = s > 0 ? s : 1;
    this.tx = (this.viewW - this.image.width * this.scale) / 2;
    this.ty = (this.viewH - this.image.height * this.scale) / 2;
    this.requestDraw();
  }

  zoomBy(factor: number, center?: Point): void {
    const c = center ?? { x: this.viewW / 2, y: this.viewH / 2 };
    const before = this.toImage(c.x, c.y);
    const minScale = Math.min(this.viewW / this.image.width, this.viewH / this.image.height) * 0.3;
    this.scale = Math.max(minScale, Math.min(40, this.scale * factor));
    this.tx = c.x - before.x * this.scale;
    this.ty = c.y - before.y * this.scale;
    this.requestDraw();
  }

  centerOn(r: { x: number; y: number; w?: number; h?: number }): void {
    const w = r.w ?? 0;
    const hh = r.h ?? 0;
    const target = Math.min(this.viewW / Math.max(w * 4, 80), this.viewH / Math.max(hh * 4, 80));
    if (this.scale < target * 0.6 || this.scale > target * 3) this.scale = target;
    this.tx = this.viewW / 2 - (r.x + w / 2) * this.scale;
    this.ty = this.viewH / 2 - (r.y + hh / 2) * this.scale;
    this.requestDraw();
  }

  // ---------- Fortryd ----------

  private snapshot(): string {
    const { components, nets, traces, probes } = this.project;
    return JSON.stringify({ components, nets, traces, probes } satisfies Snapshot);
  }

  /** Kald før hver ændring af data. */
  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  private restore(s: string): void {
    Object.assign(this.project, JSON.parse(s) as Snapshot);
    if (this.selection && !this.findSelected()) this.selection = null;
    if (this.activeNetId && !this.net(this.activeNetId)) this.activeNetId = this.project.nets[0]?.id ?? null;
    this.changed();
  }

  /** Data er ændret: tegn om og giv besked. */
  changed(): void {
    this.requestDraw();
    this.onChange();
  }

  // ---------- Opslag ----------

  component(id: string): PcbComponent | undefined {
    return this.project.components.find((c) => c.id === id);
  }

  net(id: string): Net | undefined {
    return this.project.nets.find((n) => n.id === id);
  }

  trace(id: string): Trace | undefined {
    return this.project.traces.find((t) => t.id === id);
  }

  probe(id: string): Probe | undefined {
    return this.project.probes.find((p) => p.id === id);
  }

  findSelected(): PcbComponent | Trace | Probe | Net | undefined {
    const s = this.selection;
    if (!s) return undefined;
    if (s.kind === "component") return this.component(s.id);
    if (s.kind === "trace") return this.trace(s.id);
    if (s.kind === "probe") return this.probe(s.id);
    return this.net(s.id);
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.requestDraw();
    this.onUi();
  }

  setTool(t: Tool): void {
    if (this.draft && t !== "trace") this.finishTrace();
    this.tool = t;
    this.canvas.dataset.tool = t;
    // Fokus på et andet net ville gøre det man tegner næsten usynligt.
    if ((t === "trace" || t === "probe") && this.focusNetId && this.focusNetId !== this.activeNetId) this.focusNetId = null;
    this.onUi();
    this.requestDraw();
  }

  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    this.checkpoint();
    const p = this.project;
    if (s.kind === "component") p.components = p.components.filter((c) => c.id !== s.id);
    if (s.kind === "trace") p.traces = p.traces.filter((t) => t.id !== s.id);
    if (s.kind === "probe") p.probes = p.probes.filter((x) => x.id !== s.id);
    if (s.kind === "net") {
      p.nets = p.nets.filter((n) => n.id !== s.id);
      p.traces = p.traces.filter((t) => t.netId !== s.id);
      for (const pr of p.probes) if (pr.netId === s.id) pr.netId = "";
      if (this.activeNetId === s.id) this.activeNetId = p.nets[0]?.id ?? null;
      if (this.focusNetId === s.id) this.focusNetId = null;
    }
    this.selection = null;
    this.changed();
    this.onUi();
  }

  // ---------- Strømvej-kladde ----------

  finishTrace(): void {
    const d = this.draft;
    this.draft = null;
    if (d && d.length >= 2 && this.activeNetId) {
      this.checkpoint();
      const t: Trace = { id: uid(), netId: this.activeNetId, points: d };
      this.project.traces.push(t);
      this.changed();
    }
    this.onUi();
    this.requestDraw();
  }

  cancelTrace(): void {
    this.draft = null;
    this.onUi();
    this.requestDraw();
  }

  undoTracePoint(): void {
    if (!this.draft) return;
    this.draft.pop();
    if (this.draft.length === 0) this.draft = null;
    this.onUi();
    this.requestDraw();
  }

  /** Snap til eksisterende knudepunkter, målepunkter eller komponentcentre. */
  private snap(p: Point, excludeTrace?: string): Point {
    const r = 14 / this.scale;
    let best: Point | null = null;
    let bestD = r;
    const consider = (q: Point) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    };
    for (const t of this.project.traces) {
      if (t.id === excludeTrace) continue;
      for (const q of t.points) consider(q);
    }
    if (this.draft) for (const q of this.draft.slice(0, -1)) consider(q);
    for (const pr of this.project.probes) consider(pr);
    for (const c of this.project.components) consider({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
    return best ? { x: (best as Point).x, y: (best as Point).y } : p;
  }

  // ---------- Hit test ----------

  private hitComponent(p: Point): PcbComponent | undefined {
    if (!this.showComponents) return undefined;
    const pad = 3 / this.scale;
    let best: PcbComponent | undefined;
    for (const c of this.project.components) {
      if (pointInRect(p, c, pad) && (!best || c.w * c.h < best.w * best.h)) best = c;
    }
    return best;
  }

  private hitProbe(p: Point): Probe | undefined {
    const r = 12 / this.scale;
    return [...this.project.probes].reverse().find((pr) => Math.hypot(pr.x - p.x, pr.y - p.y) <= r);
  }

  private hitTrace(p: Point): Trace | undefined {
    const r = 9 / this.scale;
    for (const t of [...this.project.traces].reverse()) {
      if (!this.net(t.netId)?.visible) continue;
      for (let i = 0; i < t.points.length - 1; i++) {
        if (distToSegment(p, t.points[i], t.points[i + 1]) <= r) return t;
      }
    }
    return undefined;
  }

  private hitHandle(sp: Point): number {
    if (this.selection?.kind !== "component") return -1;
    const c = this.component(this.selection.id);
    if (!c) return -1;
    const handles = this.handlePoints(c);
    return handles.findIndex((hp) => Math.abs(hp.x - sp.x) <= HANDLE_PX && Math.abs(hp.y - sp.y) <= HANDLE_PX);
  }

  private hitVertex(sp: Point): number {
    if (this.selection?.kind !== "trace") return -1;
    const t = this.trace(this.selection.id);
    if (!t) return -1;
    return t.points.findIndex((q) => {
      const s = this.toScreen(q);
      return Math.hypot(s.x - sp.x, s.y - sp.y) <= HANDLE_PX;
    });
  }

  /** Skærmkoordinater for hjørnehåndtag: tl, tr, br, bl. */
  private handlePoints(c: PcbComponent): Point[] {
    const a = this.toScreen({ x: c.x, y: c.y });
    const b = this.toScreen({ x: c.x + c.w, y: c.y + c.h });
    return [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
  }

  // ---------- Pointer ----------

  private onPointerDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.eventPoint(e);
    this.pointers.set(e.pointerId, sp);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.op = {
        kind: "pinch",
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        scale: this.scale,
        tx: this.tx,
        ty: this.ty,
      };
      return;
    }
    if (this.pointers.size > 2) return;

    const ip = this.toImage(sp.x, sp.y);
    const panButton = e.button === 1 || e.button === 2;
    if (panButton) {
      this.op = { kind: "pan", startX: sp.x, startY: sp.y, tx: this.tx, ty: this.ty };
      return;
    }

    if (this.tool === "component") {
      this.op = { kind: "rect", start: ip, end: ip };
      return;
    }

    if (this.tool === "select") {
      const handle = this.hitHandle(sp);
      if (handle >= 0 && this.selection) {
        const c = this.component(this.selection.id)!;
        this.op = { kind: "resize", id: c.id, handle, orig: { ...c }, snap: false };
        return;
      }
      const v = this.hitVertex(sp);
      if (v >= 0 && this.selection) {
        this.op = { kind: "moveVertex", traceId: this.selection.id, index: v, snap: false };
        return;
      }
      const pr = this.hitProbe(ip);
      if (pr) {
        this.select({ kind: "probe", id: pr.id });
        this.op = { kind: "moveProbe", id: pr.id, start: ip, orig: { x: pr.x, y: pr.y }, snap: false };
        return;
      }
      const c = this.hitComponent(ip);
      const t = this.hitTrace(ip);
      // Banen vinder over en stor komponent hvis man rammer selve linjen.
      if (t && (!c || this.selection?.kind === "trace" || c.w * c.h * this.scale * this.scale > 2500)) {
        this.select({ kind: "trace", id: t.id });
        this.op = { kind: "tap", startX: sp.x, startY: sp.y };
        return;
      }
      if (c) {
        this.select({ kind: "component", id: c.id });
        this.op = { kind: "move", id: c.id, start: ip, orig: { x: c.x, y: c.y }, snap: false };
        return;
      }
    }

    // Tryk der bliver til panorering hvis fingeren flyttes.
    this.op = { kind: "tap", startX: sp.x, startY: sp.y };
  };

  private onPointerMove = (e: PointerEvent) => {
    const sp = this.eventPoint(e);
    if (!this.pointers.has(e.pointerId)) {
      // Hover (mus) – vis forhåndsvisning af næste strømvejssegment.
      if (this.tool === "trace" || this.tool === "probe") {
        this.hover = this.snap(this.toImage(sp.x, sp.y));
        this.requestDraw();
      }
      return;
    }
    this.pointers.set(e.pointerId, sp);
    const op = this.op;
    if (!op) return;
    const ip = this.toImage(sp.x, sp.y);

    switch (op.kind) {
      case "pinch": {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const s = Math.max(0.02, Math.min(40, op.scale * (dist / Math.max(1, op.startDist))));
        const imgAtStart = { x: (op.startMid.x - op.tx) / op.scale, y: (op.startMid.y - op.ty) / op.scale };
        this.scale = s;
        this.tx = mid.x - imgAtStart.x * s;
        this.ty = mid.y - imgAtStart.y * s;
        break;
      }
      case "tap":
        if (Math.hypot(sp.x - op.startX, sp.y - op.startY) > TAP_SLOP) {
          this.op = { kind: "pan", startX: op.startX, startY: op.startY, tx: this.tx, ty: this.ty };
          this.onPointerMove(e);
          return;
        }
        break;
      case "pan":
        this.tx = op.tx + sp.x - op.startX;
        this.ty = op.ty + sp.y - op.startY;
        break;
      case "rect":
        op.end = ip;
        break;
      case "move": {
        const c = this.component(op.id);
        if (!c) return;
        if (!op.snap) {
          if (Math.hypot(ip.x - op.start.x, ip.y - op.start.y) * this.scale < TAP_SLOP) return;
          this.checkpoint();
          op.snap = true;
        }
        c.x = op.orig.x + ip.x - op.start.x;
        c.y = op.orig.y + ip.y - op.start.y;
        break;
      }
      case "resize": {
        const c = this.component(op.id);
        if (!c) return;
        if (!op.snap) {
          this.checkpoint();
          op.snap = true;
        }
        const o = op.orig;
        const fixed = [
          { x: o.x + o.w, y: o.y + o.h },
          { x: o.x, y: o.y + o.h },
          { x: o.x, y: o.y },
          { x: o.x + o.w, y: o.y },
        ][op.handle];
        Object.assign(c, normalizeRect(fixed, ip));
        break;
      }
      case "moveProbe": {
        const pr = this.probe(op.id);
        if (!pr) return;
        if (!op.snap) {
          if (Math.hypot(ip.x - op.start.x, ip.y - op.start.y) * this.scale < TAP_SLOP) return;
          this.checkpoint();
          op.snap = true;
        }
        pr.x = op.orig.x + ip.x - op.start.x;
        pr.y = op.orig.y + ip.y - op.start.y;
        break;
      }
      case "moveVertex": {
        const t = this.trace(op.traceId);
        if (!t) return;
        if (!op.snap) {
          this.checkpoint();
          op.snap = true;
        }
        t.points[op.index] = this.snap(ip, t.id);
        break;
      }
    }
    this.requestDraw();
  };

  private onPointerUp = (e: PointerEvent) => {
    const sp = this.eventPoint(e);
    this.pointers.delete(e.pointerId);
    const op = this.op;
    if (op?.kind === "pinch") {
      // Fortsæt som panorering med den resterende finger.
      const rest = [...this.pointers.values()][0];
      this.op = rest ? { kind: "pan", startX: rest.x, startY: rest.y, tx: this.tx, ty: this.ty } : null;
      return;
    }
    if (this.pointers.size > 0) return;
    this.op = null;
    if (!op) return;

    if (op.kind === "tap" && e.type === "pointerup") this.handleTap(sp, e.pointerType);
    if (op.kind === "rect") this.finishRect(op.start, op.end);
    if ((op.kind === "move" || op.kind === "resize" || op.kind === "moveProbe" || op.kind === "moveVertex") && op.snap) {
      this.changed();
    }
    this.requestDraw();
  };

  private handleTap(sp: Point, pointerType: string): void {
    const ip = this.toImage(sp.x, sp.y);
    const now = performance.now();
    const isDouble = now - this.lastTap.t < 350 && Math.hypot(sp.x - this.lastTap.x, sp.y - this.lastTap.y) < 24;
    this.lastTap = { t: now, x: sp.x, y: sp.y };

    if (this.tool === "trace") {
      if (!this.activeNetId) {
        this.onUi();
        return;
      }
      if (isDouble && this.draft) {
        this.finishTrace();
        return;
      }
      const p = this.snap(ip);
      if (!this.draft) this.draft = [p];
      else this.draft.push(p);
      if (pointerType !== "mouse") this.hover = null;
      this.onUi();
      return;
    }

    if (this.tool === "probe") {
      this.checkpoint();
      const p = this.snap(ip);
      const pr: Probe = {
        id: uid(),
        x: p.x,
        y: p.y,
        label: `M${this.project.probes.length + 1}`,
        netId: this.netAt(p) ?? this.activeNetId ?? "",
        expected: "",
        measured: "",
        notes: "",
      };
      const net = this.net(pr.netId);
      if (net) pr.expected = net.voltage;
      this.project.probes.push(pr);
      this.selection = { kind: "probe", id: pr.id };
      this.changed();
      this.onUi();
      return;
    }

    if (this.tool === "select") {
      const c = this.hitComponent(ip);
      const t = this.hitTrace(ip);
      if (!c && !t && !this.hitProbe(ip)) this.select(null);
    }
  }

  /** Net hvis bane ligger under punktet. */
  private netAt(p: Point): string | undefined {
    const r = 10 / this.scale;
    for (const t of this.project.traces) {
      for (let i = 0; i < t.points.length - 1; i++) {
        if (distToSegment(p, t.points[i], t.points[i + 1]) <= r) return t.netId;
      }
    }
    return undefined;
  }

  /** Kaldes af main når en ny komponent tegnes. */
  onNewComponent: (rect: { x: number; y: number; w: number; h: number }) => void = () => {};

  private finishRect(a: Point, b: Point): void {
    const r = normalizeRect(a, b);
    if (r.w * this.scale < 6 || r.h * this.scale < 6) {
      // Et tryk: lav en standardboks omkring punktet.
      const s = 24 / this.scale;
      r.x = a.x - s / 2;
      r.y = a.y - s / 2;
      r.w = s;
      r.h = s;
    }
    this.onNewComponent(r);
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const sp = this.eventPoint(e);
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), sp);
    } else {
      this.tx -= e.deltaX;
      this.requestDraw();
    }
  };

  // ---------- Tegning ----------

  requestDraw(): void {
    if (this.raf) return; // allerede planlagt (eller -1 = lukket)
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--canvas-bg").trim() || "#111";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.tx, dpr * this.ty);
    ctx.imageSmoothingEnabled = this.scale < 2;
    ctx.drawImage(this.image, 0, 0);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.focusNetId) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      const a = this.toScreen({ x: 0, y: 0 });
      ctx.fillRect(a.x, a.y, this.image.width * this.scale, this.image.height * this.scale);
    }
    renderOverlay(ctx, this.project, {
      toScreen: (p) => this.toScreen(p),
      scale: this.scale,
      selection: this.selection,
      focusNetId: this.focusNetId,
      showLabels: this.showLabels,
      showComponents: this.showComponents,
    });

    // Kladde til ny strømvej.
    if (this.draft && this.draft.length) {
      const net = this.activeNetId ? this.net(this.activeNetId) : undefined;
      const pts = this.draft.map((p) => this.toScreen(p));
      if (this.hover && this.tool === "trace") pts.push(this.toScreen(this.hover));
      ctx.save();
      ctx.setLineDash([8, 6]);
      strokePath(ctx, pts, net?.color ?? "#fff", 4);
      ctx.restore();
      for (const p of pts.slice(0, this.draft.length)) dot(ctx, p, 4, net?.color ?? "#fff");
    } else if (this.hover && this.tool === "trace") {
      const net = this.activeNetId ? this.net(this.activeNetId) : undefined;
      dot(ctx, this.toScreen(this.hover), 5, net?.color ?? "#fff");
    }

    // Ny komponent-ramme.
    if (this.op?.kind === "rect") {
      const a = this.toScreen(this.op.start);
      const b = this.toScreen(this.op.end);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      ctx.restore();
    }

    // Håndtag.
    if (this.selection?.kind === "component" && this.tool === "select") {
      const c = this.component(this.selection.id);
      if (c) for (const hp of this.handlePoints(c)) handle(ctx, hp);
    }
    if (this.selection?.kind === "trace" && this.tool === "select") {
      const t = this.trace(this.selection.id);
      if (t) for (const q of t.points) handle(ctx, this.toScreen(q));
    }
  }

  /** Renderer det annoterede print i fuld opløsning (til eksport). */
  renderFullRes(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.image.width;
    c.height = this.image.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(this.image, 0, 0);
    const k = Math.max(1, Math.max(c.width, c.height) / 1400);
    ctx.scale(k, k);
    renderOverlay(ctx, this.project, {
      toScreen: (p) => ({ x: p.x / k, y: p.y / k }),
      scale: 1 / k,
      selection: null,
      focusNetId: null,
      showLabels: true,
      showComponents: true,
    });
    return c;
  }
}

// ---------- Overlay-tegning (fælles for skærm og eksport) ----------

interface OverlayOpts {
  toScreen: (p: Point) => Point;
  scale: number;
  selection: Selection;
  focusNetId: string | null;
  showLabels: boolean;
  showComponents: boolean;
}

function renderOverlay(ctx: CanvasRenderingContext2D, project: Project, o: OverlayOpts): void {
  const netById = new Map(project.nets.map((n) => [n.id, n]));
  const focusComps = o.focusNetId ? componentsAlongNet(o.focusNetId, project.traces, project.components) : [];
  const focusOrder = new Map(focusComps.map((c, i) => [c.id, i + 1]));

  // Komponenter.
  if (o.showComponents) {
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    for (const c of project.components) {
      const a = o.toScreen({ x: c.x, y: c.y });
      const w = c.w * o.scale;
      const hh = c.h * o.scale;
      const selected = o.selection?.kind === "component" && o.selection.id === c.id;
      const inFocus = focusOrder.has(c.id);
      const dim = o.focusNetId && !inFocus && !selected;
      const color = STATUS_COLORS[c.status];
      ctx.globalAlpha = dim ? 0.3 : 1;
      ctx.lineWidth = selected ? 3 : inFocus ? 2.5 : 1.5;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeRect(a.x - 1, a.y - 1, w + 2, hh + 2);
      ctx.strokeStyle = selected ? "#ffffff" : color;
      ctx.strokeRect(a.x, a.y, w, hh);
      if (c.status === "faulty" || c.status === "suspect") {
        ctx.fillStyle = c.status === "faulty" ? "rgba(255,69,58,0.22)" : "rgba(255,176,32,0.18)";
        ctx.fillRect(a.x, a.y, w, hh);
      }
      const label = c.designator || (c.value ? c.value : "");
      if (o.showLabels && label && (w > 14 || selected || inFocus)) {
        const text = label.length > 14 ? label.slice(0, 13) + "…" : label;
        const tw = ctx.measureText(text).width;
        const ly = a.y > 16 ? a.y - 1 : a.y + hh + 15;
        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(a.x - 1, ly - 14, tw + 6, 14);
        ctx.fillStyle = selected ? "#fff" : color;
        ctx.fillText(text, a.x + 2, ly - 1);
      }
      if (inFocus) badge(ctx, { x: a.x + w, y: a.y }, String(focusOrder.get(c.id)), netById.get(o.focusNetId!)?.color ?? "#fff");
      ctx.globalAlpha = 1;
    }
  }

  // Strømveje.
  for (const t of project.traces) {
    const net = netById.get(t.netId);
    if (!net || !net.visible) continue;
    const dim = o.focusNetId && o.focusNetId !== t.netId;
    const selected = o.selection?.kind === "trace" && o.selection.id === t.id;
    const netSelected = o.selection?.kind === "net" && o.selection.id === t.netId;
    const pts = t.points.map(o.toScreen);
    ctx.globalAlpha = dim ? 0.18 : 1;
    if (selected || netSelected) strokePath(ctx, pts, "rgba(255,255,255,0.9)", 10);
    strokePath(ctx, pts, net.color, 4.5);
    arrows(ctx, pts, net.color);
    for (const p of [pts[0], pts[pts.length - 1]]) dot(ctx, p, 4, net.color);
    ctx.globalAlpha = 1;
  }

  // Målepunkter.
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const p of project.probes) {
    const s = o.toScreen(p);
    const v = probeVerdict(p);
    const fill = v === "ok" ? "#30d158" : v === "bad" ? "#ff453a" : "#e5e5ea";
    const selected = o.selection?.kind === "probe" && o.selection.id === p.id;
    const dim = o.focusNetId && p.netId !== o.focusNetId;
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, selected ? 9 : 7, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = selected ? "#0a84ff" : "#000";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - 3, s.y);
    ctx.lineTo(s.x + 3, s.y);
    ctx.moveTo(s.x, s.y - 3);
    ctx.lineTo(s.x, s.y + 3);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const text = p.measured ? `${p.label}: ${p.measured}` : p.label;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(s.x + 11, s.y - 8, tw + 8, 16);
    ctx.fillStyle = fill;
    ctx.fillText(text, s.x + 15, s.y);
    ctx.globalAlpha = 1;
  }
}

function strokePath(ctx: CanvasRenderingContext2D, pts: Point[], color: string, width: number): void {
  if (pts.length < 2) return;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  if (width < 8) {
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = width + 2.5;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Pile midt på hvert segment der viser strømmens retning. */
function arrows(ctx: CanvasRenderingContext2D, pts: Point[], color: string): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 28) continue;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function dot(ctx: CanvasRenderingContext2D, p: Point, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.stroke();
}

function handle(ctx: CanvasRenderingContext2D, p: Point): void {
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#0a84ff";
  ctx.lineWidth = 2;
  ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
  ctx.strokeRect(p.x - 5, p.y - 5, 10, 10);
}

function badge(ctx: CanvasRenderingContext2D, p: Point, text: string, color: string): void {
  ctx.save();
  ctx.font = "700 11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.fillText(text, p.x, p.y + 0.5);
  ctx.restore();
}
