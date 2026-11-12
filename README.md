# Arbeidsplan Grindberg

Arbeidsplan for verkstedet på Grindberg Trevarefabrikk – https://plan.grindberg.no

- `index.html` – appen for de ansatte (logg inn med ansattkoden).
- `leder/` – planleggingen for leder (logg inn med lederkode).
- `kilde/` – kildene til sidene. Bygg med `python3 bygg.py`.
- `server/` – serveren (Cloudflare Worker + D1). Publiseres av GitHub Action ved push.

Sidene inneholder ingen data. Alt hentes fra serveren `grindberg-plan.grindberg.workers.dev`
etter innlogging, og oppdateres automatisk.

Se `CLAUDE.md` for hvordan alt henger sammen og hvordan man gjør endringer.
