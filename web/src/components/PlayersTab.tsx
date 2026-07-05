import { useState } from "react";
import { api, watchOp, type OnlinePlayer, type Warp, type InvItem } from "../api";
import { useAsync, useInterval } from "../hooks";
import { useOpStatus } from "./AdminPanel";

function PlayerCard({ p, warps, onWarpsChanged }: { p: OnlinePlayer; warps: Record<string, Warp>; onWarpsChanged: () => void }) {
  const flash = useOpStatus();
  const [inv, setInv] = useState<InvItem[] | null>(null);
  const [showInv, setShowInv] = useState(false);
  const [item, setItem] = useState("");
  const [count, setCount] = useState("1");
  const [warp, setWarp] = useState(Object.keys(warps)[0] || "");

  return (
    <div className="player-card">
      <b>{p.name}</b>
      <span className="hint">{p.dimension || "?"} · {p.x ?? "?"}, {p.y ?? "?"}, {p.z ?? "?"}</span>
      <span className="spacer" />
      <button onClick={async () => {
        setShowInv(!showInv);
        if (!inv) {
          try { setInv((await api<{ items: InvItem[] }>(`/players/${p.name}/inventory`)).items); }
          catch (e: any) { flash("✖ " + e.message); }
        }
      }}>Inventory</button>
      <button onClick={async () => {
        const name = prompt(`Name this warp (where ${p.name} is standing):`);
        if (!name) return;
        try { await api("/warps", { method: "POST", body: JSON.stringify({ name, player: p.name }) }); onWarpsChanged(); flash(`✔ warp "${name}" saved`); }
        catch (e: any) { flash("✖ " + e.message); }
      }}>Save spot as warp</button>
      <span className="row" style={{ margin: 0 }}>
        <input list="item-ideas" placeholder="item" value={item} onChange={(e) => setItem(e.target.value)} style={{ maxWidth: 150 }} />
        <input className="short" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        <button onClick={async () => {
          try { flash("✔ " + (await api<{ gave: string }>("/give", { method: "POST", body: JSON.stringify({ player: p.name, item, count }) })).gave); }
          catch (e: any) { flash("✖ " + e.message); }
        }}>Give</button>
      </span>
      {Object.keys(warps).length > 0 && (
        <span className="row" style={{ margin: 0 }}>
          <select value={warp} onChange={(e) => setWarp(e.target.value)}>
            {Object.keys(warps).map((w) => <option key={w}>{w}</option>)}
          </select>
          <button onClick={async () => {
            try { flash("✔ " + (await api<{ teleported: string }>("/tp", { method: "POST", body: JSON.stringify({ player: p.name, warp }) })).teleported); }
            catch (e: any) { flash("✖ " + e.message); }
          }}>TP</button>
        </span>
      )}
      {showInv && (
        <div className="inv">
          {inv === null ? "peeking…" : inv.length === 0 ? "(empty-handed!)" :
            inv.map((it) => (
              <span className="invitem" key={it.slot} title={`${it.item} ×${it.count}`}>
                <img src={`/items/${it.item}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                {it.item}<em>×{it.count}</em>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

function RoleList({ title, subtitle, role, names, onChange }: {
  title: string; subtitle?: string; role: "whitelist" | "op"; names: string[]; onChange: (names: string[]) => void;
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
        {names.map((n) => (
          <li key={n}>{n}<span className="spacer" /><button onClick={() => act(n, "remove")}>Remove</button></li>
        ))}
      </ul>
      <div className="row">
        <input placeholder="Minecraft username" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name && (act(name, "add"), setName(""))} />
        <button onClick={() => { if (name) { act(name, "add"); setName(""); } }}>Add</button>
      </div>
    </>
  );
}

export default function PlayersTab({ serverUp }: { serverUp: boolean }) {
  const [online, setOnline] = useState<OnlinePlayer[] | null>(null);
  const [warpsData, reloadWarps] = useAsync(() => api<{ warps: Record<string, Warp> }>("/warps"));
  const flash = useOpStatus();
  const [wl, setWl] = useState<string[] | null>(null);
  const [ops, setOps] = useState<string[] | null>(null);
  const [wn, setWn] = useState({ name: "", x: "", y: "", z: "" });

  const loadRoles = async () => {
    const r = await api<{ active: string }>("/profiles");
    const p = await api<{ env: string }>(`/profiles/${r.active}`);
    const get = (k: string) => (p.env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
    setWl(get("WHITELIST")); setOps(get("OPS"));
  };
  const loadOnline = () => serverUp && api<{ online: OnlinePlayer[] }>("/players").then((r) => setOnline(r.online)).catch(() => {});
  useAsync(async () => { await loadRoles(); loadOnline(); });
  useInterval(loadOnline, 10000);

  const warps = warpsData?.warps || {};
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Online now</h3>
      {!serverUp ? <p className="hint">(server is asleep)</p> :
        online === null ? <p className="hint">looking…</p> :
        online.length === 0 ? <p className="hint">(nobody on right now)</p> :
        online.map((p) => <PlayerCard key={p.name} p={p} warps={warps} onWarpsChanged={reloadWarps} />)}

      <h3>Warps (saved points)</h3>
      <ul className="list">
        {Object.entries(warps).map(([name, w]) => (
          <li key={name}>
            <b>{name}</b> <span className="hint">{w.dimension.replace("minecraft:", "")} · {w.x}, {w.y}, {w.z}</span>
            <span className="spacer" />
            <button onClick={async () => { await api(`/warps/${encodeURIComponent(name)}`, { method: "DELETE" }); reloadWarps(); }}>Delete</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input placeholder="warp name" style={{ maxWidth: 130 }} value={wn.name} onChange={(e) => setWn({ ...wn, name: e.target.value })} />
        {(["x", "y", "z"] as const).map((k) => (
          <input key={k} className="short" placeholder={k} inputMode="numeric" value={wn[k]} onChange={(e) => setWn({ ...wn, [k]: e.target.value })} />
        ))}
        <button onClick={async () => {
          try { await api("/warps", { method: "POST", body: JSON.stringify(wn) }); setWn({ name: "", x: "", y: "", z: "" }); reloadWarps(); }
          catch (e: any) { flash("✖ " + e.message); }
        }}>Add by coords</button>
      </div>
      <p className="hint">Tip: easier to use "Save spot as warp" next to an online player.</p>

      {wl && <RoleList title="Whitelist" subtitle="instant — no restart needed" role="whitelist" names={wl} onChange={setWl} />}
      {ops && <RoleList title="Ops (admins in game)" role="op" names={ops} onChange={setOps} />}

      <datalist id="item-ideas">
        {["diamond", "emerald", "golden_apple", "elytra", "saddle", "name_tag", "cake", "trident", "shield", "bow", "ender_pearl", "spyglass", "firework_rocket"].map((i) => <option key={i} value={i} />)}
      </datalist>
    </>
  );
}
