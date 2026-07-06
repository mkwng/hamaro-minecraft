import { useState } from "react";
import { api, watchOp, WARP_GLYPHS, type Warp } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";
import ModsTab from "./ModsTab";
import SettingsTab from "./SettingsTab";
import BackupsTab from "./BackupsTab";

// The World tab is a LIBRARY: the active world's live dials up top, then a
// card per world. Opening a card drills into THAT world's settings, mods,
// backups, and warps — active or not.
const MODPACKS = [
  { slug: "", label: "No mods (vanilla Paper)" },
  { slug: "adrenaserver", label: "Adrena — light performance + QoL" },
  { slug: "fabulously-optimized", label: "Fabulously Optimized — vanilla but faster" },
  { slug: "simply-optimized", label: "Simply Optimized — minimal performance pack" },
];

const SUBS = ["settings", "mods", "backups", "warps"] as const;

export default function WorldTab({ activeProfile, serverUp }: { activeProfile: string; serverUp: boolean }) {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ active: string; profiles: string[] }>("/profiles"));
  const [opened, setOpened] = useState<string | null>(null);
  const [sub, setSub] = useState<(typeof SUBS)[number]>("settings");
  const [name, setName] = useState("");
  const [modpack, setModpack] = useState("");

  const world = async (cmd: string, label: string) => {
    try {
      await api("/commands", { method: "POST", body: JSON.stringify({ commands: [cmd] }) });
      flash("✔ " + label);
    } catch (e: any) { flash("✖ " + e.message); }
  };

  const switchTo = async (p: string) => {
    if (!confirm(`Switch the server to "${p}"? The current world is backed up first.`)) return;
    const res = await api<any>(`/profiles/${p}/activate`, { method: "POST", body: "{}" });
    if (res.commandId) {
      flash(`Switching to ${p}…`);
      const r = await watchOp(res.commandId, (s) => flash(`Switching to ${p}… (${s})`));
      flash(r.status === "Success" ? `✔ now running ${p}` : `✖ switch ${r.status}: ${r.error || ""}`);
    } else flash(res.note);
    reload();
  };

  // ---------------- drill-in view ----------------
  if (opened) {
    const isActive = opened === (data?.active || activeProfile);
    return (
      <>
        <div className="row" style={{ marginTop: 0, alignItems: "center" }}>
          <button className="mini" onClick={() => setOpened(null)}>← all worlds</button>
          <b>{opened}</b>
          {isActive
            ? <span className="badge">active</span>
            : <button onClick={() => switchTo(opened)}>Switch server to this world</button>}
        </div>
        <nav className="subtabs" style={{ marginTop: 12 }}>
          {SUBS.map((s) => (
            <button key={s} className={"tab" + (sub === s ? " active" : "")} onClick={() => setSub(s)}>{s}</button>
          ))}
        </nav>
        {sub === "settings" && <SettingsTab profile={opened} />}
        {sub === "mods" && <ModsTab profile={opened} />}
        {sub === "backups" && <BackupsTab profile={opened} />}
        {sub === "warps" && <WarpsSection profile={opened} isActive={isActive} />}
      </>
    );
  }

  // ---------------- library view ----------------
  return (
    <>
      {serverUp ? (
        <>
          <h3 style={{ marginTop: 0 }}>Right now in <b>{data?.active || activeProfile}</b></h3>
          <div className="btnwrap">
            <button onClick={() => world("time set day", "daytime")}>🌞 day</button>
            <button onClick={() => world("time set night", "nighttime")}>🌙 night</button>
            <button onClick={() => world("weather clear 6000", "clear skies")}>☀️ clear</button>
            <button onClick={() => world("weather rain 600", "rain")}>🌧 rain</button>
            <button onClick={() => world("weather thunder 300", "thunder")}>⛈ thunder</button>
            <button onClick={() => world("gamerule keepInventory true", "keep items on death: ON")}>😌 keep items on death</button>
            <button onClick={() => world("gamerule keepInventory false", "keep items on death: OFF")}>😈 drop items on death</button>
            {["peaceful", "easy", "normal", "hard"].map((d) => (
              <button key={d} onClick={() => world(`difficulty ${d}`, `difficulty ${d}`)}>{d}</button>
            ))}
          </div>
        </>
      ) : (
        <p className="hint" style={{ marginTop: 0 }}>(live dials need the server awake)</p>
      )}

      <h3>Worlds <span className="hint">(each is self-contained: its own version, settings, mods, backups)</span></h3>
      <ul className="list">
        {data?.profiles.map((p) => (
          <li key={p}>
            <b>{p}</b> {p === data.active && <span className="badge">active</span>}
            <span className="spacer" />
            <button onClick={() => { setOpened(p); setSub("settings"); }}>open →</button>
            {p !== data.active && <button onClick={() => switchTo(p)}>switch to</button>}
          </li>
        ))}
      </ul>

      <h3>Create a new world</h3>
      <div className="row">
        <input placeholder="new-world-name (letters, numbers, dashes)" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={modpack} onChange={(e) => setModpack(e.target.value)}>
          {MODPACKS.map((m) => <option key={m.slug} value={m.slug}>{m.label}</option>)}
        </select>
        <button onClick={async () => {
          const n = name.trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(n)) return alert("Name: lowercase letters, numbers, dashes.");
          let env = "";
          try { env = (await api<{ env: string }>(`/profiles/${data?.active || activeProfile}`)).env; } catch {}
          if (!env) env = "TYPE=PAPER\nVERSION=26.2\nMEMORY=6G\nENABLE_WHITELIST=TRUE\nENFORCE_WHITELIST=TRUE\nEXISTING_WHITELIST_FILE=SYNCHRONIZE\nWHITELIST=\nEXISTING_OPS_FILE=SYNCHRONIZE\nOPS=\n";
          if (modpack) {
            env = env.replace(/^TYPE=.*$/m, "TYPE=MODRINTH").replace(/^PLUGINS=.*$/m, "");
            env += `\nMODRINTH_MODPACK=${modpack}\n`;
          }
          try {
            await api(`/profiles/${n}`, { method: "PUT", body: JSON.stringify({ env }) });
            setName(""); reload();
            flash(`✔ world "${n}" created${modpack ? ` with modpack ${modpack}` : ""} — open it to configure, switch to play`);
          } catch (e: any) { flash("✖ " + e.message); }
        }}>Create world</button>
      </div>
      <p className="hint">Modpacks install themselves on first start (takes a few extra minutes).</p>
    </>
  );
}

function WarpsSection({ profile, isActive }: { profile: string; isActive: boolean }) {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ warps: Record<string, Warp> }>(`/warps?profile=${encodeURIComponent(profile)}`), [profile]);
  const [wn, setWn] = useState({ name: "", x: "", y: "", z: "", type: "pin" });
  const warps = data?.warps || {};

  return (
    <>
      <p style={{ marginTop: 0 }}>Named places in <b>{profile}</b>{isActive ? " — shown on the public map and used for teleports." : " — used when this world is active."}
        <span className="hint"> Add here, "Save spot as warp" next to an online player, or shift+click the map.</span></p>
      <ul className="list">
        {Object.entries(warps).map(([name, w]) => (
          <li key={name}>
            <b>{WARP_GLYPHS[w.type || "pin"]} {name}</b>
            <span className="hint">{w.dimension.replace("minecraft:", "")} · {w.x}, {w.y}, {w.z}</span>
            <span className="spacer" />
            <button onClick={async () => { await api(`/warps/${encodeURIComponent(name)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" }); reload(); }}>Delete</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input placeholder="warp name" style={{ maxWidth: 130 }} value={wn.name} onChange={(e) => setWn({ ...wn, name: e.target.value })} />
        {(["x", "y", "z"] as const).map((k) => (
          <input key={k} className="short" placeholder={k} inputMode="numeric" value={wn[k]} onChange={(e) => setWn({ ...wn, [k]: e.target.value })} />
        ))}
        <select value={wn.type} onChange={(e) => setWn({ ...wn, type: e.target.value })}>
          {Object.entries(WARP_GLYPHS).map(([t, g]) => <option key={t} value={t}>{g} {t}</option>)}
        </select>
        <button onClick={async () => {
          try { await api("/warps", { method: "POST", body: JSON.stringify({ ...wn, profile }) }); setWn({ name: "", x: "", y: "", z: "", type: "pin" }); reload(); }
          catch (e: any) { flash("✖ " + e.message); }
        }}>Add</button>
      </div>
    </>
  );
}
