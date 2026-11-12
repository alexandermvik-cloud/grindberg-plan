// Arbeidsplan Grindberg – server for plan.grindberg.no
import { txStatus, txSetKey, txSync, txMaybeSync } from "./tripletex.js";
import { ensurePushTables, vapidPublic, sendPush, testMessage, queueTask, queueNote, queueMessage, flushQueue } from "./push.js";
// Dokumentlager i D1. Alle endringer øker en versjon, så sidene kan hente nytt med en gang.

const COLLS = new Set(["oppsett", "oppgaver", "ordre", "uker", "fravaer", "timer", "tripletex", "beskjeder"]);
const LEADER_ONLY_READ = new Set(["oppsett/tilgang", "oppsett/excel"]);
const ID_RE = /^[A-Za-z0-9_\-.:@+~]{1,120}$/;

const ORIGINS = ["https://plan.grindberg.no", "http://plan.grindberg.no", "https://alexandermvik-cloud.github.io", "http://127.0.0.1:8765", "http://localhost:8765"];
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const norm = (c) => String(c || "").toLowerCase().replace(/\s+/g, "");

async function meta(env, k) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first();
  return r ? r.v : null;
}
async function version(env) {
  return Number((await meta(env, "version")) || 0);
}

async function whoAmI(env, req) {
  const code = norm(req.headers.get("x-kode"));
  if (!code) return null;
  const leaders = JSON.parse((await meta(env, "ledere")) || "[]");
  const l = leaders.find((x) => norm(x.kode) === code);
  if (l) return { role: "leder", navn: l.navn };
  const t = await env.DB.prepare("SELECT data FROM docs WHERE coll='oppsett' AND id='tilgang'").first();
  const emp = t ? norm(JSON.parse(t.data).kode) : "";
  if (emp && emp === code) return { role: "ansatt" };
  return null;
}

// Hva en ansatt får lov til å skrive
function employeeMay(method, coll, body) {
  if (coll === "timer") return true;
  if (coll === "fravaer") return method === "POST";
  if (coll === "oppgaver" && method === "PATCH") {
    const keys = Object.keys(body || {});
    return keys.length > 0 && keys.every((k) => k === "ferdig" || k === "ferdigAv" || k === "ferdigTid");
  }
  return false;
}

async function bump(env) {
  await env.DB.prepare(
    "INSERT INTO meta(k,v) VALUES('version','1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT)"
  ).run();
  return version(env);
}

function newId() {
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

// ---------- automatisk oversettelse ----------
const TR_LANGS = { en: "English", uk: "Ukrainian" };
const MODEL = "@cf/openai/gpt-oss-120b";
function trFields(coll, d) {
  // Returnerer liste av [sti, tekst] som skal oversettes
  const out = [];
  const add = (k, v) => { if (typeof v === "string" && v.trim()) out.push([k, v]); };
  if (coll === "oppgaver") add("tekst", d.tekst);
  else if (coll === "uker" || coll === "beskjeder") add("tekst", d.tekst);
  else if (coll === "fravaer") add("notat", d.notat);
  else if (coll === "ordre") {
    add("hva", d.hva); add("notat", d.notat);
    (d.linjer || []).forEach((l, i) => { add("linjer." + i + ".b", l.b); add("linjer." + i + ".p", l.p); });
  }
  return out;
}
function hashStr(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return String(h >>> 0); }
async function translateList(env, texts, lang, model) {
  const out = [];
  for (let i = 0; i < texts.length; i += 25) {
    const chunk = texts.slice(i, i + 25);
    const prompt = "Translate each Norwegian text in this JSON array to " + TR_LANGS[lang] + ". The texts are work instructions and order descriptions from a Norwegian furniture and joinery workshop (woodworking, CNC, lacquering, kitchens, wardrobes). Keep numbers, measurements, units, order numbers, product and brand names, colour codes and people's names unchanged. Workshop glossary (Norwegian → meaning): lime = glue (verb), liming = gluing, lakke/lakk = lacquer, beise = stain, slipe = sand, kappe = cut to length, høvle = plane, fres/frese = mill/rout (CNC), skrog = cabinet carcass, front/fronter = cabinet door/drawer fronts, benkeplate = worktop, heltre = solid wood, furu = pine, eik = oak, bjørk = birch, kvist = knots, list = moulding, sokkel = plinth, skuff = drawer, hengsel = hinge, montere = install, verksted = workshop, hall = workshop hall, Forsette/Fortsette = continue. Write natural, short imperative instructions like a foreman would. Keep line breaks. Reply with ONLY a JSON array of strings with exactly " + chunk.length + " items, in the same order.\n\n" + JSON.stringify(chunk);
    const r = await env.AI.run(model || MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 4096, temperature: 0.1 });
    let resp = r && (r.response !== undefined && r.response !== null ? r.response : (r.choices && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : r.result));
    if (resp === undefined && r && Array.isArray(r.output)) { const msg = r.output.filter((x) => x.type === "message").pop(); resp = msg && msg.content && msg.content.map((c) => c.text || "").join(""); }
    if (resp && typeof resp === "object" && !Array.isArray(resp) && resp.response !== undefined) resp = resp.response;
    let arr = Array.isArray(resp) ? resp : null;
    if (!arr) {
      const txt = typeof resp === "string" ? resp : JSON.stringify(resp || "");
      const m = txt.match(/\[[\s\S]*\]/);
      try { arr = m ? JSON.parse(m[0]) : null; } catch { arr = null; }
    }
    if (!Array.isArray(arr) || arr.length !== chunk.length) throw new Error("Uventet svar fra oversettelse");
    out.push(...arr.map((x) => String(x)));
  }
  return out;
}
async function translateDoc(env, coll, id, force) {
  if (!env.AI || !["oppgaver", "uker", "ordre", "fravaer", "beskjeder"].includes(coll)) return false;
  const row = await env.DB.prepare("SELECT data FROM docs WHERE coll=? AND id=?").bind(coll, id).first();
  if (!row) return false;
  const d = JSON.parse(row.data);
  const fields = trFields(coll, d);
  const src = hashStr(JSON.stringify(fields));
  if (!force && d._tr && d._tr.src === src) return false;
  const tr = { src };
  if (fields.length) {
    for (const lang of Object.keys(TR_LANGS)) {
      const res = await translateList(env, fields.map((f) => f[1]), lang);
      const o = {};
      fields.forEach((f, i) => { o[f[0]] = res[i]; });
      tr[lang] = o;
    }
  }
  // skriv bare _tr, behold resten slik det er nå
  const cur = await env.DB.prepare("SELECT data FROM docs WHERE coll=? AND id=?").bind(coll, id).first();
  if (!cur) return false;
  const nd = JSON.parse(cur.data);
  if (hashStr(JSON.stringify(trFields(coll, nd))) !== src) return false; // endret i mellomtiden
  nd._tr = tr;
  await env.DB.prepare("UPDATE docs SET data=? WHERE coll=? AND id=?").bind(JSON.stringify(nd), coll, id).run();
  await bump(env);
  return true;
}

async function api(req, env, url, ctx) {
  const path = url.pathname.replace(/^\/api\/?/, "");
  const me = await whoAmI(env, req);

  if (path === "login" && req.method === "POST") {
    if (!me) {
      await new Promise((r) => setTimeout(r, 700));
      return json({ error: "Feil kode" }, 401);
    }
    return json(me);
  }
  if (!me) return json({ error: "Ikke innlogget" }, 401);

  if (path === "data" && req.method === "GET") {
    const v = await version(env);
    if (url.searchParams.get("v") === String(v)) return json({ v, same: true });
    const rows = await env.DB.prepare("SELECT coll,id,data FROM docs").all();
    const docs = {};
    for (const r of rows.results) {
      const key = r.coll + "/" + r.id;
      if (me.role !== "leder" && LEADER_ONLY_READ.has(key)) continue;
      (docs[r.coll] = docs[r.coll] || {})[r.id] = JSON.parse(r.data);
    }
    return json({ v, docs, me });
  }

  if (path.startsWith("push/")) {
    await ensurePushTables(env);
    const what = path.slice(5);
    if (what === "key") return json({ key: await vapidPublic(env) });
    if (what === "list") {
      if (me.role !== "leder") return json({ error: "Ikke tilgang" }, 403);
      const r = (await env.DB.prepare("SELECT navn, COUNT(*) AS n FROM pushsub GROUP BY navn").all()).results;
      return json({ navn: r });
    }
    if (req.method !== "POST") return json({ error: "Ukjent handling" }, 405);
    let b; try { b = await req.json(); } catch { return json({ error: "Ugyldig innhold" }, 400); }
    if (what === "sub") {
      const sub = b && b.sub;
      if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth || sub.endpoint.length > 1000) return json({ error: "Ugyldig abonnement" }, 400);
      const navn = String(b.navn || "").slice(0, 60);
      const lang = ["no", "en", "uk"].includes(b.lang) ? b.lang : "no";
      await env.DB.prepare("INSERT INTO pushsub(endpoint,navn,sub,lang,created) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET navn=excluded.navn, sub=excluded.sub, lang=excluded.lang")
        .bind(sub.endpoint, navn, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }), lang, Date.now()).run();
      if (b.test) { try { return json({ ok: true, status: await sendPush(env, sub, testMessage(lang)) }); } catch (e) { return json({ ok: true, feil: String(e && e.message || e) }); } }
      return json({ ok: true });
    }
    if (what === "unsub") {
      await env.DB.prepare("DELETE FROM pushsub WHERE endpoint=?").bind(String(b && b.endpoint || "")).run();
      return json({ ok: true });
    }
    return json({ error: "Ukjent adresse" }, 404);
  }

  if (path.startsWith("tripletex/")) {
    if (me.role !== "leder") return json({ error: "Ikke tilgang" }, 403);
    const what = path.slice(10);
    if (what === "status" && req.method === "GET") return json(await txStatus(env));
    if (req.method !== "POST") return json({ error: "Ukjent handling" }, 405);
    if (what === "key") {
      let b; try { b = await req.json(); } catch { return json({ error: "Ugyldig innhold" }, 400); }
      const k = String(b && b.key || "").trim();
      if (k.length > 4000) return json({ error: "For lang nøkkel" }, 400);
      const off = await txSetKey(env, k);
      if (off) return json(off);
    } else if (what !== "sync") return json({ error: "Ukjent adresse" }, 404);
    const st = await txSync(env, bump);
    for (const id of st.changedOrdre || []) ctx.waitUntil(translateDoc(env, "ordre", id).catch(() => {}));
    const { changedOrdre, ...out } = st;
    return json({ koblet: true, ...out });
  }

  if (path === "oversett" && req.method === "POST") {
    if (me.role !== "leder") return json({ error: "Ikke tilgang" }, 403);
    if (url.searchParams.get("test")) {
      const texts = ["Lime benkeplate", "Lakk fronter", "Forsette å lime Butcher Block til kjøkkenøy. Fortsette på fronter til Ingunn", "Kappe og høvle heltre furu til skrog"];
      const out = {};
      for (const lang of ["en", "uk"]) { try { out[lang] = await translateList(env, texts, lang, url.searchParams.get("model") || undefined); } catch (e) { out[lang] = String(e && e.message || e); } }
      return json(out);
    }
    const one = url.searchParams.get("id");
    if (one) {
      try { return json({ ok: await translateDoc(env, url.searchParams.get("coll"), one, url.searchParams.get("alle") === "1") }); }
      catch (e) { return json({ ok: false, feil: String(e && e.message || e) }); }
    }
    const rows = await env.DB.prepare("SELECT coll,id FROM docs WHERE coll IN ('oppgaver','uker','ordre','fravaer')").all();
    let n = 0, feil = 0;
    for (const r of rows.results) { try { if (await translateDoc(env, r.coll, r.id, url.searchParams.get("alle") === "1")) n++; } catch (e) { feil++; } }
    return json({ oversatt: n, feil, totalt: rows.results.length });
  }

  const m = path.match(/^doc\/([a-z]+)(?:\/([^/]+))?$/);
  if (!m) return json({ error: "Ukjent adresse" }, 404);
  const coll = m[1];
  let id = m[2] ? decodeURIComponent(m[2]) : null;
  if (!COLLS.has(coll)) return json({ error: "Ukjent samling" }, 400);
  if (id && !ID_RE.test(id)) return json({ error: "Ugyldig id" }, 400);

  let body = null;
  if (req.method !== "DELETE") {
    try { body = await req.json(); } catch { return json({ error: "Ugyldig innhold" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Ugyldig innhold" }, 400);
    if (JSON.stringify(body).length > 200000) return json({ error: "For stort" }, 413);
  }
  if (me.role !== "leder" && !employeeMay(req.method, coll, body)) return json({ error: "Ikke tilgang" }, 403);

  if (req.method === "POST" && !id) {
    id = newId();
    await env.DB.prepare("INSERT INTO docs(coll,id,data,updated) VALUES(?,?,?,?)").bind(coll, id, JSON.stringify(body), Date.now()).run();
    ctx.waitUntil(translateDoc(env, coll, id).catch(() => {}));
    if (me.role === "leder") ctx.waitUntil(notify(env, coll, id, null, body).catch(() => {}));
    return json({ id, v: await bump(env) });
  }
  if (!id) return json({ error: "Mangler id" }, 400);

  if (req.method === "PUT") {
    const old = await env.DB.prepare("SELECT data FROM docs WHERE coll=? AND id=?").bind(coll, id).first();
    const od = old ? JSON.parse(old.data) : null;
    if (!body._tr && od && od._tr) body._tr = od._tr;
    if (me.role === "leder") ctx.waitUntil(notify(env, coll, id, od, body).catch(() => {}));
    await env.DB.prepare(
      "INSERT INTO docs(coll,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, updated=excluded.updated"
    ).bind(coll, id, JSON.stringify(body), Date.now()).run();
    ctx.waitUntil(translateDoc(env, coll, id).catch(() => {}));
    return json({ id, v: await bump(env) });
  }
  if (req.method === "PATCH") {
    const cur = await env.DB.prepare("SELECT data FROM docs WHERE coll=? AND id=?").bind(coll, id).first();
    if (!cur) return json({ error: "Finnes ikke" }, 404);
    const before = JSON.parse(cur.data);
    const merged = { ...before, ...body };
    if (me.role === "leder") ctx.waitUntil(notify(env, coll, id, before, merged).catch(() => {}));
    await env.DB.prepare("UPDATE docs SET data=?, updated=? WHERE coll=? AND id=?").bind(JSON.stringify(merged), Date.now(), coll, id).run();
    ctx.waitUntil(translateDoc(env, coll, id).catch(() => {}));
    return json({ id, v: await bump(env) });
  }
  if (req.method === "DELETE") {
    if (me.role !== "leder" && coll !== "timer") return json({ error: "Ikke tilgang" }, 403);
    await env.DB.prepare("DELETE FROM docs WHERE coll=? AND id=?").bind(coll, id).run();
    return json({ id, v: await bump(env) });
  }
  return json({ error: "Ukjent handling" }, 405);
}

async function notify(env, coll, id, before, after) {
  if (coll === "oppgaver") return queueTask(env, before, after, id);
  if (coll === "uker") return queueNote(env, before, after, id);
  if (coll === "beskjeder" && !before) return queueMessage(env, after, id);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(flushQueue(env));
    ctx.waitUntil(txMaybeSync(env, bump).then((st) => Promise.all(((st && st.changedOrdre) || []).map((id) => translateDoc(env, "ordre", id).catch(() => {})))).catch(() => {}));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || "";
    const CORS = ORIGINS.includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, x-kode", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-max-age": "86400", vary: "origin" }
      : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname.startsWith("/api/")) {
      let res;
      try { res = await api(req, env, url, ctx); }
      catch (e) { res = json({ error: "Serverfeil", detalj: String(e && e.message || e) }, 500); }
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    return new Response("Arbeidsplan Grindberg – server. Åpne https://plan.grindberg.no", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
