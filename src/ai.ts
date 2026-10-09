import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { makeTiles, mergeDetections, type TileDetection } from "./detectMerge";
import { scaledCanvas, toBase64Jpeg } from "./image";
import type { Settings } from "./store";
import {
  COMPONENT_TYPES,
  GUIDE_GOALS,
  METER_MODES,
  uid,
  type AiResult,
  type ChatMessage,
  type ChatPoint,
  type ComponentType,
  type Guide,
  type GuideStep,
  type MeterMode,
  type PcbComponent,
  type Point,
  type Probe,
  type ProbeAnalysis,
  type Rect,
} from "./types";

const TYPE_IDS = COMPONENT_TYPES.map((t) => t.id) as [ComponentType, ...ComponentType[]];

const DetectionSchema = z.object({
  components: z.array(
    z.object({
      designator: z.string().describe("Betegnelse fra silketrykket, fx R12 eller U3. Tom streng hvis den ikke kan læses."),
      type: z.enum(TYPE_IDS),
      value: z.string().describe("Værdi eller påtrykt mærkning, fx '10k', '470uF 25V', 'AMS1117-3.3'. Tom hvis ukendt."),
      description: z.string().describe("Kort beskrivelse af komponentens sandsynlige funktion på kortet."),
      x_min: z.number().describe("Venstre kant, 0-1000 relativt til billedets bredde"),
      y_min: z.number().describe("Øverste kant, 0-1000 relativt til billedets højde"),
      x_max: z.number().describe("Højre kant, 0-1000 relativt til billedets bredde"),
      y_max: z.number().describe("Nederste kant, 0-1000 relativt til billedets højde"),
      confidence: z.enum(["high", "medium", "low"]),
      visible_damage: z
        .string()
        .describe("Synlige tegn på fejl: brændemærker, bulnede/lækkende kondensatorer, revner, kolde lodninger. Tom streng hvis intet."),
    }),
  ),
  power_paths: z.array(
    z.object({
      name: z.string().describe("Netnavn, fx VIN, 5V, 3V3, GND"),
      voltage: z.string().describe("Forventet spænding, fx '12V' eller '3.3V'. Tom hvis ukendt."),
      description: z.string().describe("Hvordan strømmen sandsynligvis løber, på dansk."),
      component_indices: z.array(z.number()).describe("Indeks (0-baseret) i components-listen, i rækkefølge fra kilde mod last."),
    }),
  ),
  power_notes: z.string().describe("Hvor strømmen kommer ind, hvilke regulatorer/sikringer der er, og hvad man bør måle først. Dansk."),
  board_summary: z.string().describe("Kort beskrivelse af hvad printkortet sandsynligvis er og gør. Dansk."),
});

const SYSTEM_PROMPT = `Du er en erfaren elektronikreparatør der hjælper med at fejlsøge printkort ud fra et foto.

Find de synlige elektroniske komponenter på printet og angiv for hver en stram afgrænsningsboks i normaliserede koordinater fra 0 til 1000, hvor (0,0) er billedets øverste venstre hjørne og (1000,1000) er nederste højre. Boksen skal omslutte komponentens krop (og ben/pads når de er synlige), ikke silketrykket ved siden af.

Retningslinjer:
- Medtag alle komponenter du kan se, også små SMD-modstande og -kondensatorer. Hvis der er meget mange ens småkomponenter, så prioriter dem der er relevante for strømforsyningen.
- Læs betegnelser (R1, C5, U2 …) og påtrykte koder fra silketryk og komponenthuse når det er muligt. Gæt ikke betegnelser – brug en tom streng hvis de ikke kan læses.
- Vurder ærligt din sikkerhed for hver komponent.
- Notér synlige skader – det er det vigtigste ved fejlsøgning.
- Beskriv de sandsynlige strømveje: fra indgangsstik gennem sikring, beskyttelsesdiode, regulatorer og filterkondensatorer til lasterne. Referér til komponenter via deres indeks i listen.
- Skriv alle beskrivelser på dansk.`;

export interface DetectionOutput {
  components: PcbComponent[];
  ai: AiResult;
}

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

/** Hvor grundigt billedet analyseres: 1 = hele billedet på én gang, 2 = 2×2 felter, 3 = 3×3 felter. */
export type DetailLevel = 1 | 2 | 3;

export interface DetectProgress {
  done: number;
  total: number;
}

/**
 * Finder komponenter med Claude. Ved detaljegrad 2-3 analyseres billedet desuden i overlappende
 * felter i fuld opløsning, så også meget små SMD-komponenter (0402/0201) kommer med; resultaterne
 * flettes sammen uden dubletter.
 */
export async function detectWithClaude(
  image: ImageBitmap,
  settings: Settings,
  extraContext: string,
  signal?: AbortSignal,
  isDetail = false,
  detail: DetailLevel = 1,
  onProgress?: (p: DetectProgress) => void,
): Promise<DetectionOutput> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const context = extraContext.trim() ? `\n\nOplysninger fra brugeren om kortet/fejlen:\n${extraContext.trim()}` : "";
  const W = image.width;
  const H = image.height;

  const tiles = detail > 1 ? makeTiles(W, H, detail) : [];
  const total = 1 + tiles.length;
  let done = 0;
  const tick = () => onProgress?.({ done: ++done, total });
  onProgress?.({ done: 0, total });

  // Hele billedet: giver overblik, strømveje og de store komponenter.
  const wholeText =
    (isDetail
      ? "Dette er et nærbillede af et udsnit af printkortet. Identificér komponenterne i udsnittet – medtag kun komponenter der er mindst halvt synlige – og beskriv de strømveje du kan se."
      : "Identificér komponenterne på dette printkort og beskriv strømvejene.") + context;
  const wholeTask = detectRegion(client, settings, image, { x: 0, y: 0, w: W, h: H }, 2000, wholeText, signal).then((r) => {
    tick();
    return r;
  });

  // Felterne: kører et par stykker ad gangen.
  const tileResults: TileDetection[] = [];
  const queue = tiles.map((t, i) => ({ t, i }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const text =
        `Dette er et udsnit (felt ${job.i + 1} af ${tiles.length}) af et foto af et printkort, i fuld opløsning. ` +
        "Find ALLE komponenter i udsnittet – også de allermindste: 0201/0402/0603 SMD-modstande og -kondensatorer, SOT-23-transistorer, små dioder, ferritter og testpunkter. " +
        "Medtag komponenter der er skåret over ved kanten, hvis mindst halvdelen er synlig. Læs påtryk og silketryk hvor det kan lade sig gøre. " +
        "board_summary, power_notes og power_paths kan være korte eller tomme for et udsnit." +
        context;
      const res = await detectRegion(client, settings, image, job.t, 1600, text, signal);
      tileResults[job.i] = { tile: job.t, components: res.components };
      tick();
    }
  };
  const workers = Array.from({ length: Math.min(3, tiles.length) }, worker);
  const [whole] = await Promise.all([wholeTask, ...workers]);

  const merged = tiles.length ? mergeDetections(whole.components, tileResults.filter(Boolean), W * H) : { components: whole.components, remap: new Map<string, string>() };
  const keptIds = new Set(merged.components.map((c) => c.id));
  const out = whole.out;
  const ai: AiResult = {
    summary: out.board_summary,
    powerNotes: out.power_notes,
    powerPaths: out.power_paths.map((p) => ({
      name: p.name,
      voltage: p.voltage,
      description: p.description,
      componentIds: p.component_indices
        .filter((i) => Number.isInteger(i) && i >= 0 && i < whole.components.length)
        .map((i) => merged.remap.get(whole.components[i].id) ?? whole.components[i].id)
        .filter((id) => keptIds.has(id)),
    })),
    model: whole.model,
    at: Date.now(),
  };
  return { components: merged.components, ai };
}

/** Analyserer ét område af billedet og returnerer komponenterne i billedets koordinater. */
async function detectRegion(
  client: Anthropic,
  settings: Settings,
  image: ImageBitmap,
  region: Rect,
  maxSide: number,
  userText: string,
  signal?: AbortSignal,
): Promise<{ components: PcbComponent[]; out: z.infer<typeof DetectionSchema>; model: string }> {
  const scale = Math.min(1, maxSide / Math.max(region.w, region.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.w * scale));
  canvas.height = Math.max(1, Math.round(region.h * scale));
  canvas.getContext("2d")!.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  const data = await toBase64Jpeg(canvas);

  const { out, model } = await callClaude(
    client,
    settings,
    SYSTEM_PROMPT,
    DetectionSchema,
    [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
      { type: "text", text: userText },
    ],
    signal,
  );

  const clamp = (v: number) => Math.max(0, Math.min(1000, v));
  const components: PcbComponent[] = out.components.map((c) => {
    const x0 = region.x + (clamp(Math.min(c.x_min, c.x_max)) / 1000) * region.w;
    const x1 = region.x + (clamp(Math.max(c.x_min, c.x_max)) / 1000) * region.w;
    const y0 = region.y + (clamp(Math.min(c.y_min, c.y_max)) / 1000) * region.h;
    const y1 = region.y + (clamp(Math.max(c.y_min, c.y_max)) / 1000) * region.h;
    return {
      id: uid(),
      x: x0,
      y: y0,
      w: Math.max(2, x1 - x0),
      h: Math.max(2, y1 - y0),
      designator: c.designator.trim(),
      type: c.type,
      value: c.value.trim(),
      description: c.description.trim(),
      status: c.visible_damage.trim() ? "suspect" : "unknown",
      notes: "",
      damage: c.visible_damage.trim(),
      confidence: c.confidence,
      source: "ai",
    };
  });
  return { components, out, model };
}

type UserContent = Anthropic.Beta.Messages.BetaContentBlockParam[];

/** Fælles kald med struktureret output, refusal-fallback og fejlhåndtering. */
async function callClaude<S extends z.ZodType>(
  client: Anthropic,
  settings: Settings,
  system: string,
  schema: S,
  content: UserContent,
  signal?: AbortSignal,
): Promise<{ out: z.infer<S>; model: string }> {
  const useFallbacks = FALLBACK_MODELS.has(settings.model);
  const response = await client.beta.messages.parse(
    {
      model: settings.model,
      max_tokens: 32000,
      system,
      output_config: { effort: settings.effort, format: betaZodOutputFormat(schema) },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      messages: [{ role: "user", content }],
    },
    { signal, timeout: 10 * 60 * 1000 },
  );
  if (response.stop_reason === "refusal") {
    throw new Error("Modellen afviste at analysere billedet. Prøv et andet billede eller en anden model.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Svaret blev for langt. Prøv et nærbillede af et mindre område.");
  }
  const out = response.parsed_output as z.infer<S> | null;
  if (!out) throw new Error("Kunne ikke fortolke svaret fra modellen.");
  return { out, model: response.model };
}

// ---------- Fejlanalyse fra et målepunkt ----------

const ProbeAnalysisSchema = z.object({
  at_point: z.string().describe("Hvad der sidder ved/omkring målepunktet (pad, ben på komponent, via, testpunkt …). Dansk."),
  net_name: z.string().describe("Bedste gæt på nettets navn, fx 5V, 3V3, VIN, GND. Tom hvis ukendt."),
  net_voltage: z.string().describe("Forventet spænding på nettet, fx '5V'. Tom hvis ukendt."),
  traces: z.array(
    z.object({
      description: z.string().describe("Hvor banen går hen, fx 'fra målepunktet til ben 3 på U2'. Dansk."),
      confidence: z.enum(["high", "medium", "low"]),
      points: z
        .array(z.object({ x: z.number(), y: z.number() }))
        .describe("Banens forløb som polylinje i normaliserede koordinater 0-1000 i billedet, startende ved målepunktet."),
    }),
  ),
  connected: z.array(
    z.object({
      component_index: z.number().describe("Indeks (#n) i den medsendte komponentliste, eller -1 hvis komponenten ikke er på listen."),
      designator: z.string().describe("Betegnelse, fx C12. Tom hvis ukendt."),
      relation: z.string().describe("Hvordan komponenten er forbundet til målepunktet. Dansk."),
      suspicion: z.enum(["high", "medium", "low"]).describe("Hvor sandsynligt det er at denne komponent forklarer målingen."),
      reason: z.string().describe("Hvorfor den er (eller ikke er) mistænkt i lyset af målingen. Dansk."),
      check: z.string().describe("Konkret hvordan brugeren tester komponenten (måling, modstand, diode-test …). Dansk."),
    }),
  ),
  summary: z.string().describe("Samlet vurdering af fejlen ud fra målingen og det du kan se. Dansk."),
  next_steps: z.array(z.string()).describe("Næste målinger/handlinger i prioriteret rækkefølge. Dansk."),
});

const PROBE_SYSTEM_PROMPT = `Du er en erfaren elektronikreparatør der hjælper med at fejlsøge et printkort ud fra fotos og brugerens målinger.

Du får to udgaver af samme foto: billede 1 er det rene foto, billede 2 er det samme foto hvor brugerens målepunkt er markeret med en magenta ring med kryds, og kendte komponenter er tegnet med tynde cyan rammer og deres indeks (#n). Brug billede 1 til at se kobberbanerne og billede 2 til at vide hvor målepunktet og komponenterne er.

Opgave:
1. Beskriv hvad der sidder ved målepunktet.
2. Følg de synlige kobberbaner fra målepunktet så langt du rent faktisk kan se dem – også under loddestopmasken hvor de anes som lysere/mørkere striber. Angiv hver bane som en polylinje i normaliserede koordinater (0-1000 for både x og y, (0,0) øverst til venstre i billedet) der starter ved målepunktet. Angiv kun baner du kan se; gæt ikke. Hvis en bane forsvinder i en via eller under en komponent, så stop dér og nævn det i beskrivelsen.
3. Find de komponenter der er forbundet til punktet – direkte eller via banerne – og vurder hvilke der mest sandsynligt forklarer målingen. Brug komponentindeks fra listen når det er muligt.
4. Giv konkrete næste skridt: hvad skal måles hvor, og hvad forventes.

Vær ærlig om usikkerhed – især hvis banerne ikke er tydelige på fotoet. Skriv på dansk.`;

export interface ProbeAnalysisInput {
  /** Billedet der analyseres (oversigt eller nærbillede). */
  image: ImageBitmap;
  /** Projektkoordinat -> pixel i `image`. */
  toPixel: (p: Point) => Point;
  /** Pixel i `image` -> projektkoordinat. */
  toProject: (p: Point) => Point;
  probe: Probe;
  netName: string;
  components: PcbComponent[];
  otherProbes: { label: string; net: string; expected: string; measured: string }[];
  description: string;
  isDetail: boolean;
}

/** Komponent der er (delvist) synlig i det billede der sendes til AI, med sit indeks. */
interface VisibleComponent {
  idx: number;
  c: PcbComponent;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Laver to udgaver af fotoet til AI: det rene foto og et hvor kendte komponenter er tegnet med
 * cyan rammer og indeks (#n). `mark` kan tegne ekstra markeringer (fx et målepunkt) på det markerede.
 */
function prepareBoardImages(
  image: ImageBitmap,
  toPixel: (p: Point) => Point,
  components: PcbComponent[],
  mark?: (ctx: CanvasRenderingContext2D, s: number, lineWidth: number) => void,
) {
  const clean = scaledCanvas(image, 2000);
  const s = clean.width / image.width;
  const W = clean.width;
  const H = clean.height;
  const visible: VisibleComponent[] = [];
  components.forEach((c, idx) => {
    const a = toPixel({ x: c.x, y: c.y });
    const b = toPixel({ x: c.x + c.w, y: c.y + c.h });
    const x0 = a.x * s, y0 = a.y * s, x1 = b.x * s, y1 = b.y * s;
    if (x1 < 0 || y1 < 0 || x0 > W || y0 > H) return;
    visible.push({ idx, c, x0, y0, x1, y1 });
  });

  const marked = document.createElement("canvas");
  marked.width = W;
  marked.height = H;
  const ctx = marked.getContext("2d")!;
  ctx.drawImage(clean, 0, 0);
  const lw = Math.max(1.5, W / 900);
  ctx.lineWidth = lw;
  const fontPx = Math.round(Math.max(11, W / 110));
  ctx.font = `600 ${fontPx}px sans-serif`;
  ctx.textBaseline = "bottom";
  for (const v of visible) {
    ctx.strokeStyle = "#00e5ff";
    ctx.strokeRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
    const label = `#${v.idx}`;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(v.x0, v.y0 - fontPx - 2, ctx.measureText(label).width + 4, fontPx + 2);
    ctx.fillStyle = "#00e5ff";
    ctx.fillText(label, v.x0 + 2, v.y0);
  }
  mark?.(ctx, s, lw);

  const norm = (v: number, max: number) => Math.round((v / max) * 1000);
  const compLines = visible.map(
    (v) =>
      `#${v.idx}: ${v.c.designator || "?"} – ${v.c.type}${v.c.value ? ` (${v.c.value})` : ""}, status: ${v.c.status}` +
      `${v.c.notes ? `, noter: ${v.c.notes}` : ""}, boks x ${norm(v.x0, W)}-${norm(v.x1, W)}, y ${norm(v.y0, H)}-${norm(v.y1, H)}`,
  );
  return { clean, marked, W, H, s, visible, compLines, norm };
}

export async function analyzeProbe(input: ProbeAnalysisInput, settings: Settings, signal?: AbortSignal): Promise<ProbeAnalysis> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const { image, toPixel, toProject, probe } = input;

  const { clean, marked, W, H, s, visible, compLines, norm } = prepareBoardImages(image, toPixel, input.components, (ctx, s, lw) => {
    const pp = toPixel(probe);
    const px = pp.x * s;
    const py = pp.y * s;
    const r = Math.max(10, ctx.canvas.width / 70);
    ctx.strokeStyle = "#ff2d95";
    ctx.lineWidth = lw * 2;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.moveTo(px - r * 1.6, py);
    ctx.lineTo(px + r * 1.6, py);
    ctx.moveTo(px, py - r * 1.6);
    ctx.lineTo(px, py + r * 1.6);
    ctx.stroke();
  });
  const pp = toPixel(probe);
  const px = pp.x * s;
  const py = pp.y * s;

  const userText = [
    input.isDetail ? "Fotoet er et nærbillede af et udsnit af printet." : "Fotoet viser hele printet.",
    `Målepunkt ${probe.label} ligger ved x=${norm(px, W)}, y=${norm(py, H)} (normaliseret).`,
    `Net: ${input.netName || "ukendt"}. Forventet: ${probe.expected || "ukendt"}. Målt: ${probe.measured || "ikke angivet"}.`,
    input.description.trim() ? `Brugerens beskrivelse af fejlen:\n${input.description.trim()}` : "",
    input.otherProbes.length
      ? `Andre målinger på kortet:\n${input.otherProbes.map((o) => `- ${o.label} (${o.net || "ukendt net"}): forventet ${o.expected || "?"}, målt ${o.measured || "?"}`).join("\n")}`
      : "",
    compLines.length ? `Kendte komponenter i billedet:\n${compLines.join("\n")}` : "Ingen komponenter er markeret endnu – beskriv dem du ser med designator og component_index -1.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const { out, model } = await callClaude(
    client,
    settings,
    PROBE_SYSTEM_PROMPT,
    ProbeAnalysisSchema,
    [
      { type: "text", text: "Billede 1 (rent foto):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(clean) } },
      { type: "text", text: "Billede 2 (målepunkt og komponenter markeret):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(marked) } },
      { type: "text", text: userText },
    ],
    signal,
  );

  const clamp = (v: number) => Math.max(0, Math.min(1000, v));
  const fromNorm = (pt: { x: number; y: number }) => toProject({ x: ((clamp(pt.x) / 1000) * W) / s, y: ((clamp(pt.y) / 1000) * H) / s });
  const byIndex = new Map(visible.map((v) => [v.idx, v.c]));

  return {
    atPoint: out.at_point,
    netName: out.net_name.trim(),
    netVoltage: out.net_voltage.trim(),
    traces: out.traces
      .filter((t) => t.points.length >= 2)
      .map((t) => ({ description: t.description, confidence: t.confidence, points: t.points.map(fromNorm) })),
    suspects: out.connected.map((c) => ({
      componentId: byIndex.get(c.component_index)?.id ?? "",
      designator: c.designator.trim() || byIndex.get(c.component_index)?.designator || "",
      relation: c.relation,
      suspicion: c.suspicion,
      reason: c.reason,
      check: c.check,
    })),
    summary: out.summary,
    nextSteps: out.next_steps,
    model,
    at: Date.now(),
  };
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "API-nøglen blev afvist. Tjek den under Indstillinger.";
  if (err instanceof Anthropic.PermissionDeniedError) return "API-nøglen har ikke adgang til den valgte model.";
  if (err instanceof Anthropic.RateLimitError) return "For mange forespørgsler lige nu – vent lidt og prøv igen.";
  if (err instanceof Anthropic.BadRequestError) return `Forespørgslen blev afvist: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Kunne ikke forbinde til Anthropic. Tjek internetforbindelsen.";
  if (err instanceof Anthropic.APIError) return `API-fejl ${err.status ?? ""}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------- Placering af nærbilleder og beskæring ----------

const BoxSchema = {
  x_min: z.number().describe("Venstre kant, 0-1000 relativt til billedets bredde"),
  y_min: z.number().describe("Øverste kant, 0-1000 relativt til billedets højde"),
  x_max: z.number().describe("Højre kant, 0-1000 relativt til billedets bredde"),
  y_max: z.number().describe("Nederste kant, 0-1000 relativt til billedets højde"),
};

const LocateSchema = z.object({
  found: z.boolean().describe("false hvis nærbilledet ikke ser ud til at være fra samme print"),
  ...BoxSchema,
  rotation_cw: z.enum(["0", "90", "180", "270"]).describe("Grader nærbilledet skal drejes med uret for at have samme orientering som oversigten"),
  confidence: z.enum(["high", "medium", "low"]),
});

export interface LocateResult {
  found: boolean;
  /** Brøkdele (0-1) af oversigtens bredde/højde. */
  box: { x: number; y: number; w: number; h: number };
  /** Kvart-omgange med uret. */
  rot: 0 | 1 | 2 | 3;
  confidence: "high" | "medium" | "low";
}

function boxFrom(o: { x_min: number; y_min: number; x_max: number; y_max: number }) {
  const c = (v: number) => Math.max(0, Math.min(1000, v)) / 1000;
  const x0 = c(Math.min(o.x_min, o.x_max));
  const y0 = c(Math.min(o.y_min, o.y_max));
  return { x: x0, y: y0, w: c(Math.max(o.x_min, o.x_max)) - x0, h: c(Math.max(o.y_min, o.y_max)) - y0 };
}

/** Spørger Claude hvor på oversigten et nærbillede sidder (bruges som udgangspunkt for finjustering). */
export async function locateDetailWithClaude(overview: ImageBitmap, detail: ImageBitmap, settings: Settings, signal?: AbortSignal): Promise<LocateResult> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const { out } = await callClaude(
    client,
    settings,
    "Du hjælper med at samle fotos af et printkort: et oversigtsbillede af hele printet og nærbilleder af udsnit af det.",
    LocateSchema,
    [
      { type: "text", text: "Billede 1 – oversigt over hele printet:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(scaledCanvas(overview, 1568)) } },
      { type: "text", text: "Billede 2 – nærbillede af et udsnit af samme print:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(scaledCanvas(detail, 1024)) } },
      {
        type: "text",
        text:
          "Find det område på billede 1 som billede 2 viser. Brug komponenternes form, placering og påtryk som pejlemærker. " +
          "Angiv området som en boks i normaliserede koordinater (0-1000) på billede 1, og hvor mange grader billede 2 skal drejes med uret " +
          "for at have samme orientering som billede 1. Sæt found=false hvis billede 2 ikke ser ud til at være fra samme print.",
      },
    ],
    signal,
  );
  return { found: out.found, box: boxFrom(out), rot: (Number(out.rotation_cw) / 90) as 0 | 1 | 2 | 3, confidence: out.confidence };
}

const BoardSchema = z.object({
  found: z.boolean(),
  ...BoxSchema,
});

/** Spørger Claude hvor selve printpladen er i fotoet (til beskæring). Returnerer brøkdele af billedet. */
export async function findBoardWithClaude(image: ImageBitmap, settings: Settings, signal?: AbortSignal): Promise<LocateResult["box"] | null> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const { out } = await callClaude(
    client,
    settings,
    "Du hjælper med at beskære fotos af printkort.",
    BoardSchema,
    [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(scaledCanvas(image, 1568)) } },
      {
        type: "text",
        text:
          "Find selve printpladen på fotoet. Angiv en stram boks i normaliserede koordinater (0-1000) der omslutter hele pladen inklusive " +
          "komponenter og stik der stikker ud over kanten, men uden bord og baggrund. Sæt found=false hvis der ikke er et print på billedet.",
      },
    ],
    signal,
  );
  return out.found ? boxFrom(out) : null;
}

// ---------- Fejlsøgningsguide: ét målepunkt ad gangen ----------

const PointSchema = z.object({
  x: z.number().describe("0-1000 relativt til billedets bredde"),
  y: z.number().describe("0-1000 relativt til billedets højde"),
  where: z.string().describe("Præcist hvor proben sættes, fx 'ben 3 (udgang) på U1' eller 'minus-benet på C5 (GND)'. Dansk."),
});

const GuideSchema = z.object({
  assessment: z.string().describe("Kort status: hvad ved vi nu, og hvad mistænker vi. Dansk."),
  status: z.enum(["step", "done"]).describe("'step' = næste måling, 'done' = fejlen er fundet eller kan ikke indkredses mere med multimeter"),
  step: z.object({
    title: z.string().describe("Kort titel, fx 'Mål modstand fra 5V til GND'. Dansk."),
    why: z.string().describe("Hvorfor denne måling, og hvad den fortæller. Dansk."),
    safety: z.string().describe("Sikkerhedsadvarsel hvis relevant (netspænding, afladning af kondensatorer …), ellers tom streng. Dansk."),
    power: z.enum(["on", "off"]).describe("Skal kortet have strøm under målingen?"),
    mode: z.enum(["dc_voltage", "ac_voltage", "resistance", "continuity", "diode", "current"]),
    range: z.string().describe("Måleområde, fx '20 V' eller 'auto'."),
    red: PointSchema.describe("Hvor den RØDE probe sættes"),
    black: PointSchema.describe("Hvor den SORTE probe sættes"),
    expected: z.string().describe("Hvad et rask kort viser, fx 'ca. 5 V', 'over 100 Ω', 'bip'. Dansk."),
    net_name: z.string().describe("Net målingen hører til, fx 5V, VIN, GND. Tom hvis ukendt."),
    outcomes: z
      .array(z.object({ result: z.string(), meaning: z.string() }))
      .describe("2-4 mulige resultater og hvad de betyder for fejlsøgningen. Dansk."),
  }),
  conclusion: z.object({
    summary: z.string().describe("Hvad fejlen er (eller mest sandsynligt er) og hvorfor. Tom hvis status='step'. Dansk."),
    suspects: z.array(
      z.object({
        component_index: z.number().describe("Indeks (#n) i komponentlisten, -1 hvis ikke på listen"),
        designator: z.string(),
        reason: z.string(),
      }),
    ),
    fix: z.string().describe("Hvad brugeren bør gøre: udskifte, eftermåle uden for kredsløbet, osv. Dansk."),
  }),
});

const GUIDE_SYSTEM_PROMPT = `Du er en erfaren elektronikreparatør der guider en bruger med et multimeter gennem fejlsøgning af et printkort, ét målepunkt ad gangen.

Du får fotoet af printet (rent og med kendte komponenter markeret med cyan rammer og indeks #n), brugerens beskrivelse, tidligere målinger og alle hidtidige skridt med resultater. Giv det ENE næste skridt der giver mest information – eller en konklusion når fejlen er indkredset.

For hvert skridt:
- Angiv præcis hvor den røde og den sorte probe skal sættes, både som koordinater (normaliseret 0-1000 i billedet) og i tekst (fx "ben 1 på U2", "minus på C3"). Vælg punkter der er synlige og til at ramme: ben, pads, testpunkter, stikben, kondensatorernes ben.
- Brug et nemt tilgængeligt GND-punkt til den sorte probe ved spændingsmålinger (stikkets GND-ben, minus på en stor elektrolytkondensator, skruehul med kobber).
- Vælg multimeterindstilling og om kortet skal have strøm. Modstand, gennemgang og diodetest altid UDEN strøm.
- Forklar kort hvorfor, hvad et rask kort viser, og hvad de mulige resultater betyder.

Metode:
- Dødt kort: start ved indgangen og følg strømvejen: spænding på indgangsstikket → efter sikring → efter beskyttelsesdiode → ind/ud af hver regulator → ved lasten. Hvor spændingen forsvinder mellem to punkter, sidder fejlen imellem. Tjek også om forsyningen trækkes ned (kortslutning) frem for at mangle.
- Kortslutning: kortet må IKKE få strøm før kortslutningen er fundet. Mål modstand fra hver forsyningsskinne til GND (store kondensatorer giver en stigende værdi – vent). Meget lav modstand (under ca. 1-5 Ω afhængigt af skinnen) = kortslutning. Del skinnen op ved at løfte en spole, ferrit, 0 Ω-modstand eller sikring og mål hver halvdel. Typiske syndere: keramiske kondensatorer (MLCC), tantalkondensatorer, TVS-/beskyttelsesdioder, MOSFETs og regulatorer. Til at finde den præcise komponent: spændingsfaldsmetoden (mål mV langs banen mens en strømbegrænset laboratorieforsyning sender strøm ind – faldet bliver mindre jo tættere man kommer på kortslutningen) eller strøminjektion ved lav spænding (fx 1 V, strømbegrænset) og find den komponent der bliver varm (finger, termokamera eller isopropanol der fordamper).
- Varm komponent: mål forsyningen ved komponenten, modstand til GND uden strøm, og tjek om lasten efter den er kortsluttet.
- Find strømvejen: brug gennemgangstest mellem stikbenet og komponenternes ben for at bekræfte forbindelser, og spændingsmålinger med strøm til for at følge nettet.
- Komponenttest i kredsløbet: diodetest på dioder/transistorer, modstand på modstande (husk parallelle veje – mål evt. uden for kredsløbet ved at løfte det ene ben).
- Tilpas dig resultaterne. Gentag ikke målinger der allerede er gjort, medmindre et resultat er uklart. Hvis brugeren ikke kunne måle et sted, så foreslå et alternativt punkt.

Sikkerhed: Hvis kortet ser ud til at have netspænding (230 V-indgang, store højspændingskondensatorer, transformer, optokoblere, "HOT"-zone), så advar tydeligt, anbefal at måle uden strøm eller bruge skilletransformer, og send aldrig brugeren ind på primærsiden med strøm på. Mind om at aflade store kondensatorer før modstandsmålinger.

Når status er 'done', udfyld conclusion; ellers lad conclusion-felterne være tomme. Udfyld altid step (ved 'done' kan det være et forslag til en bekræftende måling). Skriv på dansk, kort og konkret – brugeren står med proberne i hånden.`;

export interface GuideInput {
  image: ImageBitmap;
  toPixel: (p: Point) => Point;
  toProject: (p: Point) => Point;
  guide: Guide;
  components: PcbComponent[];
  nets: { name: string; voltage: string }[];
  probes: { label: string; net: string; expected: string; measured: string; notes: string }[];
  isDetail: boolean;
  /** Ekstra besked fra brugeren til dette skridt (fx "fortsæt" efter en konklusion). */
  note?: string;
}

export interface GuideResult {
  assessment: string;
  step: GuideStep | null;
  conclusion: Guide["conclusion"] | null;
  model: string;
}

export async function nextGuideStep(input: GuideInput, settings: Settings, signal?: AbortSignal): Promise<GuideResult> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const { image, toPixel, toProject, guide } = input;
  const { clean, marked, W, H, s, visible, compLines, norm } = prepareBoardImages(image, toPixel, input.components);
  const pos = (p: Point) => {
    const q = toPixel(p);
    return `x=${norm(q.x * s, W)}, y=${norm(q.y * s, H)}`;
  };

  const history = guide.steps.map((st, i) => {
    const m = METER_MODES[st.mode];
    return [
      `Skridt ${i + 1}: ${st.title}`,
      `  Multimeter: ${m.label} (${st.range || "auto"}), strøm ${st.power === "on" ? "TIL" : "FRA"}`,
      `  Rød: ${st.red.where} (${pos(st.red)}) · Sort: ${st.black.where} (${pos(st.black)})`,
      `  Forventet: ${st.expected}`,
      `  Resultat: ${st.skipped ? `kunne ikke måles (${st.result || "ingen grund angivet"})` : st.result || "ikke målt"}` +
        (st.correctedFrom !== undefined ? ` (rettet af brugeren – først angivet som "${st.correctedFrom}")` : ""),
    ].join("\n");
  });

  const userText = [
    input.isDetail ? "Fotoet er et nærbillede af et udsnit af printet." : "Fotoet viser hele printet.",
    `Mål: ${GUIDE_GOALS[guide.goal]}.`,
    guide.description.trim() ? `Brugerens beskrivelse:\n${guide.description.trim()}` : "",
    input.nets.length ? `Kendte net: ${input.nets.map((n) => `${n.name}${n.voltage ? ` (${n.voltage})` : ""}`).join(", ")}` : "",
    input.probes.length
      ? `Målinger brugeren har registreret:\n${input.probes.map((o) => `- ${o.label} (${o.net || "ukendt net"}): forventet ${o.expected || "?"}, målt ${o.measured || "?"}${o.notes ? ` – ${o.notes}` : ""}`).join("\n")}`
      : "",
    compLines.length ? `Kendte komponenter i billedet:\n${compLines.join("\n")}` : "Ingen komponenter er markeret endnu – beskriv dem i tekst.",
    history.length ? `Hidtidige skridt:\n${history.join("\n")}` : "Dette er første skridt.",
    input.note ? `Brugeren skriver: ${input.note}` : "",
    "Giv det næste skridt (eller konklusionen).",
  ]
    .filter(Boolean)
    .join("\n\n");

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const { out, model } = await callClaude(
    client,
    settings,
    GUIDE_SYSTEM_PROMPT,
    GuideSchema,
    [
      { type: "text", text: "Billede 1 (rent foto):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(clean) } },
      { type: "text", text: "Billede 2 (kendte komponenter markeret):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(marked) } },
      { type: "text", text: userText },
    ],
    signal,
  );

  const clamp = (v: number) => Math.max(0, Math.min(1000, v));
  const fromNorm = (pt: { x: number; y: number }) => toProject({ x: ((clamp(pt.x) / 1000) * W) / s, y: ((clamp(pt.y) / 1000) * H) / s });
  const byIndex = new Map(visible.map((v) => [v.idx, v.c]));
  const st = out.step;
  const step: GuideStep = {
    id: uid(),
    title: st.title,
    why: st.why,
    safety: st.safety.trim(),
    power: st.power,
    mode: st.mode as MeterMode,
    range: st.range,
    red: { ...fromNorm(st.red), where: st.red.where },
    black: { ...fromNorm(st.black), where: st.black.where },
    expected: st.expected,
    netName: st.net_name.trim(),
    outcomes: st.outcomes,
    at: Date.now(),
  };
  const done = out.status === "done";
  return {
    assessment: out.assessment,
    step: done ? null : step,
    conclusion: done
      ? {
          summary: out.conclusion.summary,
          fix: out.conclusion.fix,
          suspects: out.conclusion.suspects.map((c) => ({
            componentId: byIndex.get(c.component_index)?.id ?? "",
            designator: c.designator.trim() || byIndex.get(c.component_index)?.designator || "",
            reason: c.reason,
          })),
        }
      : null,
    model,
  };
}

// ---------- Spørgsmål om målinger ----------

const AskSchema = z.object({
  answer: z.string().describe("Svaret til brugeren. Dansk, konkret og kort – brugeren står ved printet med multimeteret."),
  points: z
    .array(z.object({ x: z.number(), y: z.number(), label: z.string() }))
    .describe("Steder på billedet svaret henviser til (normaliseret 0-1000), fx hvor et GND-punkt eller et ben sidder. Tom liste hvis ikke relevant."),
});

const ASK_SYSTEM_PROMPT = `Du er en erfaren elektronikreparatør der hjælper en bruger med at fejlsøge et printkort med et multimeter. Brugeren stiller et spørgsmål om en måling, et målepunkt eller kortet generelt.

Du får fotoet af printet (rent og med kendte komponenter markeret med cyan rammer og indeks #n; det emne spørgsmålet handler om er markeret med gul), fejlsøgningens historik, alle målinger og den hidtidige samtale.

- Svar direkte på spørgsmålet. Forklar gerne hvad en måling betyder, om en værdi er normal, hvorfor den kan opføre sig sådan (fx en værdi der stiger pga. kondensatorer), hvor man finder et punkt, og hvordan man måler sikkert.
- Hvis svaret henviser til steder på printet, så angiv dem i points (normaliseret 0-1000 i billedet) med en kort label.
- Hvis det tyder på at en måling er udført forkert (forkert punkt, forkert indstilling, strøm til/fra), så sig det tydeligt og foreslå at brugeren retter målingen med "✎ Ret" i guiden.
- Ved netspænding: advar tydeligt.
- Svar på dansk. Brug korte afsnit eller punktopstilling hvis det hjælper.`;

export interface AskInput {
  image: ImageBitmap;
  toPixel: (p: Point) => Point;
  toProject: (p: Point) => Point;
  components: PcbComponent[];
  guide?: Guide;
  probes: { label: string; net: string; kind: string; expected: string; measured: string; notes: string; x: number; y: number }[];
  /** Hvad spørgsmålet handler om, i tekst, og de punkter der skal markeres. */
  subject: { label: string; details: string; points: ChatPoint[] };
  chat: ChatMessage[];
  question: string;
  isDetail: boolean;
}

export async function askAboutMeasurement(input: AskInput, settings: Settings, signal?: AbortSignal): Promise<{ answer: string; points: ChatPoint[]; model: string }> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const { image, toPixel, toProject } = input;
  const { clean, marked, W, H, s, compLines, norm } = prepareBoardImages(image, toPixel, input.components, (ctx, sc, lw) => {
    ctx.font = `700 ${Math.round(Math.max(12, ctx.canvas.width / 90))}px sans-serif`;
    ctx.textBaseline = "bottom";
    for (const p of input.subject.points) {
      const q = toPixel(p);
      const x = q.x * sc;
      const y = q.y * sc;
      const r = Math.max(9, ctx.canvas.width / 90);
      ctx.strokeStyle = "#ffd60a";
      ctx.lineWidth = lw * 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffd60a";
      ctx.fillText(p.label, x + r + 3, y - 2);
    }
  });
  const pos = (p: Point) => {
    const q = toPixel(p);
    return `x=${norm(q.x * s, W)}, y=${norm(q.y * s, H)}`;
  };

  const g = input.guide;
  const history = g
    ? g.steps
        .map(
          (st, i) =>
            `Skridt ${i + 1}: ${st.title} – ${METER_MODES[st.mode].label}, strøm ${st.power === "on" ? "TIL" : "FRA"}, rød: ${st.red.where}, sort: ${st.black.where}, forventet: ${st.expected}, resultat: ${
              st.result === undefined ? "ikke målt endnu" : st.skipped ? `kunne ikke måles (${st.result})` : st.result
            }${st.correctedFrom !== undefined ? ` (rettet fra "${st.correctedFrom}")` : ""}`,
        )
        .join("\n")
    : "";
  const chat = input.chat
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Bruger" : "Dig"} (om ${m.subject}): ${m.text}`)
    .join("\n");

  const userText = [
    input.isDetail ? "Fotoet er et nærbillede af et udsnit af printet." : "Fotoet viser hele printet.",
    g ? `Fejlsøgning: ${GUIDE_GOALS[g.goal]}.${g.description ? ` Brugerens beskrivelse: ${g.description}` : ""}${g.assessment ? `\nStatus: ${g.assessment}` : ""}` : "",
    history ? `Guidens skridt:\n${history}` : "",
    input.probes.length
      ? `Målinger:\n${input.probes.map((p) => `- ${p.label} (${p.kind === "resistance" ? "modstand" : "spænding"}, ${p.net || "ukendt net"}) ved ${pos(p)}: forventet ${p.expected || "?"}, målt ${p.measured || "?"}${p.notes ? ` – ${p.notes}` : ""}`).join("\n")}`
      : "",
    compLines.length ? `Kendte komponenter i billedet:\n${compLines.join("\n")}` : "",
    chat ? `Samtalen indtil nu:\n${chat}` : "",
    `Spørgsmålet handler om: ${input.subject.label}${input.subject.details ? `\n${input.subject.details}` : ""}`,
    `Brugerens spørgsmål: ${input.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const { out, model } = await callClaude(
    client,
    settings,
    ASK_SYSTEM_PROMPT,
    AskSchema,
    [
      { type: "text", text: "Billede 1 (rent foto):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(clean) } },
      { type: "text", text: "Billede 2 (komponenter og emnet markeret):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toBase64Jpeg(marked) } },
      { type: "text", text: userText },
    ],
    signal,
  );
  const clamp = (v: number) => Math.max(0, Math.min(1000, v));
  return {
    answer: out.answer.trim(),
    points: out.points.map((p) => ({ ...toProject({ x: ((clamp(p.x) / 1000) * W) / s, y: ((clamp(p.y) / 1000) * H) / s }), label: p.label })),
    model,
  };
}
