import { h } from "./dom";
import type { Editor } from "./editor";
import { GUIDE_GOALS, METER_MODES, typeLabel, type Guide, type GuideGoal, type GuideStep, type MeterMode } from "./types";

export interface GuideHooks {
  startGuide: (goal: GuideGoal, description: string) => void;
  answerGuide: (result: string, skipped: boolean) => void;
  /** Ret svaret på et tidligere skridt; AI vurderer derefter situationen igen. */
  correctGuideAnswer: (stepId: string, result: string) => void;
  continueGuide: () => void;
  retryGuide: () => void;
  endGuide: () => void;
  /** Stil AI et spørgsmål om et emne ("step:<id>", "probe:<id>" eller "general"). */
  askAi: (question: string, subject: string) => void;
  /** Vis de steder et svar henviser til på billedet. */
  showChatPoints: (messageId: string) => void;
  /** Lad guiden planlægge det næste skridt forfra ud fra et svar. */
  useAnswerInGuide: (messageId: string) => void;
  clearChat: () => void;
}

/** Hurtigsvar der passer til multimeterets indstilling. */
const QUICK_ANSWERS: Record<MeterMode, string[]> = {
  dc_voltage: ["0 V"],
  ac_voltage: ["0 V"],
  resistance: ["0 Ω (kortslutning)", "OL (åben / uendelig)"],
  continuity: ["Bip", "Intet bip"],
  diode: ["OL", "0 V (kortsluttet)"],
  current: ["0 A"],
};

let selectedGoal: GuideGoal = "dead";
/** Hvad det næste spørgsmål handler om. Null = automatisk (det aktuelle skridt eller generelt). */
let chatSubject: string | null = null;
let chatDraft = "";

/** Vælg emnet for næste spørgsmål (bruges fx fra et målepunkt i Målinger-fanen). */
export function setChatSubject(subject: string): void {
  chatSubject = subject;
}

/** Skridt hvis svar er ved at blive rettet. */
let editingStepId: string | null = null;
let draftDescription = "";

/** Viser begge probepunkter med luft omkring, så man kan se hvor på printet de sidder. */
export function frameGuideStep(ed: Editor, step: GuideStep): void {
  const dist = Math.hypot(step.red.x - step.black.x, step.red.y - step.black.y);
  const pad = Math.max(dist * 0.6, 40 / ed.k);
  const x0 = Math.min(step.red.x, step.black.x) - pad;
  const y0 = Math.min(step.red.y, step.black.y) - pad;
  ed.centerOn({ x: x0, y: y0, w: Math.abs(step.red.x - step.black.x) + 2 * pad, h: Math.abs(step.red.y - step.black.y) + 2 * pad });
}

/** Det skridt brugeren skal måle nu (sidste skridt uden svar). */
export function currentGuideStep(g: Guide | undefined): GuideStep | undefined {
  if (!g || g.conclusion) return undefined;
  const last = g.steps[g.steps.length - 1];
  return last && last.result === undefined ? last : undefined;
}

export function renderGuide(body: HTMLElement, ed: Editor, hooks: GuideHooks, rerender: () => void): void {
  const g = ed.project.guide;
  if (!g) {
    body.append(startCard(hooks, rerender), chatCard(ed, hooks, rerender), meterHelp());
    return;
  }
  renderActiveGuide(body, ed, g, hooks, rerender, chatCard(ed, hooks, rerender));
}

function renderActiveGuide(body: HTMLElement, ed: Editor, g: Guide, hooks: GuideHooks, rerender: () => void, chat: HTMLElement): void {

  if (g.assessment) body.append(h("div", { class: "callout" }, h("b", null, "Status: "), g.assessment));

  const step = currentGuideStep(g);
  if (step) body.append(stepCard(ed, step, g.steps.length, hooks));
  else if (g.conclusion) body.append(conclusionCard(ed, g, hooks));
  else
    body.append(
      h(
        "div",
        { class: "card" },
        h("p", null, "Klar til næste skridt."),
        h("button", { class: "btn primary small", onclick: hooks.retryGuide }, "✨ Hent næste skridt"),
      ),
    );
  // Spørg AI lige under det aktuelle skridt, så man ikke skal scrolle forbi historikken.
  body.append(chat);

  const done = g.steps.filter((s) => s.result !== undefined);
  if (done.length) {
    body.append(
      h("h4", null, "Målinger i denne guide"),
      h(
        "ol",
        { class: "guide-history" },
        done.map((s) =>
          editingStepId === s.id
            ? h("li", null, correctionForm(s, hooks, rerender))
            : h(
                "li",
                null,
                h("span", { class: "meter-chip" }, METER_MODES[s.mode].symbol),
                " ",
                s.title,
                h(
                  "div",
                  { class: "small row between tight" },
                  h(
                    "span",
                    null,
                    h("b", null, s.skipped ? `Ikke målt${s.result ? ` (${s.result})` : ""}` : s.result),
                    h("span", { class: "muted" }, ` · forventet ${s.expected}`),
                    s.correctedFrom !== undefined ? h("span", { class: "muted" }, ` · rettet fra "${s.correctedFrom}"`) : null,
                  ),
                  h(
                    "button",
                    {
                      class: "link small",
                      title: "Ret målingen hvis du har målt forkert",
                      onclick: () => {
                        editingStepId = s.id;
                        rerender();
                      },
                    },
                    "✎ Ret",
                  ),
                ),
              ),
        ),
      ),
    );
  }

  body.append(
    h(
      "div",
      { class: "row between" },
      h("span", { class: "muted small" }, `${GUIDE_GOALS[g.goal]}${g.model ? ` · ${g.model}` : ""}`),
      h("button", { class: "btn danger small", onclick: hooks.endGuide }, "Afslut guide"),
    ),
  );
}

/** Formular til at rette et tidligere svar. */
/** "Spørg AI": spørgsmål om en måling, et skridt eller kortet – uden at det tæller som et måleresultat. */
function chatCard(ed: Editor, hooks: GuideHooks, rerender: () => void): HTMLElement {
  const p = ed.project;
  const g = p.guide;
  const current = currentGuideStep(g);
  const options: [string, string][] = [];
  if (current) options.push([`step:${current.id}`, `Det aktuelle skridt: ${current.title}`]);
  g?.steps.forEach((st, i) => {
    if (st !== current) options.push([`step:${st.id}`, `Skridt ${i + 1}: ${st.title}${st.result !== undefined ? ` (${st.skipped ? "ikke målt" : st.result})` : ""}`]);
  });
  p.probes.forEach((pr) => options.push([`probe:${pr.id}`, `Måling ${pr.label}${pr.measured ? `: ${pr.measured}` : ""}${pr.expected ? ` (forventet ${pr.expected})` : ""}`]));
  options.push(["general", "Kortet generelt"]);
  const valid = chatSubject && options.some(([v]) => v === chatSubject);
  const subject = valid ? chatSubject! : options[0][0];

  const select = h(
    "select",
    {
      "aria-label": "Hvad handler spørgsmålet om?",
      onchange: (e: Event) => {
        chatSubject = (e.target as HTMLSelectElement).value;
      },
    },
    options.map(([v, label]) => h("option", { value: v, selected: v === subject }, label)),
  );
  const input = h(
    "textarea",
    {
      rows: 2,
      autocomplete: "off",
      placeholder: "fx 'Er 22,6k normalt her?', 'Hvor finder jeg GND?', 'Hvorfor stiger værdien?'",
      oninput: (e: Event) => (chatDraft = (e.target as HTMLTextAreaElement).value),
    },
    chatDraft,
  );
  const send = () => {
    const q = input.value.trim();
    if (!q) return;
    chatDraft = "";
    chatSubject = select.value;
    hooks.askAi(q, select.value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !(navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile) {
      e.preventDefault();
      send();
    }
  });

  const messages = p.chat ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return h(
    "div",
    { class: "card chat" },
    h("h3", null, "💬 Spørg AI"),
    h("p", { class: "muted small" }, "Spørg om en måling, et skridt eller kortet. Spørgsmålet tæller ikke som et måleresultat."),
    messages.length
      ? h(
          "div",
          { class: "chat-log" },
          messages.map((m) =>
            h(
              "div",
              { class: `msg ${m.role}` },
              h("div", { class: "msg-subject" }, m.role === "user" ? `Om: ${m.subject}` : "AI"),
              h("div", { class: "msg-text" }, m.text),
              m.role === "assistant"
                ? h(
                    "div",
                    { class: "row wrap tight" },
                    m.points?.length ? h("button", { class: "link small", onclick: () => hooks.showChatPoints(m.id) }, `📍 Vis ${m.points.length === 1 ? "stedet" : `de ${m.points.length} steder`} på billedet`) : null,
                    m.points?.length && ed.highlights.length && m === lastAssistant
                      ? h(
                          "button",
                          {
                            class: "link small",
                            onclick: () => {
                              ed.highlights = [];
                              ed.requestDraw();
                              rerender();
                            },
                          },
                          "Skjul",
                        )
                      : null,
                    g && m === lastAssistant && !g.conclusion
                      ? h("button", { class: "link small", onclick: () => hooks.useAnswerInGuide(m.id) }, "↻ Lad guiden tage højde for svaret")
                      : null,
                  )
                : null,
            ),
          ),
        )
      : null,
    h("label", { class: "field" }, h("span", null, "Spørgsmålet handler om"), select),
    input,
    h(
      "div",
      { class: "row between" },
      messages.length
        ? h(
            "button",
            {
              class: "link small",
              onclick: () => {
                if (confirm("Slet samtalen?")) hooks.clearChat();
                rerender();
              },
            },
            "Ryd samtale",
          )
        : h("span"),
      h("button", { class: "btn primary small", onclick: send }, "Send ›"),
    ),
  );
}

function correctionForm(s: GuideStep, hooks: GuideHooks, rerender: () => void): HTMLElement {
  const input = h("textarea", { rows: 2, autocomplete: "off", "aria-label": "Rettet måleresultat" }, s.skipped ? "" : (s.result ?? ""));
  const save = (v: string) => {
    if (!v.trim()) return;
    editingStepId = null;
    hooks.correctGuideAnswer(s.id, v.trim());
  };
  setTimeout(() => input.focus());
  return h(
    "div",
    { class: "card correction" },
    h("div", { class: "small muted" }, `Ret måling: ${s.title}`),
    h("div", { class: "small" }, h("span", { class: "probe-dot red" }, "+"), s.red.where, " · ", h("span", { class: "probe-dot black" }, "−"), s.black.where),
    input,
    h(
      "div",
      { class: "row wrap tight" },
      QUICK_ANSWERS[s.mode].map((q) => h("button", { class: "chip-btn neutral", onclick: () => save(q) }, q)),
    ),
    h(
      "div",
      { class: "row between" },
      h(
        "button",
        {
          class: "btn small",
          onclick: () => {
            editingStepId = null;
            rerender();
          },
        },
        "Annullér",
      ),
      h("button", { class: "btn primary small", onclick: () => save(input.value) }, "Gem rettelse"),
    ),
    h("p", { class: "muted small" }, "AI får besked om rettelsen og vurderer næste skridt igen."),
  );
}

function startCard(hooks: GuideHooks, rerender: () => void): HTMLElement {
  const desc = h(
    "textarea",
    {
      rows: 3,
      placeholder: "fx 'Kortet var tændt da det røg, nu sker der intet. 12V-adapteren virker.'",
      oninput: (e: Event) => (draftDescription = (e.target as HTMLTextAreaElement).value),
    },
    draftDescription,
  );
  return h(
    "div",
    { class: "card" },
    h("h3", null, "🧭 Fejlsøgningsguide"),
    h(
      "p",
      { class: "muted small" },
      "AI guider dig med multimeteret ét skridt ad gangen: hvor den røde og den sorte probe skal sættes (vist på billedet), hvilken indstilling, om strømmen skal være til, og hvad du bør måle. Du skriver resultatet, og AI vælger næste skridt – indtil fejlen er fundet.",
    ),
    h("h4", null, "Hvad er problemet?"),
    h(
      "div",
      { class: "goal-list" },
      (Object.keys(GUIDE_GOALS) as GuideGoal[]).map((id) =>
        h(
          "label",
          { class: `goal ${selectedGoal === id ? "on" : ""}` },
          h("input", {
            type: "radio",
            name: "guide-goal",
            checked: selectedGoal === id,
            onchange: () => {
              selectedGoal = id;
              rerender();
            },
          }),
          GUIDE_GOALS[id],
        ),
      ),
    ),
    h("label", { class: "field" }, h("span", null, "Beskriv fejlen (valgfrit, men hjælper meget)"), desc),
    h(
      "button",
      {
        class: "btn primary",
        onclick: () => {
          hooks.startGuide(selectedGoal, desc.value);
          draftDescription = "";
        },
      },
      "✨ Start guiden",
    ),
  );
}

function stepCard(ed: Editor, step: GuideStep, n: number, hooks: GuideHooks): HTMLElement {
  const m = METER_MODES[step.mode];
  // Almindeligt tekstfelt (ikke tal-tastatur), så man kan skrive enheder som k og Ω – og et rigtigt svar,
  // fx "22,6 kΩ, men værdien stiger stadig" eller "kan ikke finde testpunktet, men ...".
  const input = h("textarea", {
    rows: 2,
    placeholder: "Skriv målingen eller et svar, fx '22,6k – stiger langsomt' eller 'kan ikke finde testpunktet'",
    autocomplete: "off",
    "aria-label": "Måleresultat eller svar",
  });
  const send = (v: string) => {
    if (v.trim()) hooks.answerGuide(v.trim(), false);
  };
  input.addEventListener("keydown", (e) => {
    // Enter sender på computer; Shift+Enter giver ny linje. På mobil bruges Næste-knappen.
    if (e.key === "Enter" && !e.shiftKey && !(navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile) {
      e.preventDefault();
      send(input.value);
    }
  });
  const center = () => frameGuideStep(ed, step);
  return h(
    "div",
    { class: "card step-card" },
    h("div", { class: "muted small" }, `Skridt ${n}`),
    h("h3", null, step.title),
    h(
      "div",
      { class: "row wrap tight" },
      h("span", { class: `badge ${step.power === "on" ? "power-on" : "power-off"}` }, step.power === "on" ? "🔌 Strøm TIL" : "⛔ Strøm FRA"),
      h("span", { class: "badge meter" }, `${m.symbol} ${m.label}${step.range ? ` · ${step.range}` : ""}`),
    ),
    step.safety ? h("div", { class: "callout bad" }, h("b", null, "⚠ Sikkerhed: "), step.safety) : null,
    h(
      "div",
      { class: "probe-rows" },
      h("div", null, h("span", { class: "probe-dot red" }, "+"), h("b", null, "Rød probe: "), step.red.where),
      h("div", null, h("span", { class: "probe-dot black" }, "−"), h("b", null, "Sort probe: "), step.black.where),
      h("button", { class: "link small", onclick: center }, "Vis på billedet"),
    ),
    h("p", null, h("b", null, "Forventet: "), step.expected),
    h("p", { class: "small muted" }, step.why),
    step.outcomes.length
      ? h(
          "details",
          null,
          h("summary", null, "Hvad betyder resultatet?"),
          h("ul", { class: "plain" }, step.outcomes.map((o) => h("li", { class: "small" }, h("b", null, `${o.result}: `), o.meaning))),
        )
      : null,
    h("details", null, h("summary", null, `Sådan stiller du multimeteret (${m.symbol})`), h("p", { class: "small" }, m.tip)),
    h("label", { class: "field" }, h("span", null, "Hvad viser multimeteret? (eller skriv et svar/spørgsmål til AI)"), input),
    h(
      "div",
      { class: "row wrap tight" },
      QUICK_ANSWERS[step.mode].map((q) => h("button", { class: "chip-btn neutral", onclick: () => send(q) }, q)),
      h("button", { class: "btn primary small", onclick: () => send(input.value) }, "Næste ›"),
    ),
    h(
      "button",
      {
        class: "link small",
        onclick: () => {
          const why = prompt("Hvorfor kunne du ikke måle her? (fx 'kan ikke komme til benet')", "") ?? "";
          hooks.answerGuide(why, true);
        },
      },
      "Kunne ikke måle her",
    ),
  );
}

function conclusionCard(ed: Editor, g: Guide, hooks: GuideHooks): HTMLElement {
  const c = g.conclusion!;
  return h(
    "div",
    { class: "card conclusion" },
    h("h3", null, "✅ Konklusion"),
    h("p", null, c.summary),
    c.suspects.length
      ? h(
          "ul",
          { class: "plain suspects" },
          c.suspects.map((sp) => {
            const comp = sp.componentId ? ed.component(sp.componentId) : undefined;
            return h(
              "li",
              null,
              h(
                "div",
                { class: "row between tight" },
                comp
                  ? h(
                      "button",
                      {
                        class: "link",
                        onclick: () => {
                          ed.centerOn(comp);
                          ed.select({ kind: "component", id: comp.id });
                        },
                      },
                      h("b", null, comp.designator || sp.designator || typeLabel(comp.type)),
                    )
                  : h("b", null, sp.designator || "Ukendt komponent"),
                comp && comp.status !== "faulty"
                  ? h(
                      "button",
                      {
                        class: "btn small",
                        onclick: () => {
                          ed.checkpoint();
                          comp.status = "faulty";
                          ed.changed();
                        },
                      },
                      "Markér defekt",
                    )
                  : null,
              ),
              h("div", { class: "small muted" }, sp.reason),
            );
          }),
        )
      : null,
    c.fix ? h("div", { class: "callout good" }, h("b", null, "Gør dette: "), c.fix) : null,
    h(
      "div",
      { class: "row wrap" },
      h("button", { class: "btn small", onclick: hooks.continueGuide }, "Fortsæt med flere målinger"),
    ),
  );
}

function meterHelp(): HTMLElement {
  return h(
    "details",
    { class: "card" },
    h("summary", null, h("b", null, "Multimeter – kort fortalt")),
    h(
      "ul",
      { class: "plain" },
      (Object.keys(METER_MODES) as MeterMode[]).map((k) =>
        h("li", { class: "small" }, h("b", null, `${METER_MODES[k].symbol} ${METER_MODES[k].label}: `), METER_MODES[k].tip),
      ),
    ),
  );
}
