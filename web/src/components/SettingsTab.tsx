import { useState } from "react";
import { api, watchOp } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";

export default function SettingsTab({ profile: profileProp }: { profile?: string } = {}) {
  const flash = useOpStatus();
  const [profile, setProfile] = useState("");
  const [active, setActive] = useState("");
  const [env, setEnv] = useState("");
  useAsync(async () => {
    const r = await api<{ active: string }>("/profiles");
    const p = profileProp || r.active;
    setActive(r.active);
    setProfile(p);
    setEnv((await api<{ env: string }>(`/profiles/${p}`)).env);
  });

  // Catches typo'd whitelist/ops names before they can crash the server's
  // startup — the exact failure mode that motivated this check.
  async function namesLookOk() {
    const names = [...new Set([
      ...(env.match(/^WHITELIST=(.*)$/m)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean),
      ...(env.match(/^OPS=(.*)$/m)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean),
    ])];
    if (!names.length) return true;
    try {
      const { invalid } = await api<{ invalid: string[] }>("/validate-players", { method: "POST", body: JSON.stringify({ names }) });
      if (!invalid.length) return true;
      return confirm(
        `These don't look like real Minecraft accounts: ${invalid.join(", ")}\n\n` +
        `A bad name here can make the server fail to start. Save anyway?`
      );
    } catch { return true; } // Mojang unreachable — don't block the save on that
  }

  const save = async (apply: boolean) => {
    if (!(await namesLookOk())) return;
    try {
      await api(`/profiles/${profile}`, { method: "PUT", body: JSON.stringify({ env }) });
      if (apply) {
        const res = await api<any>(`/profiles/${profile}/activate`, { method: "POST", body: "{}" });
        if (res.commandId) {
          flash("Applying settings…");
          const r = await watchOp(res.commandId, (s) => flash(`Applying settings… (${s})`));
          flash(r.status === "Success" ? "✔ settings applied" : "✖ apply failed: " + (r.error || r.status));
          return;
        }
      }
      flash("✔ saved" + (apply ? "" : " (takes effect on next start/apply)"));
    } catch (e: any) { flash("✖ " + e.message); }
  };

  return (
    <>
      <p>Settings for profile <b>{profile}</b> — any{" "}
        <a href="https://docker-minecraft-server.readthedocs.io/" target="_blank" rel="noopener">itzg variable</a> works.{" "}
        <code>VERSION</code> must stay pinned (never LATEST).</p>
      <textarea rows={16} spellCheck={false} value={env} onChange={(e) => setEnv(e.target.value)} />
      <div className="row">
        <button onClick={() => save(false)}>Save</button>
        {profile === active
          ? <button onClick={() => save(true)}>Save + apply now (restarts server)</button>
          : <span className="hint">applies when you switch to this world</span>}
      </div>
    </>
  );
}
