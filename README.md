# PCB Fejlsøgning

En web-app (virker på mobil og computer) til fejlsøgning af printkort:

1. **Tag et billede** af printkortet med telefonens kamera (eller vælg et fra galleriet).
2. **Find komponenterne** – automatisk med AI (Claude), med en hurtig offline-søgning, eller ved at tegne dem selv.
3. **Tegn strømvejene op** – fx VIN → sikring → regulator → 5V → lasten – med farve pr. net og pile der viser retningen.
4. **Fejlsøg** – marker komponenter som OK / Mistænkt / Defekt, sæt målepunkter med forventet og målt spænding, og følg strømvejen trin for trin.

Alt gemmes lokalt i browseren (IndexedDB). Intet sendes nogen steder hen, undtagen billedet til Anthropic når du selv beder om en AI-analyse.

## Funktioner

| | |
|---|---|
| 📷 **Kamera** | Åbner bagkameraet direkte på mobilen. Billeder roteres efter EXIF og skaleres til max 3000 px. |
| ✨ **AI-genkendelse** | Claude finder komponenter, læser betegnelser (R12, U3 …) og påtryk, vurderer typen, noterer **synlige skader** (brændt, bulnet, revnet) og foreslår strømvejene. |
| 🔍 **Offline-søgning** | Finder komponenter ud fra farveforskel til loddestopmasken – virker uden internet og API-nøgle. |
| ▢ **Manuel redigering** | Tegn, flyt og tilpas bokse; vælg type, betegnelse og værdi. |
| 〰 **Strømveje** | Tegn baner punkt for punkt med snap til andre baner, målepunkter og komponenter. Net med navn, farve og spænding (VIN, 5V, 3V3, GND …). |
| 🎯 **Fokus** | Fremhæv ét net og få en nummereret liste over komponenterne langs strømvejen, med hurtig-knapper til status. |
| ⊕ **Målinger** | Målepunkter med forventet/målt spænding – bliver grønne (±10 %) eller røde. |
| ↶ **Fortryd/gentag** | For alle ændringer. |
| ⬇ **Eksport** | Annoteret billede som PNG og hele projektet som JSON (kan importeres igen på en anden enhed). |
| 📱 **PWA** | Kan installeres på hjemmeskærmen og virker offline (undtagen AI). |

## Brug af AI

Åbn ⚙ **Indstillinger** og indsæt en Anthropic API-nøgle fra [console.anthropic.com](https://console.anthropic.com/settings/keys).
Nøglen gemmes kun i din browser og sendes direkte til Anthropic. Da nøglen ligger i browseren, bør du bruge en nøgle med
et forbrugsloft og ikke dele enheden med andre.

Standardmodellen er Claude Opus 5.5. Sonnet 5.5 (hurtigere) og Haiku 5.5 (billigst) kan vælges i indstillingerne.

AI kan tage fejl – især på små SMD-komponenter og ved positionering af boksene. Brug det som udgangspunkt og bekræft altid med målinger.

## Betjening

| Handling | Mobil | Computer |
|---|---|---|
| Zoom | Knib med to fingre | Scrollhjul / knapperne + − |
| Panorér | Træk med én finger (eller to) | Træk på tom flade / højre-træk |
| Afslut strømvej | Dobbelttryk eller **Færdig** | Dobbeltklik / Enter |
| Fortryd sidste punkt | **↶ Punkt** | Backspace |
| Slet valgt | **Slet** i panelet | Delete |
| Værktøjer | Bundlinjen | Tasterne 1–4 |
| Fortryd / gentag | ↶ ↷ | Ctrl+Z / Ctrl+Y |

## Udvikling

```bash
npm install
npm run dev      # udviklingsserver på http://localhost:5173
npm test         # enhedstests (vitest)
npm run build    # produktion i dist/
```

Kameraet kræver HTTPS (eller localhost). Vil du teste på telefonen under udvikling, så kør `npm run dev -- --host`
og brug fx en tunnel med HTTPS, eller vælg billedet fra galleriet.

### Udgivelse på GitHub Pages

Workflowet `.github/workflows/deploy.yml` bygger og udgiver appen ved push til `main`.
Slå det til under **Settings → Pages → Source: GitHub Actions**. Appen ligger derefter på
`https://<bruger>.github.io/<repo>/`.

### Struktur

```
src/
  main.ts         Forside, dialoger, eksport, tastatur
  editor.ts       Canvas: zoom/pan, værktøjer, tegning, fortryd
  panel.ts        Sidepanel: komponenter, strømveje, målinger, overblik
  ai.ts           Komponent-genkendelse med Claude (struktureret output)
  localDetect.ts  Offline komponent-søgning (farve-segmentering)
  geometry.ts     Geometri, spændingsfortolkning, komponenter langs net
  store.ts        IndexedDB-lager og indstillinger
  image.ts        Indlæsning/skalering af billeder
  types.ts        Datamodel
tests/            Vitest-tests
public/           Ikoner, manifest og service worker
```
