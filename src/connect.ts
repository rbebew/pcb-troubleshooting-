import QRCode from "qrcode";
import { $, formatDate, h, toast } from "./dom";
import { pairUrl, sync, type SyncEvent } from "./sync";

/** Dialogen "Forbind enheder": parring med QR-kode/kode og liste over parrede enheder. */

let pairCode: string | null = null;
let joining = false;
let stopListening: (() => void) | null = null;

export function openConnectDialog(): void {
  const dlg = $("#connect-dialog") as HTMLDialogElement;
  sync.start();
  stopListening?.();
  stopListening = sync.on((e: SyncEvent) => {
    if (e.type === "paired") {
      pairCode = null;
      toast(`✓ Forbundet med ${e.name}`);
    }
    if (dlg.open) render();
  });
  render();
  if (!dlg.open) dlg.showModal();
  dlg.addEventListener(
    "close",
    () => {
      sync.cancelPairing();
      pairCode = null;
      stopListening?.();
      stopListening = null;
    },
    { once: true },
  );
}

/** Kaldes når appen åbnes via en parrings-QR-kode (#pair=...). */
export async function joinWithCode(code: string): Promise<void> {
  if (joining) return;
  joining = true;
  toast("Forbinder …");
  try {
    const name = await sync.join(code);
    toast(`✓ Forbundet med ${name}. Billeder og markeringer synkroniseres nu automatisk.`, "info", 6000);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error", 8000);
  } finally {
    joining = false;
    const dlg = $("#connect-dialog") as HTMLDialogElement;
    if (dlg.open) render();
  }
}

function statusText(): { cls: string; text: string } {
  const online = sync.onlineCount;
  if (sync.state === "error") return { cls: "bad", text: sync.error };
  if (sync.state === "connecting" || sync.state === "off") return { cls: "wait", text: "Forbinder til netværket …" };
  if (online) return { cls: "good", text: `Forbundet – synkroniserer med ${online} ${online === 1 ? "enhed" : "enheder"}` };
  return { cls: "wait", text: "Klar – venter på den anden enhed" };
}

function render(): void {
  const body = $("#connect-body");
  const st = statusText();
  const devices = sync.devices();

  const nameInput = h("input", {
    value: sync.device.name,
    maxlength: 40,
    onchange: (e: Event) => sync.rename((e.target as HTMLInputElement).value),
  });

  const qrBox = h("div", { class: "qr-box" });
  if (pairCode) {
    const url = pairUrl(pairCode);
    const canvas = h("canvas", { "aria-label": "QR-kode til parring" });
    QRCode.toCanvas(canvas, url, { width: 220, margin: 1 }).catch(() => {});
    qrBox.append(
      canvas,
      h("div", { class: "pair-code" }, pairCode),
      h(
        "p",
        { class: "muted small" },
        "Scan QR-koden med den anden enheds kamera – eller åbn appen på den og indtast koden under ",
        h("b", null, "Har du en kode?"),
        ". Koden virker én gang i 10 minutter.",
      ),
    );
  } else {
    qrBox.append(
      h(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () => {
            pairCode = sync.startPairing();
            render();
          },
        },
        "Vis QR-kode",
      ),
      h("p", { class: "muted small" }, "Typisk på computeren – så scanner du koden med mobilen."),
    );
  }

  const codeInput = h("input", { placeholder: "ABCD-EFGH-K7M2Q9", autocapitalize: "characters", autocomplete: "off", spellcheck: "false" });
  codeInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); // ellers lukker formularen dialogen
    if (codeInput.value.trim()) joinWithCode(codeInput.value.trim());
  });
  const joinBtn = h(
    "button",
    {
      class: "btn",
      type: "button",
      disabled: joining,
      onclick: () => {
        const v = codeInput.value.trim();
        if (v) joinWithCode(v);
      },
    },
    joining ? "Forbinder …" : "Forbind",
  );

  const children: (Node | null)[] = [
    h("div", { class: `sync-status ${st.cls}` }, h("span", { class: "dot" }), st.text),
    h("label", { class: "field" }, h("span", null, "Navn på denne enhed"), nameInput),
    devices.length
      ? h(
          "div",
          null,
          h("h4", null, "Parrede enheder"),
          h(
            "ul",
            { class: "list" },
            devices.map((d) =>
              h(
                "li",
                { class: "item static" },
                h("span", { class: "dot", style: `background:${d.online ? "#30d158" : "#9aa4b2"}` }),
                h(
                  "span",
                  { class: "item-main" },
                  h("b", null, d.name),
                  h("span", { class: "muted small" }, d.online ? " · online" : d.lastSeen ? ` · sidst set ${formatDate(d.lastSeen)}` : " · offline"),
                ),
                h(
                  "button",
                  {
                    class: "btn small danger",
                    type: "button",
                    onclick: () => {
                      if (confirm(`Fjern parringen med ${d.name}?`)) {
                        sync.unpair(d.id);
                        render();
                      }
                    },
                  },
                  "Fjern",
                ),
              ),
            ),
          ),
        )
      : null,
    h("h4", null, devices.length ? "Tilføj endnu en enhed" : "Par med en anden enhed"),
    h("div", { class: "pair-grid" }, h("div", { class: "card" }, h("b", null, "Vis kode her"), qrBox), h("div", { class: "card" }, h("b", null, "Har du en kode?"), h("div", { class: "row" }, codeInput, joinBtn))),
    h(
      "p",
      { class: "muted small" },
      "Billeder og markeringer sendes krypteret direkte mellem enhederne (WebRTC). Begge enheder skal have appen åben for at synkronisere.",
    ),
  ];
  body.replaceChildren(...children.filter((c): c is Node => c !== null));
}
