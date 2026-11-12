# Arbeidsplan Grindberg – for Claude og andre som skal endre appen

Arbeidsplan for verkstedet på Grindberg Trevarefabrikk AS (Kilegrend, Fyresdal).
Eier: Alexander Michelsen Vik (daglig leder). Alt brukergrensesnitt er på **norsk bokmål**,
med språkvalg norsk / engelsk / ukrainsk i appen for de ansatte.

- **plan.grindberg.no** – appen for de ansatte (mobil, kan legges på hjemskjermen).
- **plan.grindberg.no/leder** – planleggingen for leder (PC og mobil).
- **grindberg-plan.grindberg.workers.dev** – serveren (Cloudflare Worker + D1-database).

> Repoet er **offentlig** (GitHub Pages krever det på gratiskonto). Legg aldri inn
> innloggingskoder, API-nøkler, kundedata eller eksporter av databasen her.

## Hvordan det henger sammen

```
GitHub Pages (dette repoet, rota)          Cloudflare (Alexanders konto)
  index.html  ── appen for ansatte  ──┐      Worker «grindberg-plan»  (server/src)
  leder/      ── ledersiden ──────────┼──▶     /api/...  + cron hvert minutt
  sw.js       ── varsler (push)       │      D1 «grindberg-plan»  (tabeller docs, meta, pushsub, pushq)
                                      │      Workers AI  (oversettelse)
                                      └──▶   Tripletex API (henter åpne ordre)
```

Sidene inneholder ingen data. Alt hentes fra serveren etter innlogging, og sidene spør
etter endringer hvert 5. (leder) / 10. (ansatte) sekund med `?v=<versjon>`.

DNS: `plan` er en CNAME til `alexandermvik-cloud.github.io` i Cloudflare-sonen for grindberg.no
(sonen ligger i Digipos AS sin Cloudflare-konto; Alexander har bare DNS-rolle der).
Workeren ligger i Alexanders egen Cloudflare-konto (account_id i server/wrangler.toml).

## Mapper

| Sti | Hva |
|---|---|
| `kilde/app.html` | Kilden til appen for de ansatte. Ren HTML/CSS/JS i én fil. Har `var BUILD="__BUILD__"`. |
| `kilde/i18n.json` | Oversettelser for appen: `{"norsk tekst": ["engelsk", "ukrainsk"]}`. Bygges inn i appen. |
| `kilde/leder-base.html` | Kilden til ledersiden (opprinnelig en Claude-artefakt, bruker `claude.use("db")`). |
| `kilde/leder-shim.js` | Etterligner `window.claude`-databasen mot serveren, pluss innlogging (`gbApi`, `gbMe`, `gbLogout`). |
| `bygg.py` | Bygger `index.html`, `leder/index.html` og `version.json` fra `kilde/`. |
| `server/src/worker.js` | API, roller, oversettelse, ruting. |
| `server/src/push.js` | Varsler (Web Push med VAPID, egen kryptering etter RFC 8291) og varselkø. |
| `server/src/tripletex.js` | Henter åpne ordre fra Tripletex med API-nøkkel. |
| `server/wrangler.toml` | Worker-oppsett: D1, Workers AI, cron `* * * * *`. |
| `server/schema.sql` | Grunntabellene (docs, meta). push-tabellene lages av koden selv. |
| `index.html`, `leder/`, `version.json` | **Bygde filer – ikke rediger direkte.** |
| `sw.js`, `manifest.webmanifest`, ikoner, `CNAME`, `robots.txt` | Statiske filer, redigeres direkte. |

## Slik gjør du en endring

**Appen eller ledersiden**
1. Endre i `kilde/` (og nye tekster i `kilde/i18n.json` – nøkkelen er den norske teksten, brukt med `L("…")`).
2. `python3 bygg.py`
3. Test (se under), commit alt (også de bygde filene), push til `main`.
4. GitHub Pages publiserer på ca. 1 minutt. Åpne apper laster seg selv på nytt når
   `version.json` endres (sjekkes ved oppstart og hvert 2. minutt).

**Serveren**
1. Endre i `server/src/`. Sjekk med `node --check server/src/*.js`.
2. Push til `main`. GitHub Action «Server» publiserer med `wrangler deploy`
   (krever hemmeligheten `CLOUDFLARE_API_TOKEN` i repoet).
3. Uten Action: `cd server && npx wrangler deploy` med `CLOUDFLARE_ACCOUNT_ID` satt, fra en maskin
   som er logget inn i Alexanders Cloudflare-konto (hans Mac har det).
4. En ny Worker-versjon kan bruke 10–30 sekunder før den svarer overalt.

Merk: en sky-økt kan ofte ikke nå `*.workers.dev` eller `plan.grindberg.no` direkte (nettfilter).
Test da mot mock-data (under), og sjekk live via Alexanders Mac hvis den er koblet til.

## Testing

Bruk Playwright med falske API-svar: server `index.html`/`leder/index.html` fra en lokal
`python3 -m http.server 8765` og fang opp `https://grindberg-plan.grindberg.workers.dev/api/**`
med `page.route`, returner `{v, docs:{oppsett,oppgaver,ordre,uker,fravaer,timer,beskjeder,tripletex}, me}`.
Sett `localStorage` `gb-kode` (ansatt) eller `gb-lederkode` (leder) og `gb-me`, `gb-lang`.
Origin `http://localhost:8765` er tillatt i CORS.

## API (server/src/worker.js)

Alle kall sender koden i headeren `x-kode`. Rollen avgjøres på serveren:
- **leder**: koden finnes i `meta.ledere` (JSON-liste `[{navn, kode}]`).
- **ansatt**: koden er lik `oppsett/tilgang.kode` (én felles kode for alle ansatte; kan byttes på ledersiden → Oppsett).

| Kall | Hvem | |
|---|---|---|
| `POST /api/login` | alle | 401 ved feil kode |
| `GET /api/data?v=` | alle | alle dokumenter (unntatt `oppsett/tilgang` og `oppsett/excel` for ansatte); `{same:true}` hvis uendret |
| `PUT/PATCH/POST/DELETE /api/doc/:samling/:id` | se under | dokumentlager |
| `GET /api/push/key`, `POST /api/push/sub`, `POST /api/push/unsub` | alle | varsler |
| `GET /api/push/list` | leder | hvem som har slått på varsler |
| `GET /api/tripletex/status`, `POST /api/tripletex/key {key}`, `POST /api/tripletex/sync` | leder | Tripletex-kobling |
| `POST /api/oversett[?coll=&id=&alle=1]` | leder | oversett på nytt |

Ansatte kan bare: føre/slette `timer`, legge inn `fravaer` (POST), og krysse av jobber
(`PATCH oppgaver` med bare `ferdig`, `ferdigAv`, `ferdigTid`). Alt annet krever leder.

**Viktig:** alle ansatte deler én kode, så serveren vet ikke hvem som er hvem. «Hvem er du?»
i appen er bare et valg på telefonen. Ingenting de ansatte kan lese er hemmelig.

## Datamodell (samlinger i `docs`)

- `oppsett/stasjoner` `{liste:[{id,navn}]}` · `oppsett/ansatte` `{liste:[navn], farger:{navn:indeks}}` · `oppsett/tilgang` `{kode}`
- `oppgaver/<id>` `{dato:"YYYY-MM-DD", hvem, stasjon, ordreId, tekst, ferdig, ferdigAv, ferdigTid, opprettet}`
- `ordre/<id>` `{nr, navn, hva, notat, levering, status:"aktiv"|"levert", farge, linjer:[{p,b,a}], tripletexId, tx:{…}}`
  - `tx` = kundeopplysninger fra Tripletex (kunde, kundenr, tlf, epost, kadr, levadr, kontakt, vaar, ref, odato, lev, url, nr, hentet). **Aldri priser.**
- `tripletex/t<tripletexId>` – kandidater fra Tripletex som leder kan «Ta inn»: `{tid, nr, kunde, ref, odato, lev, var:[{p,b,a}], tx, skjult, lukket, ny}`
- `uker/<YYYY-Www>` `{tekst}` – ukebeskjed til alle
- `beskjeder/<id>` `{til:"*"|navn, tekst, fra, tid}` – beskjed til én eller alle
- `fravaer/<id>` `{hvem, fra, til, type, notat}` · `timer/<id>` `{ordreId, hvem, dato, timer, kommentar}`
- `_tr` på et dokument = automatisk oversettelse: `{src: hash, en:{sti:tekst}, uk:{…}}`. Lages av serveren etter lagring (Workers AI, `@cf/openai/gpt-oss-120b`). Feltene som oversettes står i `trFields()`.

`meta`: `version` (økes ved hver skriving), `ledere`, `vapid` (nøkkelpar for varsler), `txkey`/`txsess`/`txstatus` (Tripletex).

## Varsler

`kilde/app.html` registrerer `sw.js`, abonnerer med VAPID-nøkkelen og sender abonnementet med valgt navn og språk.
Serveren legger hendelser i `pushq` (ny/flyttet jobb til en ansatt, ny ukebeskjed, ny beskjed), og cron
sender når det har vært stille i ett minutt for mottakeren (samler flere jobber i ett varsel).
iPhone: bare når appen er lagt på hjemskjermen (iOS 16.4+).

## Tripletex

Leder limer inn en API-nøkkel (Tripletex → API-nøkler, intern integrasjon/JWT) på ledersiden → Ordre → «Koble til Tripletex».
Serveren bytter den mot en sesjon (`POST /v2/token/session/:createFromRefreshToken`) og henter
`GET /v2/order?isClosed=false…` hver halvtime 06–20 (ellers hver 3. time). Nye ordre blir kandidater i
`tripletex/`, inntatte ordre får oppdatert `tx` og `linjer`, lukkede ordre får `lukket:true`.
Selskaps-id for lenker: 22705249.

## Stil og vaner

- Skriv tekster i appen på enkel, vennlig norsk; legg engelsk og ukrainsk inn i `kilde/i18n.json`.
- Store knapper og lesbar tekst – appen brukes på mobil i verkstedet, ofte med hansker.
- Commit-meldinger på norsk.
