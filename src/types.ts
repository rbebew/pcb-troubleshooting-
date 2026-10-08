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
  components: PcbComponent[];
  nets: Net[];
  traces: Trace[];
  probes: Probe[];
  /** Nærbilleder. Alle markeringer gemmes i oversigtsbilledets koordinater og vises på alle billeder. */
  photos?: DetailPhoto[];
  ai?: AiResult;
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
