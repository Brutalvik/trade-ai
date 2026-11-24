// A stand-in for the old Upstash database in tests, at the level of its REST API, so the real
// Upstash client is what talks to it: commands arrive as JSON arrays (one, or several to
// /pipeline), results go back as {"result": ...}, text base64-encoded when the client asks for it.
// Only the five reads the move uses are answered. block(true) makes it refuse everything the way
// the real one did on 24 Nov 2026.
export const UPSTASH_LIMIT = "ERR This database has reached current Fixed plan limits. Please upgrade manually or enable auto upgrade on Upstash Console";

export function fakeUpstash(url: string, data: { strings: Map<string, { v: unknown; ttl?: number }>; lists: Map<string, unknown[]> }, opts: { blocked?: boolean } = {}) {
  const { strings, lists } = data;
  const state = { blocked: opts.blocked ?? false, calls: 0 };
  const raw = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const enc = (x: any): any => (typeof x === "string" ? (x === "OK" ? x : Buffer.from(x).toString("base64")) : Array.isArray(x) ? x.map(enc) : x);
  const command = (cmd: any[]): unknown => {
    const [name, ...a] = cmd;
    switch (String(name).toLowerCase()) {
      case "scan": {
        const opt = (n: string) => { const i = a.findIndex((x) => String(x).toLowerCase() === n); return i >= 0 ? a[i + 1] : undefined; };
        const all = [...strings.keys(), ...lists.keys()].filter((k) => k.startsWith(String(opt("match") ?? "").replace(/\*$/, ""))).sort();
        const at = Number(a[0]), next = at + 5; // small pages, so the paging is exercised
        return [next >= all.length ? "0" : String(next), all.slice(at, next)];
      }
      case "get": return strings.has(a[0]) ? raw(strings.get(a[0])!.v) : null;
      case "pttl": return strings.has(a[0]) ? (strings.get(a[0])!.ttl ?? -1) : lists.has(a[0]) ? -1 : -2;
      case "llen": return lists.get(a[0])?.length ?? 0;
      case "lrange": return (lists.get(a[0]) ?? []).slice(Number(a[1]), Number(a[2]) + 1).map(raw);
      default: throw new Error(`ERR unknown command '${name}'`);
    }
  };
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith(url)) return before(input, init);
    state.calls++;
    const body = JSON.parse(String(init?.body ?? "[]"));
    const reply = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (state.blocked) return reply(400, { error: `${UPSTASH_LIMIT}, command was: ${JSON.stringify(body)}` });
    const b64 = new Headers(init?.headers).get("upstash-encoding") === "base64";
    const one = (cmd: any[]) => { try { const res = command(cmd); return { result: b64 ? enc(res) : res }; } catch (e: any) { return { error: e.message }; } };
    const path = u.replace(/\/$/, "");
    return path.endsWith("/pipeline") || path.endsWith("/multi-exec") ? reply(200, body.map(one)) : reply(200, one(body));
  }) as typeof fetch;
  return { get calls() { return state.calls; }, block: (on: boolean) => void (state.blocked = on) };
}

// What a small old database holds: two accounts, logins and settings, history lists, a lock.
export function sampleOldData() {
  const P = "trade-ai:state";
  const strings = new Map<string, { v: unknown; ttl?: number }>();
  const lists = new Map<string, unknown[]>();
  strings.set(`${P}:u:ada`, { v: { cash: 812.5, startCash: 1000, trades: Array.from({ length: 40 }, (_x, i) => ({ id: `t${i}`, usd: 100 + i })), equity: [{ t: 1, v: 1000 }], positions: [{ id: "p1", symbol: "FOOD", qty: 3 }], bot: { running: true, config: { pick: "agent", symbol: "FOOD" }, log: [{ t: 1, msg: "bought" }] }, resetAt: 7 } });
  strings.set(`${P}:u:bob`, { v: { cash: 1000, trades: [] } });
  strings.set(`${P}:kv:user:ada`, { v: { username: "ada", email: "ada@example.test", hash: "scrypt$abc", plan: "max", role: "admin" } });
  strings.set(`${P}:kv:email:ada@example.test`, { v: "ada" });
  strings.set(`${P}:kv:auth:secret`, { v: "00ff11ee22dd33cc" });
  strings.set(`${P}:kv:owner`, { v: "ada" });
  strings.set(`${P}:kv:migrated-to-accounts`, { v: true });
  strings.set(`${P}:kv:active-accounts`, { v: ["ada"] });
  strings.set(`${P}:kv:ctl:ada`, { v: { resetAt: 7, stops: { "2": 99 } } });
  strings.set(`${P}:kv:usage:ada:2026-11`, { v: 1234567 });
  strings.set(`${P}:kv:lists:week`, { v: { mintA: { n: 3 } }, ttl: 86_400_000 });
  strings.set(`${P}:lock:watch:ada`, { v: 1 });
  lists.set(`${P}:list:ledger:ada`, Array.from({ length: 1234 }, (_x, i) => ({ n: i, symbol: "FOOD" })));
  lists.set(`${P}:list:audit:ada`, Array.from({ length: 30 }, (_x, i) => ({ n: i, type: "ai.use" })));
  lists.set(`${P}:list:audit:bob`, []);
  return { strings, lists };
}
