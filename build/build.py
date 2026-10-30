#!/usr/bin/env python3
"""Bygger arbeidsplanen (index.html) fra en eksport av den delte planen.

Bruk: python3 build/build.py <db-mappe> <ut-mappe>
<db-mappe> inneholder undermappene oppsett/, oppgaver/, ordre/ og uker/
med ett JSON-dokument per fil (slik ArtifactData lagrer dem med out_dir).
"""
import json, os, sys, shutil, datetime, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
db, out = sys.argv[1], sys.argv[2]

def read(coll):
    p = os.path.join(db, coll)
    if not os.path.isdir(p):
        return []
    res = []
    for f in sorted(os.listdir(p)):
        if f.endswith(".json"):
            d = json.load(open(os.path.join(p, f), encoding="utf-8"))
            d["id"] = f[:-5]
            res.append(d)
    return res

oppsett = {d["id"]: d for d in read("oppsett")}
oslo = ZoneInfo("Europe/Oslo")
now = datetime.datetime.now(oslo)
monday = (now - datetime.timedelta(days=now.weekday())).date()
first = monday - datetime.timedelta(days=7)
last = monday + datetime.timedelta(days=49)

st = (oppsett.get("stasjoner") or {}).get("liste") or []
ans = oppsett.get("ansatte") or {}
tasks = [
    {k: t.get(k) for k in ("dato", "stasjon", "ordreId", "tekst", "hvem", "ferdig", "opprettet")}
    for t in read("oppgaver")
    if t.get("dato") and first.isoformat() <= t["dato"] <= last.isoformat()
]
used = {t["ordreId"] for t in tasks if t.get("ordreId")}
orders = [
    {k: o.get(k) for k in ("id", "nr", "navn", "hva", "levering")}
    for o in read("ordre")
    if o.get("status") != "levert" or o["id"] in used
]
for o in orders:
    if o.get("levering") and o["levering"] < now.date().isoformat():
        pass
fravaer = [
    {k: f.get(k) for k in ("hvem", "fra", "til", "type", "notat")}
    for f in read("fravaer")
    if f.get("fra") and (f.get("til") or f["fra"]) >= first.isoformat() and f["fra"] <= last.isoformat()
]
uker = {u["id"]: {"tekst": u.get("tekst", "")} for u in read("uker")}

data = {
    "oppdatert": now.isoformat(),
    "stasjoner": [{"id": s["id"], "navn": s["navn"]} for s in st],
    "ansatte": ans.get("liste") or [],
    "farger": ans.get("farger") or {},
    "oppgaver": tasks,
    "ordre": [o for o in orders],
    "uker": uker,
    "fravaer": fravaer,
    "kontakt": {"sms": "+4745391411", "epost": "alexander@grindberg.no", "navn": "Alexander"},
}
os.makedirs(out, exist_ok=True)
tpl = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
kode = "".join(((oppsett.get("tilgang") or {}).get("kode") or "").lower().split())
if not kode:
    sys.exit("Mangler kode i oppsett/tilgang - siden bygges ikke uten innlogging.")
ITER = 310000
import hashlib
salt, iv = hashlib.sha256(("grindberg-plan|" + kode).encode()).digest()[:16], os.urandom(12)
key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(kode.encode())
ct = AESGCM(key).encrypt(iv, json.dumps(data, ensure_ascii=False).encode(), None)
b = lambda x: base64.b64encode(x).decode()
js = json.dumps({"salt": b(salt), "iv": b(iv), "iter": ITER, "ct": b(ct)})
open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(tpl.replace("__DATA__", js))
for f in ("forge.min.js", "icon-32.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"):
    shutil.copy(os.path.join(HERE, f), os.path.join(out, f))
manifest = {
    "name": "Arbeidsplan Grindberg",
    "short_name": "Arbeidsplan",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "background_color": "#eef0ec",
    "theme_color": "#1d2320",
    "lang": "no",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}
json.dump(manifest, open(os.path.join(out, "manifest.webmanifest"), "w"), ensure_ascii=False, indent=1)
open(os.path.join(out, "robots.txt"), "w").write("User-agent: *\nDisallow: /\n")
print(f"Bygget {len(tasks)} jobber, {len(orders)} ordre -> {out}")
