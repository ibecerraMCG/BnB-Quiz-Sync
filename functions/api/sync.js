// B&B quiz sync - a Cloudflare Pages Function, served at /api/sync.
//
// Needs a D1 database bound to this Pages project as SYNC_DB. The table is
// created on first use, so there is nothing to run by hand.
//
// A sync code is the only key: whoever has it can read and change that
// progress. One code covers every quiz; each quiz is kept separately under it.
//
// Writes are compare-and-swap on a revision number, done in a single
// statement, so two devices saving at once can never overwrite each other -
// the one that loses is handed the current copy to combine and send again.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const ID_RE = /^bnb-[a-z0-9]{20}$/;
const QUIZ_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_BYTES = 1_000_000;          // a heavy module exam is ~50 KB

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
// The stored state is already JSON; send it on without parsing it again.
function stored(row, status = 200, extra = "") {
  return new Response(
    "{" + extra + '"rev":' + row.rev + ',"at":' + row.at + ',"state":' + row.state + "}",
    { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

let ready = false;
async function table(db) {
  if (ready) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS progress (" +
    "id TEXT NOT NULL, quiz TEXT NOT NULL, rev INTEGER NOT NULL, " +
    "state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (id, quiz))"
  ).run();
  ready = true;
}
function current(db, id, quiz) {
  return db.prepare("SELECT rev, state, at FROM progress WHERE id = ?1 AND quiz = ?2")
           .bind(id, quiz).first();
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!env.SYNC_DB) return json({ error: "no database bound as SYNC_DB" }, 500);
  const u = new URL(request.url);
  const id = u.searchParams.get("id") || "", quiz = u.searchParams.get("quiz") || "";
  if (!ID_RE.test(id) || !QUIZ_RE.test(quiz)) return json({ error: "bad request" }, 400);
  await table(env.SYNC_DB);
  const row = await current(env.SYNC_DB, id, quiz);
  return row ? stored(row) : json({ rev: 0, state: null });
}

export async function onRequestPut({ request, env }) {
  if (!env.SYNC_DB) return json({ error: "no database bound as SYNC_DB" }, 500);
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: "too large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: "bad json" }, 400); }

  const { id, quiz, baseRev, state } = body || {};
  if (!ID_RE.test(id || "") || !QUIZ_RE.test(quiz || "")) return json({ error: "bad request" }, 400);
  if (!Number.isInteger(baseRev) || baseRev < 0) return json({ error: "bad rev" }, 400);
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      !Object.values(state).every(v => typeof v === "string")) {
    return json({ error: "bad state" }, 400);
  }

  const db = env.SYNC_DB;
  await table(db);
  const now = Date.now(), s = JSON.stringify(state);
  const res = baseRev === 0
    ? await db.prepare(
        "INSERT INTO progress (id, quiz, rev, state, at) VALUES (?1, ?2, 1, ?3, ?4) " +
        "ON CONFLICT (id, quiz) DO NOTHING").bind(id, quiz, s, now).run()
    : await db.prepare(
        "UPDATE progress SET rev = rev + 1, state = ?3, at = ?4 " +
        "WHERE id = ?1 AND quiz = ?2 AND rev = ?5").bind(id, quiz, s, now, baseRev).run();

  if (res && res.meta && res.meta.changes === 1) return json({ rev: baseRev + 1, at: now });

  // Someone else saved first. Hand back what is there now, to be combined and
  // sent again; if nothing is there at all, revision 0 says "start afresh".
  const row = await current(db, id, quiz);
  return row ? stored(row, 409, '"error":"conflict",')
             : json({ error: "conflict", rev: 0, state: null }, 409);
}
