# PCB Fejlsøgning

En web-app (virker på mobil og computer) til fejlsøgning af printkort:

1. **Tag et billede** af printkortet med telefonens kamera (eller vælg et fra galleriet) – og evt. **nærbilleder** af de områder hvor du skal se detaljer.
2. **Find komponenterne** – automatisk med AI (Claude), med en hurtig offline-søgning, eller ved at tegne dem selv.
3. **Tegn strømvejene op** – fx VIN → sikring → regulator → 5V → lasten – med farve pr. net og pile der viser retningen.
4. **Fejlsøg** – marker komponenter som OK / Mistænkt / Defekt, sæt målepunkter med forventet og målt spænding, og følg strømvejen trin for trin.

Alt gemmes lokalt i browseren (IndexedDB). Mobil og computer kan **parres med en QR-kode**, så billeder du tager på mobilen
straks dukker op på computeren, og markeringer synkroniseres begge veje.

## Funktioner

| | |
|---|---|
| 📷 **Kamera** | Åbner bagkameraet direkte på mobilen. Billeder roteres efter EXIF og skaleres til max 3000 px. |
| ✨ **AI-genkendelse** | Claude finder komponenter, læser betegnelser (R12, U3 …) og påtryk, vurderer typen, noterer **synlige skader** (brændt, bulnet, revnet) og foreslår strømvejene. |
| 🩺 **AI-fejlanalyse fra målepunkt** | Sæt et målepunkt hvor du har målt fejlen, skriv forventet/målt spænding og hvad der er galt, og tryk **✨ Analysér fejlen herfra**. AI følger de synlige kobberbaner fra punktet (vist stiplet), finder de forbundne komponenter, rangerer de mest sandsynlige fejlkilder og foreslår næste målinger. Banerne kan med ét tryk gøres til en rigtig strømvej. Analysen bruger automatisk det skarpeste nærbillede der viser punktet. |
| 🔎 **Nærbilleder** | Tag et overbliksbillede og derefter nærbilleder af sektioner. Hvert nærbillede lægges (halvgennemsigtigt) over det sted på oversigten det viser. Alle markeringer deles – en komponent tegnet på et nærbillede vises også på oversigten, og strømveje tegnet på oversigten vises på nærbillederne. AI på et nærbillede læser små SMD-mærkninger meget bedre. |
| 🔗 **Forbind enheder** | Par mobil og computer med en QR-kode. Billeder, nærbilleder, komponenter, strømveje og målinger synkroniseres automatisk, direkte mellem enhederne. |
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

## Nærbilleder

1. Tag først et billede af hele printet (oversigten).
2. Tryk **＋ Nærbillede** øverst i billedet og tag et nærbillede af et område – hold telefonen på samme led som ved oversigten.
3. Læg nærbilledet over det rigtige sted: træk for at flytte, træk i hjørnerne for at skalere, brug ◐ til gennemsigtighed og ↻ hvis billedet er drejet. Tryk **Gem placering**.
4. Skift mellem billederne med knapperne øverst. Under **⋯** kan placeringen justeres, og billedet kan omdøbes eller slettes.

Nærbilleder placeres med flytning og skalering (ikke perspektiv), så tag dem så lige oppefra som muligt.

## Forbind mobil og computer

1. På computeren: tryk **🔗 Forbind enheder → Vis QR-kode**.
2. Scan QR-koden med mobilens kamera. Har du installeret appen på hjemmeskærmen, så åbn appen og indtast koden under **Har du en kode?** i stedet (på iPhone har hjemmeskærms-appen sit eget lager, adskilt fra Safari).
3. Færdig – enhederne husker hinanden og forbinder automatisk, når appen er åben på begge.

Hvordan det virker: enhederne finder hinanden via PeerJS' gratis signalserver og sender derefter data krypteret direkte
til hinanden (WebRTC). Der er ingen central database – data findes kun på dine enheder. Parringen bruger en engangskode og
en fælles hemmelighed, så andre ikke kan forbinde, selv hvis de kender enhedens id. Ved samtidige ændringer i samme
projekt vinder den seneste. Du kan bruge din egen signalserver under ⚙ Indstillinger → Avanceret.

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

Workflowet `.github/workflows/deploy.yml` tester og bygger ved hvert push og udgiver appen fra repositoriets
standardbranch. Slå GitHub Pages til under **Settings → Pages → Source: GitHub Actions** og kør derefter workflowet
igen (**Actions → Deploy til GitHub Pages → Run workflow**). Appen ligger derefter på
`https://<bruger>.github.io/<repo>/`.

### Struktur

```
src/
  main.ts         Forside, dialoger, eksport, tastatur
  editor.ts       Canvas: zoom/pan, værktøjer, tegning, fortryd
  panel.ts        Sidepanel: komponenter, strømveje, målinger, overblik
  ai.ts           Komponent-genkendelse med Claude (struktureret output)
  sync.ts         Synkronisering mellem enheder (PeerJS/WebRTC)
  connect.ts      Dialogen "Forbind enheder" (QR-kode/parring)
  localDetect.ts  Offline komponent-søgning (farve-segmentering)
  geometry.ts     Geometri, spændingsfortolkning, komponenter langs net
  store.ts        IndexedDB-lager og indstillinger
  image.ts        Indlæsning/skalering af billeder
  types.ts        Datamodel
tests/            Vitest-tests
public/           Ikoner, manifest og service worker
```
