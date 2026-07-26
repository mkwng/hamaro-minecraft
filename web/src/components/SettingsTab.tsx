import { useState } from "react";
import { api, watchOp } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";

type UpdateInfo = {
  current: string; checkable: boolean; note?: string;
  patch?: string | null; family?: string | null; upToDate?: boolean;
};

// The clickops path to a new Minecraft version: check, press, done. The raw
// env editor below stays the escape hatch for everything else.
function VersionCard({ profile, onUpdated }: { profile: string; onUpdated: () => void }) {
  const flash = useOpStatus();
  const [info, reload] = useAsync(() => api<UpdateInfo>(`/profiles/${profile}/updates`), [profile]);
  const [busy, setBusy] = useState(false);

  const update = async (version: string, blurb: string) => {
    if (!confirm(
      `Update "${profile}" to Minecraft ${version}?\n\n${blurb}\n\n` +
      `The world is backed up first, then the new version applies (restarting the server if this world is live). ` +
      `World upgrades are ONE-WAY — there's no downgrade, only restoring the backup.`
    )) return;
    setBusy(true);
    try {
      const res = await api<{ commandId?: string; note?: string }>(`/profiles/${profile}/update`, {
        method: "POST", body: JSON.stringify({ version }),
      });
      if (res.commandId) {
        flash(`Updating to ${version} — backing up, then restarting…`);
        const r = await watchOp(res.commandId, (s) => flash(`Updating to ${version}… (${s})`));
        flash(r.status === "Success" ? `✔ now on Minecraft ${version}` : `✖ update ${r.status}: ${r.error || "check Backups to restore if needed"}`);
      } else {
        flash(`✔ pinned ${version} — ${res.note || "applies on next start"}`);
      }
      reload(); onUpdated();
    } catch (e: any) { flash("✖ " + e.message); }
    setBusy(false);
  };

  if (!info) return <p className="hint">Minecraft version: checking for updates…</p>;
  return (
    <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
      <span>Minecraft <b>{info.current || "?"}</b></span>
      {!info.checkable && <span className="hint">{info.note}</span>}
      {info.upToDate && <span className="hint">✔ up to date</span>}
      {info.patch && (
        <button disabled={busy} onClick={() => update(info.patch!, "This is a bugfix release — same content, just fixes.")}>
          Update to {info.patch} (bugfix)
        </button>
      )}
      {info.family && (
        <button disabled={busy} onClick={() => update(info.family!, "This is a NEW-CONTENT version (possibly new biomes, blocks, mobs) — gather the kids!")}>
          ✨ Update to {info.family} (new content)
        </button>
      )}
    </div>
  );
}

export default function SettingsTab({ profile: profileProp }: { profile?: string } = {}) {
  const flash = useOpStatus();
  const [profile, setProfile] = useState("");
  const [active, setActive] = useState("");
  const [env, setEnv] = useState("");
  const [, reloadEnv] = useAsync(async () => {
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
      {profile && <VersionCard profile={profile} onUpdated={reloadEnv} />}
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
