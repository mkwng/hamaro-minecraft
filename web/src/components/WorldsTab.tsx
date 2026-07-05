import { useState } from "react";
import { api, watchOp } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";

// Curated kid-friendly Fabric modpacks from Modrinth (itzg: MODRINTH_MODPACK).
// Vet additions before listing — packs pin their own mod versions.
const MODPACKS = [
  { slug: "", label: "No mods (vanilla Paper)" },
  { slug: "adrenaserver", label: "Adrena — light performance + QoL" },
  { slug: "fabulously-optimized", label: "Fabulously Optimized — vanilla but faster" },
  { slug: "simply-optimized", label: "Simply Optimized — minimal performance pack" },
];

export default function WorldsTab({ activeProfile }: { activeProfile: string }) {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ active: string; profiles: string[] }>("/profiles"));
  const [name, setName] = useState("");
  const [modpack, setModpack] = useState("");

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

  return (
    <>
      <p>Each world is a self-contained profile (its own Minecraft version, settings, and mods). Switching backs up the current world first.</p>
      <ul className="list">
        {data?.profiles.map((p) => (
          <li key={p}>
            <b>{p}</b> {p === data.active && <span className="badge">active</span>}
            <span className="spacer" />
            {p !== data.active && <button onClick={() => switchTo(p)}>Switch to this world</button>}
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
          try { env = (await api<{ env: string }>(`/profiles/${activeProfile || data?.active}`)).env; } catch {}
          if (!env) env = "TYPE=PAPER\nVERSION=26.2\nMEMORY=6G\nENABLE_WHITELIST=TRUE\nENFORCE_WHITELIST=TRUE\nEXISTING_WHITELIST_FILE=SYNCHRONIZE\nWHITELIST=\nEXISTING_OPS_FILE=SYNCHRONIZE\nOPS=\n";
          if (modpack) {
            // Modpacks run on Fabric via Modrinth; strip Paper-only lines.
            env = env.replace(/^TYPE=.*$/m, "TYPE=MODRINTH").replace(/^PLUGINS=.*$/m, "");
            env += `\nMODRINTH_MODPACK=${modpack}\n`;
          }
          try {
            await api(`/profiles/${n}`, { method: "PUT", body: JSON.stringify({ env }) });
            setName(""); reload();
            flash(`✔ world "${n}" created${modpack ? ` with modpack ${modpack}` : ""} — switch to it when ready`);
          } catch (e: any) { flash("✖ " + e.message); }
        }}>Create world</button>
      </div>
      <p className="hint">Modpacks install themselves on first start (takes a few extra minutes).</p>
    </>
  );
}
