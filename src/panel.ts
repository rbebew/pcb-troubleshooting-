import { h } from "./dom";
import type { Editor } from "./editor";
import { componentsAlongNet, probeVerdict } from "./geometry";
import {
  COMPONENT_TYPES,
  EXTRA_NET_COLORS,
  NET_PRESETS,
  STATUS_COLORS,
  STATUS_LABELS,
  typeLabel,
  uid,
  type ComponentStatus,
  type Net,
  type PcbComponent,
  type Probe,
  type Trace,
} from "./types";

export type Tab = "components" | "nets" | "probes" | "overview";

const STATUSES: ComponentStatus[] = ["unknown", "ok", "suspect", "faulty"];

export interface PanelHooks {
  runAi: () => void;
  runLocal: () => void;
  analyzeProbe: (probeId: string) => void;
}

/** Sidepanelet: lister og redigering af komponenter, strømveje og målinger. */
export class Panel {
  tab: Tab = "components";
  private filter = "";
  private lastEditAt = 0;
  private dirty = false;
  private statusFilter: ComponentStatus | "all" = "all";

  constructor(
    private root: HTMLElement,
    private ed: Editor,
    private hooks: PanelHooks,
  ) {
    // Mens man skriver gentegnes panelet ikke (fokus bevares); opdater listerne når feltet forlades.
    // Lille forsinkelse så et klik på et listeelement når at blive registreret først.
    root.addEventListener("change", (e) => {
      if ((e.target as HTMLElement).matches("input:not([type=checkbox]):not([type=color]):not([type=search]), textarea")) {
        setTimeout(() => this.render(), 300);
      }
    });
    // En gentegning der blev sprunget over mens man skrev, indhentes når man forlader feltet.
    root.addEventListener("focusout", () => {
      setTimeout(() => this.dirty && this.render(), 300);
    });
  }

  /** Bruges ved tekstfelter: opdater data uden at gentegne panelet (så fokus bevares). */
  private edit(fn: () => void): void {
    // Ét fortryd-trin pr. "redigeringsrunde" i stedet for pr. tastetryk.
    const now = Date.now();
    if (now - this.lastEditAt > 1500) this.ed.checkpoint();
    this.lastEditAt = now;
    fn();
    this.ed.requestDraw();
    this.ed.onChange();
  }

  render(): void {
    const sel = this.ed.selection;
    if (sel?.kind === "component") this.tab = "components";
    if (sel?.kind === "trace" || sel?.kind === "net") this.tab = "nets";
    if (sel?.kind === "probe") this.tab = "probes";

    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active) && active.matches("input[type=text],input:not([type]),textarea")) {
      // Brugeren skriver i et felt – undgå at smide fokus væk.
      this.dirty = true;
      return;
    }
    this.dirty = false;

    const scroll = this.root.querySelector(".panel-body")?.scrollTop ?? 0;
    const tabs: [Tab, string, number][] = [
      ["components", "Komponenter", this.ed.project.components.length],
      ["nets", "Strømveje", this.ed.project.nets.length],
      ["probes", "Målinger", this.ed.project.probes.length],
      ["overview", "Overblik", 0],
    ];
    const body = h("div", { class: "panel-body" });
    if (this.tab === "components") this.renderComponents(body);
    if (this.tab === "nets") this.renderNets(body);
    if (this.tab === "probes") this.renderProbes(body);
    if (this.tab === "overview") this.renderOverview(body);

    this.root.replaceChildren(
      h(
        "div",
        { class: "tabs", role: "tablist" },
        tabs.map(([id, label, n]) =>
          h(
            "button",
            {
              class: `tab ${this.tab === id ? "active" : ""}`,
              role: "tab",
              "aria-selected": String(this.tab === id),
              onclick: () => {
                this.tab = id;
                if (this.ed.selection && id !== this.tabFor(this.ed.selection.kind)) this.ed.select(null);
                this.render();
              },
            },
            label,
            n ? h("span", { class: "count" }, n) : null,
          ),
        ),
      ),
      body,
    );
    if (body.dataset.keepScroll !== "no") body.scrollTop = scroll;
  }

  private tabFor(kind: string): Tab {
    return kind === "component" ? "components" : kind === "probe" ? "probes" : "nets";
  }

  // ---------- Komponenter ----------

  private renderComponents(body: HTMLElement): void {
    const sel = this.ed.selection?.kind === "component" ? this.ed.component(this.ed.selection.id) : undefined;
    if (sel) body.append(this.componentForm(sel));

    const all = this.ed.project.components;
    if (!all.length) {
      body.append(
        h(
          "div",
          { class: "empty" },
          h("p", null, "Ingen komponenter endnu."),
          h("p", { class: "muted" }, "Lad AI finde dem, brug hurtig lokal søgning, eller tegn dem selv med værktøjet ", h("b", null, "Komponent"), "."),
          h("div", { class: "row" }, h("button", { class: "btn primary", onclick: this.hooks.runAi }, "✨ Find med AI"), h("button", { class: "btn", onclick: this.hooks.runLocal }, "Hurtig lokal søgning")),
        ),
      );
      return;
    }

    const q = this.filter.toLowerCase();
    const list = all.filter(
      (c) =>
        (this.statusFilter === "all" || c.status === this.statusFilter) &&
        (!q || `${c.designator} ${c.value} ${typeLabel(c.type)} ${c.notes} ${c.description ?? ""}`.toLowerCase().includes(q)),
    );
    list.sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.designator.localeCompare(b.designator, "da", { numeric: true }));

    const search = h("input", {
      type: "search",
      placeholder: "Søg (R12, 10k, regulator …)",
      value: this.filter,
      oninput: (e: Event) => {
        this.filter = (e.target as HTMLInputElement).value;
        const pos = (e.target as HTMLInputElement).selectionStart;
        (e.target as HTMLInputElement).blur();
        this.render();
        const s = this.root.querySelector<HTMLInputElement>("input[type=search]");
        s?.focus();
        if (pos !== null) s?.setSelectionRange(pos, pos);
      },
    });
    body.append(
      h(
        "div",
        { class: "list-tools" },
        search,
        h(
          "select",
          {
            "aria-label": "Filtrér på status",
            onchange: (e: Event) => {
              this.statusFilter = (e.target as HTMLSelectElement).value as ComponentStatus | "all";
              this.render();
            },
          },
          h("option", { value: "all", selected: this.statusFilter === "all" }, "Alle"),
          STATUSES.map((s) => h("option", { value: s, selected: this.statusFilter === s }, STATUS_LABELS[s])),
        ),
      ),
      h(
        "ul",
        { class: "list" },
        list.map((c) =>
          h(
            "li",
            {
              class: `item ${sel?.id === c.id ? "selected" : ""}`,
              onclick: () => {
                this.ed.select({ kind: "component", id: c.id });
                this.ed.centerOn(c);
              },
            },
            h("span", { class: "dot", style: `background:${STATUS_COLORS[c.status]}` }),
            h("span", { class: "item-main" }, h("b", null, c.designator || "–"), " ", h("span", { class: "muted" }, typeLabel(c.type)), c.value ? h("span", { class: "value" }, c.value) : null),
            c.damage ? h("span", { class: "warn", title: c.damage }, "⚠") : null,
          ),
        ),
      ),
    );
    if (list.length < all.length) body.append(h("p", { class: "muted small" }, `Viser ${list.length} af ${all.length}`));
  }

  private componentForm(c: PcbComponent): HTMLElement {
    const nets = this.ed.project.nets.filter((n) => componentsAlongNet(n.id, this.ed.project.traces, [c]).length > 0);
    return h(
      "div",
      { class: "card form" },
      h(
        "div",
        { class: "form-head" },
        h("h3", null, c.designator || "Komponent"),
        h("button", { class: "icon-btn", title: "Luk", "aria-label": "Luk", onclick: () => this.ed.select(null) }, "✕"),
      ),
      h(
        "div",
        { class: "status-row" },
        STATUSES.map((s) =>
          h(
            "button",
            {
              class: `status-btn ${c.status === s ? "on" : ""}`,
              style: `--c:${STATUS_COLORS[s]}`,
              onclick: () => {
                this.edit(() => (c.status = s));
                this.render();
              },
            },
            STATUS_LABELS[s],
          ),
        ),
      ),
      h(
        "div",
        { class: "grid2" },
        field("Betegnelse", h("input", { value: c.designator, placeholder: "fx R12", oninput: (e: Event) => this.edit(() => (c.designator = val(e))) })),
        field("Værdi / mærkning", h("input", { value: c.value, placeholder: "fx 10kΩ", oninput: (e: Event) => this.edit(() => (c.value = val(e))) })),
      ),
      field(
        "Type",
        h(
          "select",
          {
            onchange: (e: Event) => {
              this.edit(() => (c.type = val(e) as PcbComponent["type"]));
              this.render();
            },
          },
          COMPONENT_TYPES.map((t) => h("option", { value: t.id, selected: t.id === c.type }, t.label)),
        ),
      ),
      c.damage ? h("div", { class: "callout warn" }, h("b", null, "Synlig skade (AI): "), c.damage) : null,
      c.description ? h("p", { class: "muted small" }, c.description) : null,
      field("Noter / målinger", h("textarea", { rows: 3, placeholder: "fx 'Kortslutning mod GND', 'målt 9,8 kΩ'", oninput: (e: Event) => this.edit(() => (c.notes = val(e))) }, c.notes)),
      nets.length ? h("p", { class: "small" }, "På strømvej: ", nets.map((n) => h("span", { class: "chip", style: `--c:${n.color}` }, n.name))) : null,
      h(
        "div",
        { class: "row between" },
        h("span", { class: "muted small" }, sourceLabel(c)),
        h("button", { class: "btn danger small", onclick: () => this.ed.deleteSelection() }, "Slet"),
      ),
    );
  }

  // ---------- Strømveje ----------

  private renderNets(body: HTMLElement): void {
    const ed = this.ed;
    const sel = ed.selection;
    if (sel?.kind === "trace") {
      const t = ed.trace(sel.id);
      if (t) body.append(this.traceForm(t));
    }
    if (sel?.kind === "net") {
      const n = ed.net(sel.id);
      if (n) body.append(this.netForm(n));
    }

    body.append(
      h(
        "p",
        { class: "muted small" },
        "Vælg et net og tryk ",
        h("b", null, "Tegn"),
        ". Tryk på printet for at sætte punkter langs banen – fra kilden (fx stik eller regulator) mod lasten. Dobbelttryk eller ",
        h("b", null, "Færdig"),
        " afslutter.",
      ),
    );

    body.append(
      h(
        "ul",
        { class: "list" },
        ed.project.nets.map((n) => {
          const count = ed.project.traces.filter((t) => t.netId === n.id).length;
          return h(
            "li",
            { class: `item net ${sel?.kind === "net" && sel.id === n.id ? "selected" : ""} ${ed.activeNetId === n.id ? "active-net" : ""}` },
            h("input", {
              type: "checkbox",
              checked: n.visible,
              title: "Vis/skjul",
              "aria-label": `Vis ${n.name}`,
              onchange: (e: Event) => {
                this.edit(() => (n.visible = (e.target as HTMLInputElement).checked));
              },
            }),
            h("span", { class: "swatch", style: `background:${n.color}` }),
            h(
              "span",
              { class: "item-main", onclick: () => ed.select({ kind: "net", id: n.id }) },
              h("b", null, n.name),
              n.voltage ? h("span", { class: "value" }, n.voltage) : null,
              h("span", { class: "muted small" }, ` ${count} ${count === 1 ? "bane" : "baner"}`),
            ),
            h(
              "button",
              {
                class: `btn small ${ed.focusNetId === n.id ? "on" : ""}`,
                title: "Fremhæv kun denne strømvej",
                onclick: () => {
                  ed.focusNetId = ed.focusNetId === n.id ? null : n.id;
                  ed.requestDraw();
                  this.render();
                },
              },
              "Fokus",
            ),
            h(
              "button",
              {
                class: `btn small ${ed.activeNetId === n.id && ed.tool === "trace" ? "primary" : ""}`,
                onclick: () => {
                  ed.activeNetId = n.id;
                  if (!n.visible) n.visible = true;
                  ed.setTool("trace");
                },
              },
              "Tegn",
            ),
          );
        }),
      ),
    );

    const used = new Set(ed.project.nets.map((n) => n.name));
    const presets = NET_PRESETS.filter((p) => !used.has(p.name));
    body.append(
      h(
        "div",
        { class: "card" },
        h("h4", null, "Tilføj net"),
        presets.length
          ? h(
              "div",
              { class: "row wrap" },
              presets.map((p) => h("button", { class: "chip-btn", style: `--c:${p.color}`, onclick: () => this.addNet(p.name, p.color, p.voltage) }, `+ ${p.name}`)),
            )
          : null,
        h(
          "button",
          { class: "btn small", onclick: () => this.addNet(`Net ${ed.project.nets.length + 1}`, EXTRA_NET_COLORS[ed.project.nets.length % EXTRA_NET_COLORS.length], "") },
          "+ Eget net",
        ),
      ),
    );
  }

  private addNet(name: string, color: string, voltage: string): void {
    const ed = this.ed;
    ed.checkpoint();
    const n: Net = { id: uid(), name, color, voltage, visible: true };
    ed.project.nets.push(n);
    ed.activeNetId = n.id;
    ed.selection = { kind: "net", id: n.id };
    ed.changed();
    this.render();
  }

  private netForm(n: Net): HTMLElement {
    const ed = this.ed;
    const along = componentsAlongNet(n.id, ed.project.traces, ed.project.components);
    const probes = ed.project.probes.filter((p) => p.netId === n.id);
    return h(
      "div",
      { class: "card form" },
      h("div", { class: "form-head" }, h("h3", null, h("span", { class: "swatch", style: `background:${n.color}` }), " ", n.name), h("button", { class: "icon-btn", "aria-label": "Luk", onclick: () => ed.select(null) }, "✕")),
      h(
        "div",
        { class: "grid3" },
        field("Navn", h("input", { value: n.name, oninput: (e: Event) => this.edit(() => (n.name = val(e))) })),
        field("Spænding", h("input", { value: n.voltage, placeholder: "fx 5V", oninput: (e: Event) => this.edit(() => (n.voltage = val(e))) })),
        field("Farve", h("input", { type: "color", value: n.color, oninput: (e: Event) => this.edit(() => (n.color = val(e))) })),
      ),
      h("h4", null, "Følg strømvejen"),
      along.length
        ? h(
            "ol",
            { class: "path-list" },
            along.map((c) =>
              h(
                "li",
                null,
                h(
                  "button",
                  {
                    class: "link",
                    onclick: () => {
                      ed.centerOn(c);
                      ed.select({ kind: "component", id: c.id });
                    },
                  },
                  h("b", null, c.designator || typeLabel(c.type)),
                  c.value ? ` ${c.value}` : "",
                ),
                h(
                  "span",
                  { class: "mini-status" },
                  STATUSES.slice(1).map((s) =>
                    h(
                      "button",
                      {
                        class: `mini ${c.status === s ? "on" : ""}`,
                        style: `--c:${STATUS_COLORS[s]}`,
                        title: STATUS_LABELS[s],
                        "aria-label": `${c.designator}: ${STATUS_LABELS[s]}`,
                        onclick: () => {
                          this.edit(() => (c.status = c.status === s ? "unknown" : s));
                          this.render();
                        },
                      },
                      s === "ok" ? "✓" : s === "suspect" ? "?" : "✕",
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted small" }, "Ingen komponenter på denne strømvej endnu. Tegn en bane der går gennem komponenterne."),
      probes.length
        ? h(
            "div",
            null,
            h("h4", null, "Målinger"),
            h(
              "ul",
              { class: "plain" },
              probes.map((p) => h("li", null, verdictDot(p), ` ${p.label}: `, p.measured || "–", h("span", { class: "muted" }, ` (forventet ${p.expected || "?"})`))),
            ),
          )
        : null,
      h(
        "div",
        { class: "row between" },
        h(
          "button",
          {
            class: "btn small",
            onclick: () => {
              ed.focusNetId = ed.focusNetId === n.id ? null : n.id;
              ed.requestDraw();
              this.render();
            },
          },
          ed.focusNetId === n.id ? "Vis alle" : "Fokus",
        ),
        h(
          "button",
          {
            class: "btn danger small",
            onclick: () => {
              if (confirm(`Slet nettet "${n.name}" og alle dets baner?`)) ed.deleteSelection();
            },
          },
          "Slet net",
        ),
      ),
    );
  }

  private traceForm(t: Trace): HTMLElement {
    const ed = this.ed;
    return h(
      "div",
      { class: "card form" },
      h("div", { class: "form-head" }, h("h3", null, "Bane"), h("button", { class: "icon-btn", "aria-label": "Luk", onclick: () => ed.select(null) }, "✕")),
      field(
        "Tilhører net",
        h(
          "select",
          {
            onchange: (e: Event) => {
              this.edit(() => (t.netId = val(e)));
              this.render();
            },
          },
          ed.project.nets.map((n) => h("option", { value: n.id, selected: n.id === t.netId }, n.name)),
        ),
      ),
      h("p", { class: "muted small" }, `${t.points.length} punkter. Træk i de hvide firkanter for at flytte punkterne.`),
      h(
        "div",
        { class: "row between" },
        h(
          "button",
          {
            class: "btn small",
            onclick: () => {
              this.edit(() => t.points.reverse());
            },
          },
          "Vend retning",
        ),
        h("button", { class: "btn danger small", onclick: () => ed.deleteSelection() }, "Slet bane"),
      ),
    );
  }

  // ---------- Målinger ----------

  private renderProbes(body: HTMLElement): void {
    const ed = this.ed;
    const sel = ed.selection?.kind === "probe" ? ed.probe(ed.selection.id) : undefined;
    if (sel) body.append(this.probeForm(sel));
    if (!ed.project.probes.length) {
      body.append(
        h(
          "div",
          { class: "empty" },
          h("p", null, "Ingen målepunkter endnu."),
          h("p", { class: "muted" }, "Vælg værktøjet ", h("b", null, "Måling"), " og tryk hvor du har målt med multimeteret. Skriv forventet og målt spænding – punktet bliver grønt eller rødt."),
        ),
      );
      return;
    }
    body.append(
      h(
        "ul",
        { class: "list" },
        ed.project.probes.map((p) => {
          const n = ed.net(p.netId);
          return h(
            "li",
            {
              class: `item ${sel?.id === p.id ? "selected" : ""}`,
              onclick: () => {
                ed.select({ kind: "probe", id: p.id });
                ed.centerOn({ x: p.x - 20, y: p.y - 20, w: 40, h: 40 });
              },
            },
            verdictDot(p),
            h("span", { class: "item-main" }, h("b", null, p.label), n ? h("span", { class: "chip", style: `--c:${n.color}` }, n.name) : null),
            h("span", { class: "value" }, p.measured || "–"),
            h("span", { class: "muted small" }, p.expected ? `/ ${p.expected}` : ""),
          );
        }),
      ),
    );
  }

  private probeForm(p: Probe): HTMLElement {
    const ed = this.ed;
    const v = probeVerdict(p);
    return h(
      "div",
      { class: "card form" },
      h("div", { class: "form-head" }, h("h3", null, verdictDot(p), " Målepunkt"), h("button", { class: "icon-btn", "aria-label": "Luk", onclick: () => ed.select(null) }, "✕")),
      h(
        "div",
        { class: "grid2" },
        field("Navn", h("input", { value: p.label, oninput: (e: Event) => this.edit(() => (p.label = val(e))) })),
        field(
          "Net",
          h(
            "select",
            {
              onchange: (e: Event) => {
                this.edit(() => {
                  p.netId = val(e);
                  const n = ed.net(p.netId);
                  if (n && !p.expected) p.expected = n.voltage;
                });
                this.render();
              },
            },
            h("option", { value: "", selected: !p.netId }, "Intet"),
            ed.project.nets.map((n) => h("option", { value: n.id, selected: n.id === p.netId }, n.name)),
          ),
        ),
        field("Forventet", h("input", { value: p.expected, placeholder: "fx 3.3V", inputmode: "decimal", oninput: (e: Event) => this.edit(() => (p.expected = val(e))) })),
        field("Målt", h("input", { value: p.measured, placeholder: "fx 3.28V", inputmode: "decimal", oninput: (e: Event) => this.edit(() => (p.measured = val(e))) })),
      ),
      v === "bad" ? h("div", { class: "callout bad" }, "Målingen afviger mere end 10 % fra det forventede.") : null,
      v === "ok" ? h("div", { class: "callout good" }, "Målingen er inden for ±10 %.") : null,
      field(
        "Beskriv fejlen / noter",
        h("textarea", { rows: 2, placeholder: "fx 'Ingen 5V her, regulatoren bliver varm'", oninput: (e: Event) => this.edit(() => (p.notes = val(e))) }, p.notes),
      ),
      h(
        "div",
        { class: "row between" },
        h("button", { class: "btn primary small", onclick: () => this.hooks.analyzeProbe(p.id) }, p.ai ? "✨ Analysér igen" : "✨ Analysér fejlen herfra"),
        h("button", { class: "btn danger small", onclick: () => ed.deleteSelection() }, "Slet"),
      ),
      p.ai ? this.probeAnalysisView(p) : h("p", { class: "muted small" }, "AI følger de synlige kobberbaner fra punktet og peger på de komponenter, der mest sandsynligt forklarer målingen."),
    );
  }

  private probeAnalysisView(p: Probe): HTMLElement {
    const ed = this.ed;
    const a = p.ai!;
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const suspects = [...a.suspects].sort((x, y) => rank[x.suspicion] - rank[y.suspicion]);
    const suspColor = { high: "#ff453a", medium: "#ffb020", low: "#9aa4b2" } as const;
    const suspLabel = { high: "Høj", medium: "Middel", low: "Lav" } as const;
    return h(
      "div",
      { class: "ai-analysis" },
      h("h4", null, "AI-fejlanalyse"),
      h("p", null, a.summary),
      a.atPoint ? h("div", { class: "callout" }, h("b", null, "Ved punktet: "), a.atPoint) : null,
      a.netName ? h("p", { class: "small" }, "Sandsynligt net: ", h("b", null, a.netName), a.netVoltage ? ` (${a.netVoltage})` : "") : null,
      a.traces.length
        ? h(
            "div",
            { class: "row between" },
            h("span", { class: "small" }, h("span", { class: "dash-swatch" }), ` ${a.traces.length} ${a.traces.length === 1 ? "bane" : "baner"} fulgt (stiplet på billedet)`),
            h("button", { class: "btn small", onclick: () => this.tracesToNet(p) }, "Opret som strømvej"),
          )
        : h("p", { class: "muted small" }, "AI kunne ikke se kobberbanerne tydeligt fra dette punkt. Prøv et skarpere nærbillede i godt lys."),
      suspects.length ? h("h4", null, "Mulige fejlkilder") : null,
      h(
        "ul",
        { class: "plain suspects" },
        suspects.map((sp) => {
          const c = sp.componentId ? ed.component(sp.componentId) : undefined;
          return h(
            "li",
            null,
            h(
              "div",
              { class: "row between tight" },
              h(
                "span",
                null,
                h("span", { class: "dot", style: `background:${suspColor[sp.suspicion]}`, title: `Mistanke: ${suspLabel[sp.suspicion]}` }),
                " ",
                c
                  ? h(
                      "button",
                      {
                        class: "link",
                        onclick: () => {
                          ed.centerOn(c);
                          ed.select({ kind: "component", id: c.id });
                        },
                      },
                      h("b", null, c.designator || sp.designator || typeLabel(c.type)),
                    )
                  : h("b", null, sp.designator || "Ukendt komponent"),
                h("span", { class: "muted small" }, ` · ${suspLabel[sp.suspicion]} mistanke`),
              ),
              c && c.status !== "suspect" && c.status !== "faulty"
                ? h(
                    "button",
                    {
                      class: "btn small",
                      onclick: () => {
                        this.edit(() => (c.status = "suspect"));
                        this.render();
                      },
                    },
                    "Markér mistænkt",
                  )
                : null,
            ),
            h("div", { class: "small" }, sp.relation),
            h("div", { class: "small muted" }, sp.reason),
            sp.check ? h("div", { class: "small" }, h("b", null, "Test: "), sp.check) : null,
          );
        }),
      ),
      a.nextSteps.length ? h("h4", null, "Næste skridt") : null,
      a.nextSteps.length ? h("ol", { class: "tips" }, a.nextSteps.map((st) => h("li", null, st))) : null,
      h("p", { class: "muted small" }, `Analyseret med ${a.model}. AI kan tage fejl – især hvis banerne ikke er tydelige på fotoet.`),
    );
  }

  /** Gør AI'ens fulgte baner til rigtige strømveje. */
  private tracesToNet(p: Probe): void {
    const ed = this.ed;
    const a = p.ai;
    if (!a?.traces.length) return;
    ed.checkpoint();
    let net = ed.net(p.netId) ?? ed.project.nets.find((n) => a.netName && n.name.toLowerCase() === a.netName.toLowerCase());
    if (!net) {
      const name = a.netName || `Net ${ed.project.nets.length + 1}`;
      const preset = NET_PRESETS.find((x) => x.name.toLowerCase() === name.toLowerCase());
      net = {
        id: uid(),
        name,
        voltage: a.netVoltage || preset?.voltage || "",
        color: preset?.color ?? EXTRA_NET_COLORS[ed.project.nets.length % EXTRA_NET_COLORS.length],
        visible: true,
      };
      ed.project.nets.push(net);
    }
    for (const t of a.traces) ed.project.traces.push({ id: uid(), netId: net.id, points: t.points.map((q) => ({ ...q })) });
    a.traces = [];
    if (!p.netId) p.netId = net.id;
    ed.focusNetId = net.id;
    ed.changed();
    this.render();
  }

  // ---------- Overblik ----------

  private renderOverview(body: HTMLElement): void {
    const ed = this.ed;
    const p = ed.project;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, p.components.filter((c) => c.status === s).length])) as Record<ComponentStatus, number>;
    const badProbes = p.probes.filter((x) => probeVerdict(x) === "bad");
    const problems = p.components.filter((c) => c.status === "faulty" || c.status === "suspect" || c.damage);

    body.append(
      h(
        "div",
        { class: "stats" },
        STATUSES.map((s) => h("div", { class: "stat", style: `--c:${STATUS_COLORS[s]}` }, h("b", null, counts[s]), h("span", null, STATUS_LABELS[s]))),
      ),
    );

    if (problems.length || badProbes.length) {
      body.append(
        h(
          "div",
          { class: "card" },
          h("h4", null, "Fund"),
          h(
            "ul",
            { class: "plain" },
            problems.map((c) =>
              h(
                "li",
                null,
                h("span", { class: "dot", style: `background:${STATUS_COLORS[c.status]}` }),
                " ",
                h(
                  "button",
                  {
                    class: "link",
                    onclick: () => {
                      ed.centerOn(c);
                      ed.select({ kind: "component", id: c.id });
                    },
                  },
                  c.designator || typeLabel(c.type),
                ),
                ` – ${STATUS_LABELS[c.status]}`,
                c.damage ? h("span", { class: "muted" }, ` · ${c.damage}`) : null,
                c.notes ? h("span", { class: "muted" }, ` · ${c.notes}`) : null,
              ),
            ),
            badProbes.map((x) => h("li", null, verdictDot(x), ` ${x.label}: målt ${x.measured}, forventet ${x.expected}`)),
          ),
        ),
      );
    }

    const ai = p.ai;
    body.append(
      h(
        "div",
        { class: "card" },
        h("h4", null, "AI-analyse"),
        ai
          ? [
              ai.summary ? h("p", null, ai.summary) : null,
              ai.powerNotes ? h("div", { class: "callout" }, h("b", null, "Strømforsyning: "), ai.powerNotes) : null,
              ai.powerPaths.length ? h("h4", null, "Foreslåede strømveje") : null,
              ai.powerPaths.map((pp) => {
                const comps = pp.componentIds.map((id) => ed.component(id)).filter((c): c is PcbComponent => !!c);
                return h(
                  "div",
                  { class: "ai-path" },
                  h("div", { class: "row between" }, h("b", null, `${pp.name}${pp.voltage ? ` (${pp.voltage})` : ""}`), comps.length >= 2 ? h("button", { class: "btn small", onclick: () => this.createFromAi(pp.name, pp.voltage, comps) }, "Opret som strømvej") : null),
                  h("p", { class: "small" }, pp.description),
                  comps.length ? h("p", { class: "muted small" }, comps.map((c) => c.designator || typeLabel(c.type)).join(" → ")) : null,
                );
              }),
              h("p", { class: "muted small" }, `Analyseret med ${ai.model}. AI kan tage fejl – bekræft altid med målinger.`),
            ]
          : h("p", { class: "muted" }, "Ingen AI-analyse endnu."),
        h("div", { class: "row" }, h("button", { class: "btn primary small", onclick: this.hooks.runAi }, ai ? "Kør AI igen" : "✨ Analysér med AI")),
      ),
    );

    body.append(
      h(
        "div",
        { class: "card" },
        h("h4", null, "Fejlsøgningstips"),
        h(
          "ol",
          { class: "tips" },
          h("li", null, "Visuel inspektion: brændte, bulnede eller revnede komponenter og kolde lodninger."),
          h("li", null, "Uden strøm: mål modstand mellem hver forsyning og GND. Meget lav modstand tyder på kortslutning."),
          h("li", null, "Med strøm: følg strømvejen fra indgangen – sikring, beskyttelsesdiode, regulator – og mål spændingen ved hvert led."),
          h("li", null, "Hvor spændingen forsvinder mellem to målepunkter, sidder fejlen typisk i komponenterne imellem."),
        ),
      ),
    );
  }

  private createFromAi(name: string, voltage: string, comps: PcbComponent[]): void {
    const ed = this.ed;
    ed.checkpoint();
    let net = ed.project.nets.find((n) => n.name.toLowerCase() === name.toLowerCase());
    if (!net) {
      const preset = NET_PRESETS.find((p) => p.name.toLowerCase() === name.toLowerCase());
      net = { id: uid(), name, voltage, color: preset?.color ?? EXTRA_NET_COLORS[ed.project.nets.length % EXTRA_NET_COLORS.length], visible: true };
      ed.project.nets.push(net);
    }
    ed.project.traces.push({ id: uid(), netId: net.id, points: comps.map((c) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 })) });
    ed.focusNetId = net.id;
    ed.selection = { kind: "net", id: net.id };
    ed.changed();
    this.render();
  }
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", null, label), input);
}

function val(e: Event): string {
  return (e.target as HTMLInputElement).value;
}

function statusRank(s: ComponentStatus): number {
  return { faulty: 3, suspect: 2, unknown: 1, ok: 0 }[s];
}

function sourceLabel(c: PcbComponent): string {
  if (c.source === "ai") return `Fundet af AI${c.confidence ? ` (sikkerhed: ${{ high: "høj", medium: "middel", low: "lav" }[c.confidence]})` : ""}`;
  if (c.source === "local") return "Fundet af lokal søgning";
  return "Tilføjet manuelt";
}

function verdictDot(p: Probe): HTMLElement {
  const v = probeVerdict(p);
  return h("span", { class: "dot", style: `background:${v === "ok" ? "#30d158" : v === "bad" ? "#ff453a" : "#9aa4b2"}` });
}
