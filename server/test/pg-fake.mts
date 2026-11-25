// A stand-in for Supabase in tests: a real Postgres engine in memory (PGlite) with
// supabase/schema.sql loaded, reached through a fake `fetch` that answers the way Supabase's REST
// API answers a function call (POST <project url>/rest/v1/rpc/<function>, arguments by name in a
// JSON body, the function's result as JSON). So the store's own HTTP code and the real SQL are
// both under test; only Supabase's servers are not.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export type FakeCall = { fn: string; sent: number; received: number; status: number; args: any };
// bearer: how this stand-in wants the key. "refused" = in the apikey header alone (what Supabase
// documents for new-style sb_secret_ keys), "required" = as a bearer token as well (the older JWT
// keys). Default: by the look of the key.
export async function fakeSupabase(opts: { url?: string; key?: string; schema?: boolean; setEnv?: boolean; bearer?: "refused" | "required" } = {}) {
  const url = opts.url ?? "https://fake-project.supabase.test", key = opts.key ?? "sb_secret_test_key";
  const bearerRule = opts.bearer ?? (key.startsWith("sb_") ? "refused" : "required");
  const db = new PGlite();
  // Supabase's roles, and its habit of granting everything in "public" to all of them.
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
  const sigs = new Map<string, { name: string; type: string }[]>();
  const readSigs = async () => {
    sigs.clear();
    const r = await db.query<{ fn: string; names: string[] | null; types: string[] }>(
      `select p.proname as fn, p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'trade\\_%'`,
    );
    for (const row of r.rows) sigs.set(row.fn, row.types.map((type, i) => ({ name: row.names?.[i] ?? `$${i + 1}`, type })));
  };
  const runSchema = async () => {
    // Sent as ONE prepared statement, the strict way some SQL tools send a script: the setup
    // script must be a single command ("cannot insert multiple commands into a prepared statement").
    await db.query(fs.readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
    await readSigs();
  };
  if (opts.schema !== false) await runSchema();

  const calls: FakeCall[] = [];
  let down: null | { status: number; body: string } | "network" = null; // make the database fail on purpose
  const before = globalThis.fetch;
  const prefix = `${url}/rest/v1/rpc/`;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith(prefix)) return before(input, init);
    const fn = u.slice(prefix.length);
    const sent = Buffer.byteLength(String(init?.body ?? ""));
    const done = (status: number, body: unknown, args: any = null) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      calls.push({ fn, sent, received: Buffer.byteLength(text), status, args });
      return new Response(text, { status, headers: { "content-type": "application/json" } });
    };
    if (down === "network") throw new TypeError("fetch failed");
    if (down) return done(down.status, down.body);
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    if (init?.method !== "POST" || headers.get("apikey") !== key || (bearerRule === "required" ? auth !== `Bearer ${key}` : auth !== null) || /mozilla|chrome|safari/i.test(headers.get("user-agent") ?? ""))
      return done(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
    const args = JSON.parse(String(init?.body ?? "{}"));
    const sig = sigs.get(fn);
    // Like Supabase's API: a function is found by its name and the exact set of argument names.
    if (!sig || Object.keys(args).sort().join() !== sig.map((p) => p.name).sort().join())
      return done(404, { code: "PGRST202", message: `Could not find the function public.${fn}(${Object.keys(args).join(", ")}) in the schema cache`, details: null, hint: null }, args);
    try {
      // As the role a secret key stands for (service_role), in its own transaction: a missing
      // grant fails here as it would on Supabase, and an error undoes everything the call did.
      const out = await db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        return tx.query<{ r: unknown }>(
          `select public.${fn}(${sig.map((p, i) => `${p.name} => $${i + 1}::${p.type}`).join(", ")}) as r`,
          sig.map((p) => (args[p.name] === null || args[p.name] === undefined ? null : p.type === "jsonb" ? JSON.stringify(args[p.name]) : args[p.name])),
        );
      });
      return done(200, JSON.stringify(out.rows[0].r ?? null, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), args);
    } catch (e: any) {
      return done(e?.code === "42501" ? 403 : 400, { code: e?.code ?? "P0001", message: String(e?.message ?? e), details: null, hint: null }, args);
    }
  }) as typeof fetch;

  if (opts.setEnv !== false) {
    process.env.SUPABASE_URL = url;
    process.env.SUPABASE_SECRET_KEY = key; // the name Vercel's Supabase integration gives it
  }
  return {
    url, key, db, calls, runSchema,
    fail: (how: typeof down) => void (down = how),
    // bytes the database sent back since `from` (an index into calls)
    received: (from = 0) => calls.slice(from).reduce((s, c) => s + c.received, 0),
    count: (fn: string, from = 0) => calls.slice(from).filter((c) => c.fn === fn).length,
  };
}
