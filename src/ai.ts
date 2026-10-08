import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { scaledCanvas, toBase64Jpeg } from "./image";
import type { Settings } from "./store";
import { COMPONENT_TYPES, uid, type AiResult, type ComponentType, type PcbComponent, type Point, type Probe, type ProbeAnalysis } from "./types";

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

export async function detectWithClaude(
  image: ImageBitmap,
  settings: Settings,
  extraContext: string,
  signal?: AbortSignal,
  isDetail = false,
): Promise<DetectionOutput> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");

  const canvas = scaledCanvas(image, 2000);
  const data = await toBase64Jpeg(canvas);

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });

  const userText =
    (isDetail
      ? "Dette er et nærbillede af et udsnit af printkortet. Identificér komponenterne i udsnittet – medtag kun komponenter der er mindst halvt synlige – og beskriv de strømveje du kan se."
      : "Identificér komponenterne på dette printkort og beskriv strømvejene.") +
    (extraContext.trim() ? `\n\nOplysninger fra brugeren om kortet/fejlen:\n${extraContext.trim()}` : "");

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

  const W = image.width;
  const H = image.height;
  const clamp = (v: number) => Math.max(0, Math.min(1000, v));

  const components: PcbComponent[] = out.components.map((c) => {
    const x0 = (clamp(Math.min(c.x_min, c.x_max)) / 1000) * W;
    const x1 = (clamp(Math.max(c.x_min, c.x_max)) / 1000) * W;
    const y0 = (clamp(Math.min(c.y_min, c.y_max)) / 1000) * H;
    const y1 = (clamp(Math.max(c.y_min, c.y_max)) / 1000) * H;
    return {
      id: uid(),
      x: x0,
      y: y0,
      w: Math.max(4, x1 - x0),
      h: Math.max(4, y1 - y0),
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

  const ai: AiResult = {
    summary: out.board_summary,
    powerNotes: out.power_notes,
    powerPaths: out.power_paths.map((p) => ({
      name: p.name,
      voltage: p.voltage,
      description: p.description,
      componentIds: p.component_indices
        .filter((i) => Number.isInteger(i) && i >= 0 && i < components.length)
        .map((i) => components[i].id),
    })),
    model,
    at: Date.now(),
  };

  return { components, ai };
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

export async function analyzeProbe(input: ProbeAnalysisInput, settings: Settings, signal?: AbortSignal): Promise<ProbeAnalysis> {
  if (!settings.apiKey) throw new Error("Angiv en Anthropic API-nøgle under Indstillinger først.");
  const { image, toPixel, toProject, probe } = input;

  const clean = scaledCanvas(image, 2000);
  const s = clean.width / image.width;
  const W = clean.width;
  const H = clean.height;

  // Komponenter der (delvist) er synlige i billedet, med indeks.
  const visible: { idx: number; c: PcbComponent; x0: number; y0: number; x1: number; y1: number }[] = [];
  input.components.forEach((c, idx) => {
    const a = toPixel({ x: c.x, y: c.y });
    const b = toPixel({ x: c.x + c.w, y: c.y + c.h });
    const x0 = a.x * s, y0 = a.y * s, x1 = b.x * s, y1 = b.y * s;
    if (x1 < 0 || y1 < 0 || x0 > W || y0 > H) return;
    visible.push({ idx, c, x0, y0, x1, y1 });
  });

  // Billede 2: målepunkt og komponenter markeret.
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
  const pp = toPixel(probe);
  const px = pp.x * s;
  const py = pp.y * s;
  const r = Math.max(10, W / 70);
  ctx.strokeStyle = "#ff2d95";
  ctx.lineWidth = lw * 2;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.moveTo(px - r * 1.6, py);
  ctx.lineTo(px + r * 1.6, py);
  ctx.moveTo(px, py - r * 1.6);
  ctx.lineTo(px, py + r * 1.6);
  ctx.stroke();

  const norm = (v: number, max: number) => Math.round((v / max) * 1000);
  const compLines = visible.map(
    (v) =>
      `#${v.idx}: ${v.c.designator || "?"} – ${v.c.type}${v.c.value ? ` (${v.c.value})` : ""}, status: ${v.c.status}` +
      `${v.c.notes ? `, noter: ${v.c.notes}` : ""}, boks x ${norm(v.x0, W)}-${norm(v.x1, W)}, y ${norm(v.y0, H)}-${norm(v.y1, H)}`,
  );
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
