#!/usr/bin/env python3
"""Bygger de publiserte sidene fra kildene i kilde/.

    python3 bygg.py

Lager:
  index.html     – appen for de ansatte (fra kilde/app.html + kilde/i18n.json)
  leder/index.html – ledersiden (fra kilde/leder-base.html + kilde/leder-shim.js)
  version.json   – ny versjon, så åpne apper laster seg selv på nytt

Kjør alltid denne før du committer endringer i kilde/. GitHub Pages publiserer
filene i rota av repoet automatisk etter push.
"""
import json, os, re, sys, datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
K = os.path.join(ROOT, "kilde")
rd = lambda p: open(os.path.join(K, p), encoding="utf-8").read()
BUILD = datetime.datetime.now(ZoneInfo("Europe/Oslo")).strftime("%Y%m%d%H%M%S")

# ---------- appen for de ansatte ----------
app = rd("app.html")
i18n = json.loads(rd("i18n.json"))
app, n = re.subn(r"var I18N=\{.*?\};\n", lambda m: "var I18N=" + json.dumps(i18n, ensure_ascii=False) + ";\n", app, count=1, flags=re.S)
assert n == 1, "fant ikke var I18N= i kilde/app.html"
assert app.count("__BUILD__") == 1, "kilde/app.html må ha nøyaktig én __BUILD__"
app = app.replace("__BUILD__", BUILD)
open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8").write(app)
open(os.path.join(ROOT, "version.json"), "w", encoding="utf-8").write(json.dumps({"v": BUILD}) + "\n")

# ---------- ledersiden ----------
src = rd("leder-base.html")
shim = rd("leder-shim.js")
def rep(a, b):
    global src
    assert src.count(a) == 1, (src.count(a), a[:60])
    src = src.replace(a, b)
# leder-base.html er også den gamle Claude-artefakten; her byttes det som bare gjaldt der.
rep('h("p",{class:"hint",style:"margin:0",text:"Microsoft 365 er ikke tilgjengelig i denne visningen. Åpne planen i claude.ai for å oppdatere Excel-fila."})', 'null')
rep('"De ansatte åpner plan.grindberg.no og skriver inn koden én gang. Bytter du kode, må alle skrive inn den nye neste gang siden oppdateres."', '"De ansatte åpner plan.grindberg.no og skriver inn koden én gang. Bytter du kode, blir alle logget ut og må skrive inn den nye."')
rep('toast("Ny kode laget. Si «oppdater app-siden» til Claude.")', 'toast("Ny kode er tatt i bruk")')
rep('"Du kan redigere. Endringer vises med en gang for alle som har planen åpen."', '"Innlogget som "+((window.gbMe&&window.gbMe()||{}).navn||"leder")+". Endringer vises med en gang for alle som har planen eller appen åpen."')
rep('"Utskrift: «Last ned for utskrift» lager en A4-fil som åpnes og skrives ut fra nettleseren."})', '"Utskrift: «Last ned for utskrift» lager en A4-fil som åpnes og skrives ut fra nettleseren."}),h("button",{class:"btn ghost",type:"button",style:"min-height:0;padding:2px 8px",text:"Logg ut",onclick:()=>window.gbLogout()})')
css = '''<style>.gb-login{position:fixed;inset:0;z-index:100;background:var(--bg,#eef0ec);display:grid;place-items:center;padding:16px}
.gb-login form{background:var(--paper,#fff);border:1px solid var(--line,#d3d8d2);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:12px;width:100%;max-width:360px}
.gb-login h1{margin:0;font-family:var(--display,sans-serif);font-size:32px}.gb-login p{margin:0;color:var(--muted,#5d6862)}.gb-login .e{color:var(--danger,#b3261e);font-weight:700}
.gb-login input{border:1px solid var(--line,#d3d8d2);border-radius:8px;padding:12px;font:inherit;font-size:18px;background:var(--bg,#eef0ec);color:inherit}
.gb-login button{border:0;border-radius:8px;padding:12px;font:inherit;font-weight:700;background:var(--accent,#2f5d50);color:var(--accent-ink,#fff);cursor:pointer}</style>'''
head = '<!doctype html>\n<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="../icon-32.png">' + css + '<style>body{margin:0}</style></head><body>\n'
i = src.index('<script>\n(function(){')
src = src[:i] + '<script>\n' + shim + '\n</script>\n' + src[i:]
src = re.sub(r'\s*<div class="notice err"[^\n]*Planen er flyttet.*?</div>\n', '\n', src, count=1)
os.makedirs(os.path.join(ROOT, "leder"), exist_ok=True)
open(os.path.join(ROOT, "leder", "index.html"), "w", encoding="utf-8").write(head + src + '\n</body></html>\n')

print("Bygget versjon", BUILD)
