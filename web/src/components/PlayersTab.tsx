import { useEffect, useMemo, useRef, useState } from "react";
import { api, bus, WARP_GLYPHS, type OnlinePlayer, type Warp, type InvItem } from "../api";
import { useAsync, useInterval } from "../hooks";
import { useOpStatus } from "./AdminPanel";
import Drawer from "./Drawer";
import { CATEGORIES, FAVORITES, EFFECTS, MOBS, GAMEMODES, categorize, type Category } from "../deck";

type FeedEntry = { ts: number; who: string; commands: string[]; undo?: string[] };
type Recipe = { steps: string[] };

export function HoldButton({ label, onFire, ms = 900 }: { label: string; onFire: () => void; ms?: number }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<number>(0);
  const start = () => { setHeld(true); timer.current = window.setTimeout(() => { setHeld(false); onFire(); }, ms); };
  const cancel = () => { setHeld(false); clearTimeout(timer.current); };
  return (
    <button className={"danger holdbtn" + (held ? " holding" : "")}
      onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel} title="press and hold">
      {label}
    </button>
  );
}

// NB: must stay at module level — defined inside PlayersTab, React would see a
// fresh component type on every render and remount it, wiping the input while
// the 12s players poll is running.
function RoleList({ title, subtitle, role, names, onChange }: {
  title: string; subtitle?: string; role: "whitelist" | "op"; names: string[]; onChange: (n: string[]) => void;
}) {
  const flash = useOpStatus();
  const [name, setName] = useState("");
  const key = role === "op" ? "ops" : "whitelist";
  const act = async (n: string, action: "add" | "remove") => {
    try {
      const r = await api<any>(`/players/${role}`, { method: "POST", body: JSON.stringify({ name: n, action }) });
      onChange(r[key]);
      flash(`✔ ${action === "add" ? "added" : "removed"} ${n} (${r.applied})`);
    } catch (e: any) { flash("✖ " + e.message); }
  };
  return (
    <>
      <h3>{title} {subtitle && <span className="hint">({subtitle})</span>}</h3>
      <ul className="list">
        {names.map((n) => <li key={n}>{n}<span className="spacer" /><button onClick={() => act(n, "remove")}>Remove</button></li>)}
      </ul>
      <div className="row">
        <input placeholder="Minecraft username" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name && (act(name, "add"), setName(""))} />
        <button onClick={() => { if (name) { act(name, "add"); setName(""); } }}>Add</button>
      </div>
    </>
  );
}

// Everything about PEOPLE: who's online (and doing things to/for them),
// recipes (player-action macros), and who's allowed in (whitelist/ops).
export default function PlayersTab({ serverUp }: { serverUp: boolean }) {
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
  const [cart, setCart] = useState<{ item: string; qty: number }[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");
  const [inv, setInv] = useState<{ player: string; items: InvItem[] } | null>(null);
  const [wl, setWl] = useState<string[] | null>(null);
  const [ops, setOps] = useState<string[] | null>(null);
  const [editRecipe, setEditRecipe] = useState<{ name: string; text: string } | null>(null);

  const warps = warpsData?.warps || {};
  const targets = [...selected].filter((p) => online.some((o) => o.name === p));

  // Keep previous state identities when a poll brings no news, so refreshes
  // that change nothing don't rerender the whole tab.
  const loadOnline = () => serverUp && api<{ online: OnlinePlayer[] }>("/players")
    .then((r) => {
      setOnline((prev) => (JSON.stringify(prev) === JSON.stringify(r.online) ? prev : r.online));
      setSelected((s) => {
        const keep = [...s].filter((n) => r.online.some((o) => o.name === n));
        return keep.length === s.size ? s : new Set(keep);
      });
    }).catch(() => {});
  useEffect(() => { loadOnline(); }, [serverUp]);
  useInterval(loadOnline, 20000); // each call opens 2 real RCON connections server-side — slower is quieter
  useEffect(() => { fetch("/items/index.json").then((r) => r.json()).then(setItems).catch(() => {}); }, []);
  useEffect(() => { api<{ recipes: Record<string, Recipe> }>("/recipes").then((r) => setRecipes(r.recipes)).catch(() => {}); }, []);

  const loadRoles = async () => {
    const r = await api<{ active: string }>("/profiles");
    const p = await api<{ env: string }>(`/profiles/${r.active}`);
    const get = (k: string) => (p.env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
    setWl(get("WHITELIST")); setOps(get("OPS"));
  };
  useEffect(() => { loadRoles().catch(() => {}); }, []);
  // Approvals from the notification bell change the whitelist — pick them up live.
  useEffect(() => {
    const h = () => loadRoles().catch(() => {});
    bus.addEventListener("roles-changed", h);
    return () => bus.removeEventListener("roles-changed", h);
  }, []);

  async function run(templates: string[], opts: { undo?: string[] } = {}): Promise<boolean> {
    if (templates.some((t) => t.includes("{player}")) && targets.length === 0) {
      flash("✖ select at least one player first");
      return false;
    }
    const commands = templates.flatMap((t) =>
      t.includes("{player}") ? targets.map((p) => t.replaceAll("{player}", p)) : [t]);
    if (recording) setRecording([...recording, ...templates]);
    setFeed((f) => [{ ts: Date.now(), who: "you", commands, undo: opts.undo }, ...f].slice(0, 20));
    try {
      await api("/commands", { method: "POST", body: JSON.stringify({ commands }) });
      flash(`✔ ${commands.length} command${commands.length === 1 ? "" : "s"} sent`);
      return true;
    } catch (e: any) { flash("✖ " + e.message); return false; }
  }

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    const pool = q ? items.filter((i) => i.includes(q))
      : cat === "all" ? items
      : cat === "favorites" ? FAVORITES.filter((f) => items.includes(f))
      : items.filter((i) => categorize(i) === cat);
    return pool.slice(0, 120);
  }, [items, cat, query]);

  // Item clicks fill a cart; nothing reaches the server until "Send". The cart
  // ships to the open backpack if one is open, otherwise to the selected players.
  const addToCart = (item: string) => {
    setSent("");
    setCart((c) => {
      const i = c.findIndex((e) => e.item === item);
      return i < 0 ? [...c, { item, qty }] : c.map((e, j) => (j === i ? { ...e, qty: e.qty + qty } : e));
    });
  };

  async function sendCart() {
    const recipients = inv ? [inv.player] : targets;
    if (recipients.length === 0) return flash("✖ select at least one player first");
    setSending(true);
    const templates = cart.map((e) => (inv ? `give ${inv.player} ${e.item} ${e.qty}` : `give {player} ${e.item} ${e.qty}`));
    const ok = await run(templates);
    setSending(false);
    if (ok) {
      setSent(`✔ sent ${cart.reduce((s, e) => s + e.qty, 0)} item${cart.length === 1 && cart[0].qty === 1 ? "" : "s"} to ${recipients.join(", ")}`);
      setCart([]);
      if (inv) peek(inv.player);
      window.setTimeout(() => setSent(""), 6000);
    }
  }

  async function peek(player: string) {
    try {
      const r = await api<{ items: InvItem[] }>(`/players/${player}/inventory`);
      setInv({ player, items: r.items });
    } catch (e: any) { flash("✖ " + e.message); }
  }

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

  return (
    <div className="deck">
      <h3 style={{ marginTop: 0 }}>Online now <span className="hint">(click to select targets)</span></h3>
      {!serverUp && <p className="hint">(actions need the server fully awake — they activate by themselves when it is)</p>}
      <div className="rail">
        {serverUp && online.length === 0 && <p className="hint">(nobody online)</p>}
        {online.map((p) => (
          <div key={p.name} className={"pcard" + (selected.has(p.name) ? " sel" : "")}
            onClick={() => setSelected((s) => { const n = new Set(s); n.has(p.name) ? n.delete(p.name) : n.add(p.name); return n; })}>
            <img src={`/avatars/${p.name}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
            <b>{p.name}</b>
            <span className="pstats">❤ {p.health ?? "?"} 🍗 {p.food ?? "?"} ✦ {p.xp ?? 0}<em>{p.gamemode || "?"}</em></span>
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

      {inv && (
        <Drawer title={<>🎒 {inv.player}'s inventory</>} onClose={() => setInv(null)}>
          <p className="hint" style={{ marginTop: 0 }}>✕ takes an item away. To give, pick items from the palette below —
            while this is open, the box sends into this backpack.</p>
          <div className="inv">
            {inv.items.length === 0 && <span className="hint">(empty)</span>}
            {inv.items.map((it) => (
              <span className="invitem" key={it.slot}>
                <img src={`/items/${it.item}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                {it.item}<em>×{it.count}</em>
                <button className="mini" title="take away" onClick={() =>
                  run([`clear ${inv.player} minecraft:${it.item} ${it.count}`]).then(() => peek(inv.player))}>✕</button>
              </span>
            ))}
          </div>
          <div className="row"><button onClick={() => peek(inv.player)}>↻ refresh</button></div>
        </Drawer>
      )}

      {serverUp && <>
        <h3>Give items {inv ? <span className="hint">→ {inv.player}'s backpack</span> : <span className="hint">→ selected players</span>}
          <span className="hint"> — clicks fill the box, nothing sends until you hit Send</span></h3>
        <div className="row" style={{ marginTop: 4 }}>
          <input placeholder="search items…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {[1, 16, 64].map((n) => <button key={n} className={qty === n ? "primary" : ""} onClick={() => setQty(n)}>×{n}</button>)}
        </div>
        <div className="cattabs">
          {["all", ...CATEGORIES].map((c) => (
            <button key={c} className={"tab" + (cat === c && !query ? " active" : "")} onClick={() => { setCat(c as any); setQuery(""); }}>{c}</button>
          ))}
        </div>
        <div className="palette">
          {shown.map((i) => (
            <button key={i} className="palitem" title={`add ${qty}× ${i} to the box`} onClick={() => addToCart(i)}>
              <img src={`/items/${i}.png`} alt={i} loading="lazy" />
              <span>{i.replaceAll("_", " ")}</span>
            </button>
          ))}
          {shown.length === 0 && <span className="hint">no matches</span>}
        </div>

        {(cart.length > 0 || sent) && (
          <div className="cartbar">
            {cart.map((e) => (
              <span className="invitem" key={e.item}>
                <img src={`/items/${e.item}.png`} alt="" onError={(ev) => ((ev.target as HTMLImageElement).style.display = "none")} />
                {e.item.replaceAll("_", " ")}<em>×{e.qty}</em>
                <button className="mini" title="remove" onClick={() => setCart((c) => c.filter((x) => x.item !== e.item))}>✕</button>
              </span>
            ))}
            <span className="spacer" />
            {sent && <span className="hint ok">{sent}</span>}
            {cart.length > 0 && <>
              <button onClick={() => setCart([])}>clear</button>
              <button className="primary" disabled={sending} onClick={sendCart}>
                {sending ? "sending…" : `📦 Send → ${inv ? inv.player : targets.length ? targets.join(", ") : "(select players)"}`}
              </button>
            </>}
          </div>
        )}

        <h3>Effects <span className="hint">(60s on selected)</span></h3>
        <div className="btnwrap">
          {EFFECTS.map((e) => (
            <button key={e.id} onClick={() => run([`effect give {player} minecraft:${e.id} 60 1`])}>{e.label}</button>
          ))}
          <button onClick={() => run([`effect clear {player}`])}>🚿 clear effects</button>
        </div>

        <h3>Mode, travel & tough love</h3>
        <div className="btnwrap">
          {GAMEMODES.map((g) => (
            <button key={g} onClick={() => {
              const undo = online.filter((o) => targets.includes(o.name) && o.gamemode).map((o) => `gamemode ${o.gamemode} ${o.name}`);
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

        <h3>Recipes <span className="hint">(repeatable action sequences)</span></h3>
        <div className="btnwrap">
          {recording === null
            ? <button onClick={() => { setRecording([]); flash("● recording — every action becomes a step"); }}>● record new recipe</button>
            : <button className="primary" onClick={saveRecording}>■ stop & save ({recording.length} steps)</button>}
          {Object.entries(recipes).map(([name, r]) => (
            <span className="recipechip" key={name}>
              <button className="primary" title={r.steps.join("\n")}
                onClick={() => api(`/recipes/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ players: targets }) })
                  .then((res: any) => flash(`✔ ran "${name}" (${res.count} commands)`))
                  .catch((e) => flash("✖ " + e.message))}>▶ {name}</button>
              <button className="mini" title="edit steps" onClick={() => setEditRecipe({ name, text: r.steps.join("\n") })}>✎</button>
              <button className="mini" onClick={async () => {
                if (!confirm(`Delete recipe "${name}"?`)) return;
                const res = await api<{ recipes: Record<string, Recipe> }>(`/recipes/${encodeURIComponent(name)}`, { method: "DELETE" });
                setRecipes(res.recipes);
              }}>✕</button>
            </span>
          ))}
        </div>

        {editRecipe && (
          <Drawer title={<>✎ recipe: {editRecipe.name}</>} onClose={() => setEditRecipe(null)}>
            <p className="hint" style={{ marginTop: 0 }}>One command per line. <code>{"{player}"}</code> repeats
              that line for each selected player. Anything the console accepts works here.</p>
            <textarea rows={12} spellCheck={false} value={editRecipe.text}
              onChange={(e) => setEditRecipe({ ...editRecipe, text: e.target.value })} />
            <div className="row">
              <button className="primary" onClick={async () => {
                const steps = editRecipe.text.split("\n").map((s) => s.trim()).filter(Boolean);
                try {
                  const res = await api<{ recipes: Record<string, Recipe> }>("/recipes", {
                    method: "PUT", body: JSON.stringify({ name: editRecipe.name, steps }),
                  });
                  setRecipes(res.recipes); setEditRecipe(null); flash(`✔ recipe "${editRecipe.name}" updated`);
                } catch (e: any) { flash("✖ " + e.message); }
              }}>Save</button>
            </div>
          </Drawer>
        )}

        {feed.length > 0 && <>
          <h3>This session <span className="hint">(the real commands — ↩ where undo exists)</span></h3>
          <div className="feed">
            {feed.slice(0, 8).map((f, i) => (
              <div key={f.ts + "-" + i} className="feeditem">
                <span className="hint">{new Date(f.ts).toLocaleTimeString()}</span>
                <code>{f.commands.slice(0, 3).join("  ·  ")}{f.commands.length > 3 ? `  (+${f.commands.length - 3})` : ""}</code>
                <span className="spacer" />
                {f.undo && <button className="mini" onClick={() => run(f.undo!)}>↩ undo</button>}
              </div>
            ))}
          </div>
        </>}
      </>}

      {wl && <RoleList title="Whitelist" subtitle="who can join — instant, no restart" role="whitelist" names={wl} onChange={setWl} />}
      {ops && <RoleList title="Ops (admins in game)" role="op" names={ops} onChange={setOps} />}
    </div>
  );
}
