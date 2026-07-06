import { useEffect, useState } from "react";
import { api, watchOp } from "../api";
import { useOpStatus } from "./AdminPanel";

// Mod management on Modrinth rails: the browser searches api.modrinth.com
// directly (CORS-open); installing = adding the project slug to the profile's
// MODRINTH_PROJECTS. itzg downloads mods (and required dependencies) at server
// start, pinned to the profile's Minecraft VERSION.
type Project = { slug: string; title: string; icon_url?: string; description?: string; downloads?: number };

function envGet(env: string, key: string) { return env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || ""; }
function envSet(env: string, key: string, value: string) {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : env + "\n" + line;
}

export default function ModsTab({ profile: profileProp }: { profile?: string } = {}) {
  const flash = useOpStatus();
  const [profile, setProfile] = useState("");
  const [active, setActive] = useState("");
  const [env, setEnv] = useState("");
  const [installed, setInstalled] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Project[]>([]);
  const [dirty, setDirty] = useState(false);

  const type = envGet(env, "TYPE").toUpperCase() || "PAPER";
  const version = envGet(env, "VERSION");
  const slugs = envGet(env, "MODRINTH_PROJECTS").split(",").map((s) => s.trim()).filter(Boolean);

  useEffect(() => {
    (async () => {
      const r = await api<{ active: string }>("/profiles");
      const p = profileProp || r.active;
      setActive(r.active);
      setProfile(p);
      setEnv((await api<{ env: string }>(`/profiles/${p}`)).env);
    })();
  }, []);

  // Enrich installed slugs with Modrinth metadata (icons, titles).
  useEffect(() => {
    if (!slugs.length) { setInstalled([]); return; }
    fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(slugs))}`)
      .then((r) => r.json())
      .then((list: Project[]) => setInstalled(slugs.map((s) => list.find((p) => p.slug === s) || { slug: s, title: s })))
      .catch(() => setInstalled(slugs.map((s) => ({ slug: s, title: s }))));
  }, [env]);

  async function search() {
    if (!query.trim()) return;
    const loaderFacet = type === "PAPER" ? ["categories:paper", "categories:bukkit", "categories:spigot"] : ["categories:fabric"];
    const typeFacet = type === "PAPER" ? "project_type:plugin" : "project_type:mod";
    const facets = JSON.stringify([[typeFacet], loaderFacet, [`versions:${version}`]]);
    try {
      const r = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&limit=12&facets=${encodeURIComponent(facets)}`);
      setResults((await r.json()).hits || []);
    } catch (e: any) { flash("✖ Modrinth search failed: " + e.message); }
  }

  function add(slug: string) {
    let e = envSet(env, "MODRINTH_PROJECTS", [...new Set([...slugs, slug])].join(","));
    e = envSet(e, "MODRINTH_DOWNLOAD_DEPENDENCIES", "required");
    setEnv(e); setDirty(true);
  }
  function remove(slug: string) {
    setEnv(envSet(env, "MODRINTH_PROJECTS", slugs.filter((s) => s !== slug).join(",")));
    setDirty(true);
  }

  async function apply() {
    try {
      await api(`/profiles/${profile}`, { method: "PUT", body: JSON.stringify({ env }) });
      setDirty(false);
      if (profile !== active) { flash("✔ saved — installs when you switch to this world"); return; }
      const res = await api<any>(`/profiles/${profile}/activate`, { method: "POST", body: "{}" });
      if (res.commandId) {
        flash("Applying mods (server restarting — modpack downloads add a few minutes)…");
        const r = await watchOp(res.commandId, (s) => flash(`Applying mods… (${s})`));
        flash(r.status === "Success" ? "✔ mods applied" : "✖ apply failed: " + (r.error || r.status));
      } else flash("✔ saved — mods install on next start");
    } catch (e: any) { flash("✖ " + e.message); }
  }

  return (
    <>
      <p>Mods for <b>{profile}</b> <span className="hint">({type} · Minecraft {version} — search shows only compatible {type === "PAPER" ? "plugins" : "mods"}; required dependencies install automatically)</span></p>

      <h3>Installed ({installed.length})</h3>
      <ul className="list">
        {installed.length === 0 && <li className="hint">No mods yet — vanilla {type === "PAPER" ? "Paper" : "Fabric"}.</li>}
        {installed.map((p) => (
          <li key={p.slug}>
            {p.icon_url && <img className="modicon" src={p.icon_url} alt="" />}
            <b>{p.title}</b> <span className="hint">{p.slug}</span>
            <span className="spacer" />
            <button onClick={() => remove(p.slug)}>Remove</button>
          </li>
        ))}
      </ul>
      {dirty && (
        <div className="row">
          <span className="err">unapplied changes</span>
          <button className="primary" onClick={apply}>Apply now (restarts server)</button>
        </div>
      )}

      <h3>Find {type === "PAPER" ? "plugins" : "mods"} on Modrinth</h3>
      <div className="row">
        <input placeholder='try "backpacks", "waystones", "pets"…' value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <button onClick={search}>Search</button>
      </div>
      <ul className="list">
        {results.map((p) => (
          <li key={p.slug}>
            {p.icon_url && <img className="modicon" src={p.icon_url} alt="" />}
            <span><b>{p.title}</b> <span className="hint">{(p.downloads || 0).toLocaleString()} downloads</span><br />
              <span className="hint">{p.description?.slice(0, 110)}</span></span>
            <span className="spacer" />
            {slugs.includes(p.slug)
              ? <span className="badge">installed</span>
              : <button className="primary" onClick={() => add(p.slug)}>Add</button>}
          </li>
        ))}
      </ul>
      <p className="hint">Kid-tested ideas: "waystones" (teleport stones), "backpacks", "naturalist" (animals),
        "comforts" (sleeping bags). Mods pin to Minecraft {version}; upgrading VERSION re-resolves them.</p>
    </>
  );
}
