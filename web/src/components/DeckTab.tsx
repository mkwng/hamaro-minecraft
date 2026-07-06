import { useEffect, useMemo, useRef, useState } from "react";
import { api, WARP_GLYPHS, type OnlinePlayer, type Warp, type InvItem } from "../api";
import { useAsync, useInterval } from "../hooks";
import { useOpStatus } from "./AdminPanel";
import { CATEGORIES, FAVORITES, EFFECTS, MOBS, GAMEMODES, categorize, type Category } from "../deck";

type FeedEntry = { ts: number; who: string; commands: string[]; undo?: string[] };
type Recipe = { steps: string[] };

// Hold-to-confirm button for destructive verbs.
export function HoldButton({ label, onFire, ms = 900 }: { label: string; onFire: () => void; ms?: number }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<number>(0);
  const start = () => { setHeld(true); timer.current = window.setTimeout(() => { setHeld(false); onFire(); }, ms); };
  const cancel = () => { setHeld(false); clearTimeout(timer.current); };
  return (
    <button className={"danger holdbtn" + (held ? " holding" : "")}
      onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel}
      title="press and hold">
      {label}
    </button>
  );
}

export default function DeckTab({ serverUp }: { serverUp: boolean }) {
  const flash = useOpStatus();
  const [online, setOnline] = useState<OnlinePlayer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [warpsData] = useAsync(() => api<{ warps: Record<string, Warp> }>("/warps"));
  const [items, setItems] = useState<string[]>([]);
  const [cat, setCat] = useState<Category | "all">("favorites");
  const [query, setQuery] = useState("");
  const [qty, setQty] = useState(1);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const [recording, setRecording] = useState<string[] | null>(null);
  const [inv, setInv] = useState<{ player: string; items: InvItem[] } | null>(null);

  const warps = warpsData?.warps || {};
  const targets = [...selected].filter((p) => online.some((o) => o.name === p));

  // ---------- data loading ----------
  const loadOnline = () => serverUp && api<{ online: OnlinePlayer[] }>("/players")
    .then((r) => {
      setOnline(r.online);
      setSelected((s) => new Set([...s].filter((n) => r.online.some((o) => o.name === n))));
    }).catch(() => {});
  useEffect(() => { loadOnline(); }, [serverUp]);
  useInterval(loadOnline, 12000);
  useEffect(() => { fetch("/items/index.json").then((r) => r.json()).then(setItems).catch(() => {}); }, []);
  useEffect(() => { api<{ actions: FeedEntry[] }>("/actions").then((r) => setFeed(r.actions)).catch(() => {}); }, []);
  useEffect(() => { api<{ recipes: Record<string, Recipe> }>("/recipes").then((r) => setRecipes(r.recipes)).catch(() => {}); }, []);

  // ---------- the one way commands leave the Deck ----------
  async function run(templates: string[], opts: { undo?: string[]; needsTargets?: boolean } = {}) {
    if (opts.needsTargets !== false && templates.some((t) => t.includes("{player}")) && targets.length === 0) {
      return flash("✖ select at least one player first");
    }
    const commands = templates.flatMap((t) =>
      t.includes("{player}") ? targets.map((p) => t.replaceAll("{player}", p)) : [t]);
    if (recording) { setRecording([...recording, ...templates]); }
    setFeed((f) => [{ ts: Date.now(), who: "you", commands, undo: opts.undo }, ...f].slice(0, 60));
    try {
      await api("/commands", { method: "POST", body: JSON.stringify({ commands }) });
      flash(`✔ ${commands.length} command${commands.length === 1 ? "" : "s"} sent`);
    } catch (e: any) { flash("✖ " + e.message); }
  }

  // ---------- palette ----------
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    let pool = q ? items.filter((i) => i.includes(q))
      : cat === "all" ? items
      : cat === "favorites" ? FAVORITES.filter((f) => items.includes(f))
      : items.filter((i) => categorize(i) === cat);
    return pool.slice(0, 120);
  }, [items, cat, query]);

  const give = (item: string) => {
    if (inv && !targets.includes(inv.player)) {
      // palette click while an inventory is open gives to that player
      run([`give ${inv.player} ${item} ${qty}`], { needsTargets: false }).then(() => peek(inv.player));
    } else {
      run([`give {player} ${item} ${qty}`]);
    }
  };

  async function peek(player: string) {
    try {
      const r = await api<{ items: InvItem[] }>(`/players/${player}/inventory`);
      setInv({ player, items: r.items });
    } catch (e: any) { flash("✖ " + e.message); }
  }

  // ---------- recipes ----------
  async function saveRecording() {
    if (!recording?.length) { setRecording(null); return; }
    const name = prompt("Name this recipe:", "birthday kit");
    if (name) {
      const r = await api<{ recipes: Record<string, Recipe> }>("/recipes", {
        method: "PUT", body: JSON.stringify({ name, steps: recording }),
      });
      setRecipes(r.recipes);
      flash(`✔ recipe "${name}" saved (${recording.length} steps)`);
    }
    setRecording(null);
  }

  if (!serverUp) return <p className="hint">(the Deck needs the server fully awake — if it's starting or going to sleep, this activates by itself in a minute)</p>;

  return (
    <div className="deck">
      {/* ---------------- player rail ---------------- */}
      <h3 style={{ marginTop: 0 }}>Players <span className="hint">(click to select targets)</span></h3>
      <div className="rail">
        {online.length === 0 && <p className="hint">(nobody online)</p>}
        {online.map((p) => (
          <div key={p.name}
            className={"pcard" + (selected.has(p.name) ? " sel" : "")}
            onClick={() => setSelected((s) => {
              const n = new Set(s); n.has(p.name) ? n.delete(p.name) : n.add(p.name); return n;
            })}>
            <img src={`/avatars/${p.name}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
            <b>{p.name}</b>
            <span className="pstats">
              ❤ {p.health ?? "?"} 🍗 {p.food ?? "?"} ✦ {p.xp ?? 0}
              <em>{p.gamemode || "?"}</em>
            </span>
            <span className="hint">{p.x}, {p.y}, {p.z}</span>
            <button onClick={(e) => { e.stopPropagation(); peek(p.name); }}>🎒</button>
          </div>
        ))}
        {online.length > 1 && (
          <button onClick={() => setSelected(selected.size === online.length ? new Set() : new Set(online.map((o) => o.name)))}>
            {selected.size === online.length ? "none" : "everyone"}
          </button>
        )}
      </div>

      {/* ---------------- inventory editor ---------------- */}
      {inv && (
        <div className="invpanel">
          <h3>🎒 {inv.player}'s inventory <span className="hint">(click palette to give · ✕ to take)</span>
            <button style={{ float: "right" }} onClick={() => setInv(null)}>close</button></h3>
          <div className="inv">
            {inv.items.length === 0 && <span className="hint">(empty)</span>}
            {inv.items.map((it) => (
              <span className="invitem" key={it.slot}>
                <img src={`/items/${it.item}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                {it.item}<em>×{it.count}</em>
                <button className="mini" title="take away" onClick={() =>
                  run([`clear ${inv.player} minecraft:${it.item} ${it.count}`], { needsTargets: false }).then(() => peek(inv.player))
                }>✕</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- item palette ---------------- */}
      <h3>Give items {inv ? <span className="hint">→ {inv.player}'s backpack</span> : <span className="hint">→ selected players</span>}</h3>
      <div className="row" style={{ marginTop: 4 }}>
        <input placeholder="search items…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {[1, 16, 64].map((n) => (
          <button key={n} className={qty === n ? "primary" : ""} onClick={() => setQty(n)}>×{n}</button>
        ))}
      </div>
      <div className="cattabs">
        {["all", ...CATEGORIES].map((c) => (
          <button key={c} className={"tab" + (cat === c && !query ? " active" : "")} onClick={() => { setCat(c as any); setQuery(""); }}>{c}</button>
        ))}
      </div>
      <div className="palette">
        {shown.map((i) => (
          <button key={i} className="palitem" title={`give ${qty}× ${i}`} onClick={() => give(i)}>
            <img src={`/items/${i}.png`} alt={i} loading="lazy" />
            <span>{i.replaceAll("_", " ")}</span>
          </button>
        ))}
        {shown.length === 0 && <span className="hint">no matches</span>}
      </div>

      {/* ---------------- action deck ---------------- */}
      <h3>Effects <span className="hint">(60s on selected)</span></h3>
      <div className="btnwrap">
        {EFFECTS.map((e) => (
          <button key={e.id} onClick={() => run([`effect give {player} minecraft:${e.id} 60 1`])}>{e.label}</button>
        ))}
        <button onClick={() => run([`effect clear {player}`])}>🚿 clear effects</button>
      </div>

      <h3>Players</h3>
      <div className="btnwrap">
        {GAMEMODES.map((g) => (
          <button key={g} onClick={() => {
            const undo = online.filter((o) => targets.includes(o.name) && o.gamemode)
              .map((o) => `gamemode ${o.gamemode} ${o.name}`);
            run([`gamemode ${g} {player}`], { undo });
          }}>{g === "creative" ? "🪄" : g === "survival" ? "⛏" : g === "adventure" ? "🗺" : "👁"} {g}</button>
        ))}
        {Object.entries(warps).map(([name, w]) => (
          <button key={name} onClick={() => {
            const undo = online.filter((o) => targets.includes(o.name))
              .map((o) => `execute in minecraft:${o.dimension || "overworld"} run tp ${o.name} ${o.x} ${o.y} ${o.z}`);
            run([`execute in ${w.dimension} run tp {player} ${w.x} ${w.y} ${w.z}`], { undo });
          }}>{WARP_GLYPHS[w.type || "pin"]}→ {name}</button>
        ))}
        <HoldButton label="💀 kill" onFire={() => run(["kill {player}"])} />
        <HoldButton label="🗑 empty inventory" onFire={() => run(["clear {player}"])} />
      </div>

      <h3>Spawn a friend <span className="hint">(at each selected player)</span></h3>
      <div className="btnwrap">
        {MOBS.map((m) => (
          <button key={m} onClick={() => run([`execute at {player} run summon minecraft:${m} ~ ~ ~`])}>
            <img className="eggicon" src={`/items/${m}_spawn_egg.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
            {m}
          </button>
        ))}
      </div>

      <h3>World</h3>
      <div className="btnwrap">
        <button onClick={() => run(["time set day"], { needsTargets: false })}>🌞 day</button>
        <button onClick={() => run(["time set night"], { needsTargets: false })}>🌙 night</button>
        <button onClick={() => run(["weather clear 6000"], { needsTargets: false })}>☀️ clear</button>
        <button onClick={() => run(["weather rain 600"], { needsTargets: false })}>🌧 rain</button>
        <button onClick={() => run(["weather thunder 300"], { needsTargets: false })}>⛈ thunder</button>
        <button onClick={() => run(["gamerule keepInventory true"], { needsTargets: false })}>😌 keep items on death</button>
        <button onClick={() => run(["gamerule keepInventory false"], { needsTargets: false })}>😈 drop items on death</button>
        {["peaceful", "easy", "normal", "hard"].map((d) => (
          <button key={d} onClick={() => run([`difficulty ${d}`], { needsTargets: false })}>{d}</button>
        ))}
      </div>

      {/* ---------------- recipes ---------------- */}
      <h3>Recipes <span className="hint">(repeatable action sequences)</span></h3>
      <div className="btnwrap">
        {recording === null
          ? <button onClick={() => { setRecording([]); flash("● recording — every Deck action becomes a step"); }}>● record new recipe</button>
          : <button className="primary" onClick={saveRecording}>■ stop & save ({recording.length} steps)</button>}
        {Object.entries(recipes).map(([name, r]) => (
          <span className="recipechip" key={name}>
            <button className="primary" title={r.steps.join("\n")}
              onClick={() => api(`/recipes/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ players: targets }) })
                .then((res: any) => flash(`✔ ran "${name}" (${res.count} commands)`))
                .catch((e) => flash("✖ " + e.message))}>▶ {name}</button>
            <button className="mini" onClick={async () => {
              if (!confirm(`Delete recipe "${name}"?`)) return;
              const res = await api<{ recipes: Record<string, Recipe> }>(`/recipes/${encodeURIComponent(name)}`, { method: "DELETE" });
              setRecipes(res.recipes);
            }}>✕</button>
          </span>
        ))}
      </div>

      {/* ---------------- action feed ---------------- */}
      <h3>Recent actions <span className="hint">(the real commands — watch and learn)</span></h3>
      <div className="feed">
        {feed.slice(0, 12).map((f, i) => (
          <div key={f.ts + "-" + i} className="feeditem">
            <span className="hint">{new Date(f.ts).toLocaleTimeString()} · {f.who}</span>
            <code>{f.commands.slice(0, 3).join("  ·  ")}{f.commands.length > 3 ? `  (+${f.commands.length - 3})` : ""}</code>
            <span className="spacer" />
            {f.undo && <button className="mini" onClick={() => run(f.undo!, { needsTargets: false })}>↩ undo</button>}
            <button className="mini" title="run again" onClick={() =>
              api("/commands", { method: "POST", body: JSON.stringify({ commands: f.commands }) })
                .then(() => flash("✔ re-ran")).catch((e) => flash("✖ " + e.message))}>↻</button>
          </div>
        ))}
      </div>
    </div>
  );
}
