// Varsler (Web Push) for Arbeidsplan Grindberg
const enc = new TextEncoder();
const b64u = (buf) => { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (str) => { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
const cat = (...arrs) => { const n = arrs.reduce((t, a) => t + a.length, 0); const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };

let ready = false;
export async function ensurePushTables(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pushsub (endpoint TEXT PRIMARY KEY, navn TEXT, sub TEXT NOT NULL, lang TEXT, created INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pushq (id INTEGER PRIMARY KEY AUTOINCREMENT, navn TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, t INTEGER NOT NULL)"),
  ]);
  ready = true;
}

async function vapid(env) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k='vapid'").first();
  if (r) return JSON.parse(r.v);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  const v = { priv, pub };
  await env.DB.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('vapid',?)").bind(JSON.stringify(v)).run();
  const again = await env.DB.prepare("SELECT v FROM meta WHERE k='vapid'").first();
  return JSON.parse(again.v);
}
export async function vapidPublic(env) { return (await vapid(env)).pub; }

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
}

async function encrypt(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function jwt(env, aud) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://plan.grindberg.no" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return { token: head + "." + body + "." + b64u(sig), pub: v.pub };
}

export async function sendPush(env, sub, msg) {
  const u = new URL(sub.endpoint);
  const { token, pub } = await jwt(env, u.origin);
  const body = await encrypt(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal", authorization: "vapid t=" + token + ", k=" + pub },
    body,
  });
  if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM pushsub WHERE endpoint=?").bind(sub.endpoint).run();
  return r.status;
}

// ---------- tekster ----------
const TXT = {
  no: { ny: "Ny jobb", nye: (n) => n + " nye jobber", til: "til deg", besk: "Ny ukebeskjed", bAlle: "Beskjed til alle", bDeg: "Beskjed til deg", dager: ["søn", "man", "tir", "ons", "tor", "fre", "lør"], mnd: ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"], test: "Varsler er på. Du får beskjed når du får en ny jobb." },
  en: { ny: "New job", nye: (n) => n + " new jobs", til: "for you", besk: "New weekly note", bAlle: "Message to everyone", bDeg: "Message for you", dager: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], mnd: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], test: "Notifications are on. You will be told when you get a new job." },
  uk: { ny: "Нове завдання", nye: (n) => "Нових завдань: " + n, til: "для вас", besk: "Нове повідомлення на тиждень", bAlle: "Повідомлення для всіх", bDeg: "Повідомлення для вас", dager: ["нд", "пн", "вт", "ср", "чт", "пт", "сб"], mnd: ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"], test: "Сповіщення увімкнено. Ви отримаєте повідомлення, коли з’явиться нове завдання." },
};
const T = (lang) => TXT[lang] || TXT.no;
const tr = (doc, path, lang) => (lang !== "no" && doc && doc._tr && doc._tr[lang] && doc._tr[lang][path]) || (doc ? doc[path] : "") || "";
const dag = (iso, lang) => { if (!iso) return ""; const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); const t = T(lang); return t.dager[dt.getUTCDay()] + " " + d + ". " + t.mnd[m - 1]; };
export function testMessage(lang) { return { title: "Arbeidsplan Grindberg", body: T(lang).test, tag: "test", url: "./" }; }

// ---------- kø ----------
const today = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
export async function queueTask(env, before, after, id) {
  if (!after || !after.hvem || after.ferdig) return;
  if (after.dato && after.dato < today()) return;
  if (before && before.hvem === after.hvem && before.dato === after.dato) return; // bare tekst endret: ikke varsle
  await ensurePushTables(env);
  await env.DB.prepare("INSERT INTO pushq(navn,kind,ref,t) VALUES(?,?,?,?)").bind(after.hvem, "jobb", id, Date.now()).run();
}
export async function queueNote(env, before, after, id) {
  const a = (after && after.tekst || "").trim();
  if (!a || (before && (before.tekst || "").trim() === a)) return;
  await ensurePushTables(env);
  await env.DB.prepare("DELETE FROM pushq WHERE kind='beskjed' AND ref=?").bind(id).run();
  await env.DB.prepare("INSERT INTO pushq(navn,kind,ref,t) VALUES('*','beskjed',?,?)").bind(id, Date.now()).run();
}

export async function queueMessage(env, after, id) {
  const til = (after && after.til) || "*";
  if (!after || !(after.tekst || "").trim()) return;
  await ensurePushTables(env);
  await env.DB.prepare("INSERT INTO pushq(navn,kind,ref,t) VALUES(?,?,?,?)").bind(til, "melding", id, Date.now()).run();
}

// Kjøres hvert minutt. Venter litt så flere jobber blir samlet i ett varsel, og oversettelsen rekker å bli ferdig.
export async function flushQueue(env) {
  await ensurePushTables(env);
  const cutoff = Date.now() - 60e3;
  const q = (await env.DB.prepare("SELECT * FROM pushq ORDER BY id").all()).results;
  if (!q.length) return;
  const navn = [...new Set(q.map((x) => x.navn))];
  // vent til det har vært stille i ett minutt for hver mottaker
  const due = navn.filter((n) => Math.max(...q.filter((x) => x.navn === n).map((x) => x.t)) < cutoff);
  if (!due.length) return;
  const subs = (await env.DB.prepare("SELECT * FROM pushsub").all()).results;
  const getDoc = async (coll, id) => { const r = await env.DB.prepare("SELECT data FROM docs WHERE coll=? AND id=?").bind(coll, id).first(); return r ? JSON.parse(r.data) : null; };
  for (const n of due) {
    const items = q.filter((x) => x.navn === n);
    await env.DB.prepare("DELETE FROM pushq WHERE id IN (" + items.map((x) => x.id).join(",") + ")").run();
    for (const it of items.filter((x) => x.kind === "melding")) {
      const b = await getDoc("beskjeder", it.ref); if (!b || !b.tekst) continue;
      for (const s of subs.filter((x) => n === "*" || x.navn === n)) {
        const lang = s.lang || "no"; const txt = tr(b, "tekst", lang);
        const title = (n === "*" ? T(lang).bAlle : T(lang).bDeg) + (b.fra ? " · " + b.fra : "");
        try { await sendPush(env, JSON.parse(s.sub), { title, body: txt.length > 300 ? txt.slice(0, 298) + "…" : txt, tag: "melding-" + it.ref, url: "./" }); } catch (e) {}
      }
    }
    if (n === "*") {
      for (const it of items.filter((x) => x.kind === "beskjed")) {
        const u = await getDoc("uker", it.ref); if (!u || !u.tekst) continue;
        for (const s of subs) {
          const lang = s.lang || "no"; const txt = tr(u, "tekst", lang);
          try { await sendPush(env, JSON.parse(s.sub), { title: T(lang).besk, body: txt.length > 240 ? txt.slice(0, 238) + "…" : txt, tag: "beskjed-" + it.ref, url: "./" }); } catch (e) {}
        }
      }
      continue;
    }
    const jobs = [];
    for (const it of items.filter((x) => x.kind === "jobb")) { if (jobs.some((j) => j.id === it.ref)) continue; const d = await getDoc("oppgaver", it.ref); if (d && d.hvem === n && !d.ferdig) jobs.push({ id: it.ref, d }); }
    if (!jobs.length) continue;
    jobs.sort((a, b) => String(a.d.dato).localeCompare(String(b.d.dato)));
    const mine = subs.filter((s) => s.navn === n);
    for (const s of mine) {
      const lang = s.lang || "no"; const t = T(lang);
      const lines = [];
      for (const j of jobs) {
        const o = j.d.ordreId ? await getDoc("ordre", j.d.ordreId) : null;
        const what = tr(j.d, "tekst", lang) || (o ? [o.nr, o.navn].filter(Boolean).join(" ") : "");
        lines.push(dag(j.d.dato, lang) + ": " + (o && o.nr && what.indexOf(o.nr) < 0 ? o.nr + " · " : "") + what);
      }
      const title = jobs.length === 1 ? t.ny + " · " + dag(jobs[0].d.dato, lang) : t.nye(jobs.length);
      const body = jobs.length === 1 ? lines[0].replace(/^[^:]+: /, "") : lines.slice(0, 6).join("\n") + (lines.length > 6 ? "\n…" : "");
      try { await sendPush(env, JSON.parse(s.sub), { title, body: body.length > 300 ? body.slice(0, 298) + "…" : body, tag: "jobb-" + n, url: "./" }); } catch (e) {}
    }
  }
}
