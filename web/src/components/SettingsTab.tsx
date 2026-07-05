import { useState } from "react";
import { api, watchOp } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";

export default function SettingsTab() {
  const flash = useOpStatus();
  const [profile, setProfile] = useState("");
  const [env, setEnv] = useState("");
  useAsync(async () => {
    const r = await api<{ active: string }>("/profiles");
    setProfile(r.active);
    setEnv((await api<{ env: string }>(`/profiles/${r.active}`)).env);
  });

  const save = async (apply: boolean) => {
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
        <button onClick={() => save(true)}>Save + apply now (restarts server)</button>
      </div>
    </>
  );
}
