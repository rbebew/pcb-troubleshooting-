import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { scaledCanvas, toBase64Jpeg } from "./image";
import type { Settings } from "./store";
import { COMPONENT_TYPES, uid, type AiResult, type ComponentType, type PcbComponent } from "./types";

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

  const useFallbacks = FALLBACK_MODELS.has(settings.model);

  const response = await client.beta.messages.parse(
    {
      model: settings.model,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      output_config: { effort: settings.effort, format: betaZodOutputFormat(DetectionSchema) },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            { type: "text", text: userText },
          ],
        },
      ],
    },
    { signal, timeout: 10 * 60 * 1000 },
  );

  if (response.stop_reason === "refusal") {
    throw new Error("Modellen afviste at analysere billedet. Prøv et andet billede eller en anden model.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Svaret blev for langt (for mange komponenter). Prøv at beskære billedet til et mindre område.");
  }
  const out = response.parsed_output;
  if (!out) throw new Error("Kunne ikke fortolke svaret fra modellen.");

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
    model: response.model,
    at: Date.now(),
  };

  return { components, ai };
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
