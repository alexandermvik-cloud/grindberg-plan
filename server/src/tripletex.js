// Henter åpne ordre fra Tripletex med selskapets API-nøkkel (intern integrasjon, JWT).
const TX = "https://tripletex.no/v2";
const CONTEXT = "22705249"; // Grindbergs selskaps-id i Tripletex (for lenker)

async function metaGet(env, k) { const r = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first(); return r ? r.v : null; }
async function metaSet(env, k, v) { await env.DB.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, v).run(); }
async function metaDel(env, k) { await env.DB.prepare("DELETE FROM meta WHERE k=?").bind(k).run(); }

export async function txStatus(env) {
  const key = await metaGet(env, "txkey");
  const st = JSON.parse((await metaGet(env, "txstatus")) || "{}");
  return { koblet: !!key, ...st };
}
export async function txSetKey(env, key) {
  key = String(key || "").trim();
  await metaDel(env, "txsess");
  if (!key) { await metaDel(env, "txkey"); await metaDel(env, "txstatus"); return { koblet: false }; }
  await metaSet(env, "txkey", key);
  return null;
}

async function session(env, fresh) {
  if (!fresh) {
    const s = JSON.parse((await metaGet(env, "txsess")) || "null");
    if (s && s.exp > Date.now() + 120e3) return s.token;
  }
  const key = await metaGet(env, "txkey");
  if (!key) throw new Error("Ingen API-nøkkel lagt inn");
  const r = await fetch(TX + "/token/session/:createFromRefreshToken", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refreshToken: key, ttlSeconds: 4 * 3600 }),
  });
  const j = await r.json().catch(() => ({}));
  const token = j.token || (j.value && j.value.token);
  if (!r.ok || !token) throw new Error("Tripletex godtok ikke nøkkelen (" + r.status + (j.message ? ": " + j.message : "") + (j.validationMessages && j.validationMessages.length ? " – " + j.validationMessages.map((v) => v.message).join("; ") : "") + ")");
  await metaSet(env, "txsess", JSON.stringify({ token, exp: Date.now() + 4 * 3600e3 }));
  return token;
}

async function txGet(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await session(env, attempt > 0);
    const r = await fetch(TX + path, { headers: { accept: "application/json", authorization: "Basic " + btoa("0:" + token) } });
    if (r.status === 401 && attempt === 0) continue;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Tripletex svarte " + r.status + (j.message ? ": " + j.message : "") + (j.validationMessages && j.validationMessages.length ? " (" + j.validationMessages.map((v) => v.field + ": " + v.message).join("; ") + ")" : ""));
    return j;
  }
}

const adr = (a) => a ? [a.addressLine1, a.addressLine2, [a.postalCode, a.city].filter(Boolean).join(" ")].filter((s) => s && String(s).trim()).join(", ") : "";
const nm = (p) => p ? (p.displayName || p.name || [p.firstName, p.lastName].filter(Boolean).join(" ")) : "";
const clean = (o) => { const out = {}; for (const k in o) { const v = o[k]; if (v !== "" && v != null && !(Array.isArray(v) && !v.length)) out[k] = v; } return out; };

function toDocs(o, today) {
  const c = o.customer || {};
  const linjer = (o.orderLines || []).map((l) => clean({ p: (l.product && l.product.name) || "", b: l.description || "", a: l.count }));
  const tx = clean({
    kunde: c.name || "", kundenr: c.customerNumber || "",
    tlf: [c.phoneNumberMobile, c.phoneNumber].filter(Boolean).join(" / "), epost: c.email || o.receiverEmail || "",
    kadr: adr(c.postalAddress) || adr(c.physicalAddress), levadr: adr(o.deliveryAddress) || adr(c.deliveryAddress),
    kontakt: nm(o.contact), vaar: nm(o.ourContactEmployee) || nm(o.ourContact),
    ref: o.reference || "", kref: o.contractReference || "", prosjekt: o.project ? o.project.name || "" : "",
    odato: o.orderDate || "", lev: o.deliveryDate || "", levkom: o.deliveryComment || "", intern: o.internalComment || "",
    url: "https://tripletex.no/execute/projectMenu?projectId=" + o.id + "&isProject=false&contextId=" + CONTEXT,
    nr: String(o.number || ""), hentet: today,
  });
  const cand = clean({ tid: o.id, nr: String(o.number || ""), kunde: c.name || "", ref: o.reference || "", odato: o.orderDate || "", lev: o.deliveryDate || "", var: linjer });
  return { cand, tx, linjer };
}

const FIELDS = "id,number,orderDate,deliveryDate,reference,contractReference,deliveryComment,internalComment,receiverEmail,isClosed," +
  "customer(name,customerNumber,email,phoneNumber,phoneNumberMobile,postalAddress(*),physicalAddress(*),deliveryAddress(*))," +
  "deliveryAddress(*),contact(firstName,lastName),ourContactEmployee(firstName,lastName),ourContact(firstName,lastName),project(name)," +
  "orderLines(description,count,product(name))";

export async function txSync(env, bump) {
  const t0 = Date.now();
  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 25 * 3600e3).toISOString().slice(0, 10);
  let status;
  try {
    const all = [];
    for (let from = 0; from < 5000; from += 500) {
      const j = await txGet(env, "/order?isClosed=false&orderDateFrom=2015-01-01&orderDateTo=" + tomorrow + "&from=" + from + "&count=500&fields=" + encodeURIComponent(FIELDS));
      const vals = j.values || [];
      all.push(...vals);
      if (vals.length < 500) break;
    }
    const open = new Set(all.map((o) => String(o.id)));
    const rows = (await env.DB.prepare("SELECT coll,id,data FROM docs WHERE coll IN ('tripletex','ordre')").all()).results;
    const cands = {}, ordre = {};
    for (const r of rows) { const d = JSON.parse(r.data); if (r.coll === "tripletex") cands[String(d.tid)] = { id: r.id, d }; else if (d.tripletexId) ordre[String(d.tripletexId)] = { id: r.id, d }; }
    const stmts = []; let nye = 0, endret = 0;
    const now = Date.now();
    for (const o of all) {
      const { cand, tx, linjer } = toDocs(o, today);
      const ex = cands[String(o.id)];
      const sameTx = (a, b) => JSON.stringify({ ...a, hentet: 0 }) === JSON.stringify({ ...b, hentet: 0 });
      if (!ex) {
        nye++;
        stmts.push(env.DB.prepare("INSERT INTO docs(coll,id,data,updated) VALUES('tripletex',?,?,?)").bind("t" + o.id, JSON.stringify({ ...cand, tx, ny: now }), now));
      } else {
        const merged = { ...ex.d, ...cand, tx, lukket: false };
        if (JSON.stringify(ex.d.var) !== JSON.stringify(cand.var) || !ex.d.tx || !sameTx(ex.d.tx, tx) || ex.d.lukket || ex.d.lev !== cand.lev) {
          endret++;
          stmts.push(env.DB.prepare("UPDATE docs SET data=?, updated=? WHERE coll='tripletex' AND id=?").bind(JSON.stringify(merged), now, ex.id));
        }
      }
      const od = ordre[String(o.id)];
      if (od && (JSON.stringify(od.d.linjer) !== JSON.stringify(linjer) || !od.d.tx || !sameTx(od.d.tx, tx))) {
        stmts.push(env.DB.prepare("UPDATE docs SET data=?, updated=? WHERE coll='ordre' AND id=?").bind(JSON.stringify({ ...od.d, tx, linjer }), now, od.id));
        od.changed = true;
      }
    }
    for (const tid in cands) {
      if (!open.has(tid) && !cands[tid].d.lukket) stmts.push(env.DB.prepare("UPDATE docs SET data=?, updated=? WHERE coll='tripletex' AND id=?").bind(JSON.stringify({ ...cands[tid].d, lukket: true }), now, cands[tid].id));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    if (stmts.length) await bump(env);
    status = { ok: true, sist: now, apne: all.length, nye, endret, ms: Date.now() - t0, changedOrdre: Object.values(ordre).filter((x) => x.changed).map((x) => x.id) };
  } catch (e) {
    const old = JSON.parse((await metaGet(env, "txstatus")) || "{}");
    status = { ...old, ok: false, feil: String(e && e.message || e), feilTid: Date.now() };
  }
  const { changedOrdre, ...save } = status;
  await metaSet(env, "txstatus", JSON.stringify(save));
  return status;
}

// Kalles hvert minutt fra cron; synker hvert 30. minutt mellom 06 og 20, ellers hver 3. time.
export async function txMaybeSync(env, bump) {
  if (!(await metaGet(env, "txkey"))) return null;
  const st = JSON.parse((await metaGet(env, "txstatus")) || "{}");
  const last = Math.max(st.sist || 0, st.feilTid || 0);
  const h = new Date(Date.now() + 3600e3).getUTCHours();
  const gap = h >= 6 && h < 20 ? 30 * 60e3 : 3 * 3600e3;
  if (Date.now() - last < gap) return null;
  return txSync(env, bump);
}
