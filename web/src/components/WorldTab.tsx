import { useState } from "react";
import { api, WARP_GLYPHS, type Warp } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";
import WorldsTab from "./WorldsTab";
import ModsTab from "./ModsTab";
import SettingsTab from "./SettingsTab";
import BackupsTab from "./BackupsTab";

const SUBS = ["overview", "warps", "mods", "settings", "backups"] as const;

// Everything about the PLACE: the active world's dials, the library of worlds,
// and the per-world concerns (warps, mods, settings, backups).
export default function WorldTab({ activeProfile, serverUp }: { activeProfile: string; serverUp: boolean }) {
  const [sub, setSub] = useState<(typeof SUBS)[number]>("overview");
  const flash = useOpStatus();

  const world = async (cmd: string, label: string) => {
    try {
      await api("/commands", { method: "POST", body: JSON.stringify({ commands: [cmd] }) });
      flash("✔ " + label);
    } catch (e: any) { flash("✖ " + e.message); }
  };

  return (
    <>
      <nav className="subtabs">
        {SUBS.map((s) => (
          <button key={s} className={"tab" + (sub === s ? " active" : "")} onClick={() => setSub(s)}>{s}</button>
        ))}
      </nav>

      {sub === "overview" && (
        <>
          {serverUp ? (
            <>
              <h3 style={{ marginTop: 0 }}>Right now in <b>{activeProfile}</b></h3>
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
            <p className="hint" style={{ marginTop: 0 }}>(world dials need the server awake)</p>
          )}
          <WorldsTab activeProfile={activeProfile} />
        </>
      )}

      {sub === "warps" && <WarpsSection />}
      {sub === "mods" && <ModsTab />}
      {sub === "settings" && <SettingsTab />}
      {sub === "backups" && <BackupsTab />}
    </>
  );
}

function WarpsSection() {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ warps: Record<string, Warp> }>("/warps"));
  const [wn, setWn] = useState({ name: "", x: "", y: "", z: "", type: "pin" });
  const warps = data?.warps || {};

  return (
    <>
      <p style={{ marginTop: 0 }}>Named places — shown as pins on the public map and used for teleports in the Players tab.
        <span className="hint"> Add from here, "Save spot as warp" next to an online player, or shift+click the map.</span></p>
      <ul className="list">
        {Object.entries(warps).map(([name, w]) => (
          <li key={name}>
            <b>{WARP_GLYPHS[w.type || "pin"]} {name}</b>
            <span className="hint">{w.dimension.replace("minecraft:", "")} · {w.x}, {w.y}, {w.z}</span>
            <span className="spacer" />
            <button onClick={async () => { await api(`/warps/${encodeURIComponent(name)}`, { method: "DELETE" }); reload(); }}>Delete</button>
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
          try { await api("/warps", { method: "POST", body: JSON.stringify(wn) }); setWn({ name: "", x: "", y: "", z: "", type: "pin" }); reload(); }
          catch (e: any) { flash("✖ " + e.message); }
        }}>Add</button>
      </div>
    </>
  );
}
