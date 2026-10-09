export type ComponentType =
  | "resistor"
  | "capacitor"
  | "electrolytic_capacitor"
  | "inductor"
  | "diode"
  | "led"
  | "transistor"
  | "mosfet"
  | "ic"
  | "voltage_regulator"
  | "connector"
  | "fuse"
  | "relay"
  | "crystal"
  | "transformer"
  | "switch"
  | "potentiometer"
  | "test_point"
  | "other";

export const COMPONENT_TYPES: { id: ComponentType; label: string; prefix: string }[] = [
  { id: "resistor", label: "Modstand", prefix: "R" },
  { id: "capacitor", label: "Kondensator", prefix: "C" },
  { id: "electrolytic_capacitor", label: "Elektrolytkondensator", prefix: "C" },
  { id: "inductor", label: "Spole", prefix: "L" },
  { id: "diode", label: "Diode", prefix: "D" },
  { id: "led", label: "LED", prefix: "LED" },
  { id: "transistor", label: "Transistor", prefix: "Q" },
  { id: "mosfet", label: "MOSFET", prefix: "Q" },
  { id: "ic", label: "IC / chip", prefix: "U" },
  { id: "voltage_regulator", label: "Spændingsregulator", prefix: "U" },
  { id: "connector", label: "Stik / connector", prefix: "J" },
  { id: "fuse", label: "Sikring", prefix: "F" },
  { id: "relay", label: "Relæ", prefix: "K" },
  { id: "crystal", label: "Krystal / oscillator", prefix: "Y" },
  { id: "transformer", label: "Transformer", prefix: "T" },
  { id: "switch", label: "Kontakt / knap", prefix: "SW" },
  { id: "potentiometer", label: "Potentiometer", prefix: "RV" },
  { id: "test_point", label: "Testpunkt", prefix: "TP" },
  { id: "other", label: "Andet / ukendt", prefix: "X" },
];

export function typeLabel(t: ComponentType): string {
  return COMPONENT_TYPES.find((c) => c.id === t)?.label ?? t;
}

export type ComponentStatus = "unknown" | "ok" | "suspect" | "faulty";

export const STATUS_LABELS: Record<ComponentStatus, string> = {
  unknown: "Ikke testet",
  ok: "OK",
  suspect: "Mistænkt",
  faulty: "Defekt",
};

export const STATUS_COLORS: Record<ComponentStatus, string> = {
  unknown: "#9aa4b2",
  ok: "#30d158",
  suspect: "#ffb020",
  faulty: "#ff453a",
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PcbComponent extends Rect {
  id: string;
  designator: string;
  type: ComponentType;
  value: string;
  status: ComponentStatus;
  notes: string;
  source: "ai" | "local" | "manual";
  confidence?: "high" | "medium" | "low";
  /** Synlig skade AI'en har bemærket (tom hvis ingen). */
  damage?: string;
  description?: string;
}

export interface Net {
  id: string;
  name: string;
  color: string;
  voltage: string;
  visible: boolean;
}

export interface Trace {
  id: string;
  netId: string;
  points: Point[];
}

export interface Probe {
  id: string;
  x: number;
  y: number;
  label: string;
  netId: string;
  expected: string;
  measured: string;
  notes: string;
  /** Hvad der måles. Standard er spænding. */
  kind?: "voltage" | "resistance";
  /** Seneste AI-fejlanalyse ud fra dette målepunkt. */
  ai?: ProbeAnalysis;
}

export interface ProbeAnalysis {
  atPoint: string;
  netName: string;
  netVoltage: string;
  /** Kobberbaner AI'en har fulgt fra målepunktet (projektkoordinater). */
  traces: { description: string; confidence: "high" | "medium" | "low"; points: Point[] }[];
  suspects: {
    /** Tom hvis komponenten ikke er markeret i projektet. */
    componentId: string;
    designator: string;
    relation: string;
    suspicion: "high" | "medium" | "low";
    reason: string;
    check: string;
  }[];
  summary: string;
  nextSteps: string[];
  model: string;
  at: number;
}

export type MeterMode = "dc_voltage" | "ac_voltage" | "resistance" | "continuity" | "diode" | "current";

export const METER_MODES: Record<MeterMode, { label: string; symbol: string; tip: string }> = {
  dc_voltage: {
    label: "DC-spænding",
    symbol: "V⎓",
    tip: "Drej multimeteret til V⎓. Sort ledning i COM, rød i VΩ. Strømmen skal være TIL. Hold proberne stille på metallet (pad, ben eller testpunkt).",
  },
  ac_voltage: {
    label: "AC-spænding",
    symbol: "V~",
    tip: "Drej til V~. Sort i COM, rød i VΩ. Pas på – AC på et print er ofte netspænding (230 V).",
  },
  resistance: {
    label: "Modstand",
    symbol: "Ω",
    tip: "Drej til Ω. Strømmen skal være FRA og store kondensatorer afladt. Kondensatorer kan få værdien til at stige langsomt – vent til den falder til ro. Måler man i kredsløbet, påvirker de andre komponenter resultatet.",
  },
  continuity: {
    label: "Gennemgang",
    symbol: "🔊",
    tip: "Drej til lydsymbolet (ofte samme position som diodetest). Strømmen skal være FRA. Bip = forbindelse (typisk under 30-50 Ω).",
  },
  diode: {
    label: "Diodetest",
    symbol: "⊳|",
    tip: "Drej til diodesymbolet. Strømmen skal være FRA. Rød på anode, sort på katode (stregen). 0,2-0,8 V er normalt i lederetningen, OL i spærreretningen. 0 V begge veje = kortsluttet.",
  },
  current: {
    label: "Strøm",
    symbol: "A",
    tip: "Flyt den røde ledning til A- eller mA-stikket! Multimeteret skal sidde I SERIE i kredsløbet (afbryd forbindelsen og mål hen over afbrydelsen). Start på højeste område. Flyt ledningen tilbage bagefter.",
  },
};

export type GuideGoal = "dead" | "short" | "hot" | "path" | "other";

export const GUIDE_GOALS: Record<GuideGoal, string> = {
  dead: "Kortet er dødt / mangler spænding",
  short: "Kortslutning (sikring springer, forsyning går i beskyttelse)",
  hot: "En komponent bliver varm",
  path: "Find strømvejen",
  other: "Anden fejl",
};

export interface GuidePoint {
  x: number;
  y: number;
  /** Hvor proben skal sættes, fx "ben 3 (udgang) på U1". */
  where: string;
}

export interface GuideStep {
  id: string;
  title: string;
  why: string;
  safety: string;
  power: "on" | "off";
  mode: MeterMode;
  range: string;
  red: GuidePoint;
  black: GuidePoint;
  expected: string;
  netName: string;
  /** Hvad forskellige resultater betyder. */
  outcomes: { result: string; meaning: string }[];
  /** Brugerens svar. */
  result?: string;
  skipped?: boolean;
  /** Det oprindelige svar, hvis brugeren har rettet det. */
  correctedFrom?: string;
  /** Målepunkt og strømvej der blev oprettet ud fra svaret (så de kan rettes med). */
  probeId?: string;
  traceId?: string;
  at: number;
}

export interface Guide {
  goal: GuideGoal;
  description: string;
  steps: GuideStep[];
  assessment: string;
  conclusion?: {
    summary: string;
    suspects: { componentId: string; designator: string; reason: string }[];
    fix: string;
  };
  model: string;
}

/** Et punkt AI'en peger på i et svar (projektkoordinater). */
export interface ChatPoint {
  x: number;
  y: number;
  label: string;
}

/** Spørgsmål og svar om målinger (uafhængigt af guidens skridt). */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Hvad spørgsmålet handler om, fx "Skridt 2: Mål modstand …" eller "Måling M1". */
  subject: string;
  points?: ChatPoint[];
  model?: string;
  at: number;
}

export interface AiPowerPath {
  name: string;
  voltage: string;
  description: string;
  /** Komponent-id'er i rækkefølge langs strømvejen. */
  componentIds: string[];
}

export interface AiResult {
  summary: string;
  powerNotes: string;
  powerPaths: AiPowerPath[];
  model: string;
  at: number;
}

/** Nærbillede af et udsnit af printet, placeret på oversigtsbilledet. */
export interface DetailPhoto {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Området på oversigtsbilledet som nærbilledet viser (samme højde/bredde-forhold som billedet). */
  region: Rect;
  created: number;
}

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  width: number;
  height: number;
  /** Tælles op når oversigtsbilledet ændres (fx beskæres), så andre enheder henter det igen. */
  imageVersion?: number;
  components: PcbComponent[];
  nets: Net[];
  traces: Trace[];
  probes: Probe[];
  /** Nærbilleder. Alle markeringer gemmes i oversigtsbilledets koordinater og vises på alle billeder. */
  photos?: DetailPhoto[];
  ai?: AiResult;
  /** Igangværende AI-fejlsøgningsguide. */
  guide?: Guide;
  /** Spørgsmål til AI om målinger og kortet. */
  chat?: ChatMessage[];
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export const NET_PRESETS: { name: string; color: string; voltage: string }[] = [
  { name: "VIN", color: "#ff3b30", voltage: "12V" },
  { name: "5V", color: "#ff9f0a", voltage: "5V" },
  { name: "3V3", color: "#ffd60a", voltage: "3.3V" },
  { name: "GND", color: "#5ac8fa", voltage: "0V" },
];

export const EXTRA_NET_COLORS = ["#bf5af2", "#ff375f", "#32d74b", "#64d2ff", "#ffffff", "#ac8e68"];
