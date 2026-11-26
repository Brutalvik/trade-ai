// The agents' log for a stretch of days, as the Agent log tab and the Pipeline tab read it.
// The newest lines come with the account every few seconds (each agent's newest 200); the rest of
// the stretch is read from the week's log on the server when a tab asks for it, once a minute
// after that, and in pages on "older". Today, or the last 7 days (older lines are not kept).
// decisions = only the lines that decided something (each carries what it decided, `d`).
import { useEffect, useState } from "react";
import { useAccess } from "./Account";
import { allBots, api, STEP_BOT, type AppState, type LogLine } from "./api";

export const LOG_DAY = 86_400_000;
export const logId = (l: LogLine) => `${l.t}|${l.bot}|${l.msg}`;

export function useAgentLog(state: AppState | null, range: "today" | "week", decisions: boolean) {
  const { me } = useAccess();
  const [kept, setKept] = useState<LogLine[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bots = allBots(state);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const from = midnight - (range === "week" ? 6 * LOG_DAY : 0);
  const merge = (lines: LogLine[]) => setKept((old) => {
    const seen = new Set(old.map(logId));
    return [...old, ...lines.filter((l) => !seen.has(logId(l)))];
  });
  useEffect(() => {
    if (!me) return setKept([]);
    let off = false;
    setKept([]);
    setMore(false);
    const load = (first: boolean) => {
      if (first) setBusy(true);
      api.botLog(from, Date.now(), 500, decisions)
        .then((r) => {
          if (off) return;
          merge(r.lines);
          if (first) setMore(r.more);
          setErr("");
        })
        .catch((e) => !off && setErr(e.message))
        .finally(() => !off && first && setBusy(false));
    };
    load(true);
    const id = window.setInterval(() => load(false), 60_000);
    return () => {
      off = true;
      window.clearInterval(id);
    };
  }, [me?.username, from, decisions]); // eslint-disable-line react-hooks/exhaustive-deps
  // (the agents' own lines, and those of the quality step, which is no one agent)
  const live: LogLine[] = [...bots.flatMap((b) => b.bot.log.map((l) => ({ ...l, bot: b.id }))), ...(state?.stepLog ?? []).map((l) => ({ ...l, bot: STEP_BOT }))];
  // One copy of each line. Where the server sent a line's decision and the account's own copy
  // has none (a buy or sale from before decisions were kept with the lines), the server's is used.
  const byId = new Map<string, LogLine>();
  for (const l of live) byId.set(logId(l), l);
  for (const l of kept) { const mine = byId.get(logId(l)); if (!mine || (!mine.d && l.d)) byId.set(logId(l), l); }
  const lines = [...byId.values()].filter((l) => l.t >= from && (!decisions || l.d)).sort((a, b) => b.t - a.t);
  const older = () => {
    const oldest = kept.reduce((m, l) => Math.min(m, l.t), Date.now());
    setBusy(true);
    api.botLog(from, oldest, 500, decisions)
      .then((r) => {
        merge(r.lines);
        setMore(r.more);
        setErr("");
      })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return { lines, more, busy, err, older, bots, midnight, from };
}
