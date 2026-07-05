import { useState } from "react";
import { api, watchOp, type BackupEntry } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";

export default function BackupsTab() {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ backups: BackupEntry[] }>("/backups"));
  const [selected, setSelected] = useState("");
  const [target, setTarget] = useState("");

  return (
    <>
      <div className="row">
        <button onClick={async () => {
          try {
            const r = await api<{ commandId: string }>("/backup", { method: "POST", body: "{}" });
            flash("Backing up…");
            const res = await watchOp(r.commandId, (s) => flash(`Backing up… (${s})`));
            flash(res.status === "Success" ? "✔ backup complete" : "✖ backup " + res.status);
            reload();
          } catch (e: any) { flash("✖ " + e.message); }
        }}>Back up now</button>
      </div>
      <ul className="list">
        {data?.backups.map((b) => (
          <li key={b.key} className={selected === b.key ? "selected" : ""}
            onClick={() => { setSelected(b.key); if (!target) setTarget(b.key.split("/")[1]); }}>
            <code>{b.key.split("/").pop()}</code>
            <span className="spacer" />
            <span className="hint">{new Date(b.lastModified).toLocaleString()} · {(b.size / 1048576).toFixed(1)} MB</span>
          </li>
        ))}
      </ul>
      <p>Restore selected backup into profile:</p>
      <div className="row">
        <input placeholder="profile name (existing or new)" value={target} onChange={(e) => setTarget(e.target.value)} />
        <button disabled={!selected || !target} onClick={async () => {
          if (!confirm(`Restore ${selected.split("/").pop()} into profile "${target}"?\nIts current world data is kept as one-level undo (data.pre-restore).`)) return;
          try {
            const r = await api<{ commandId: string }>("/restore", { method: "POST", body: JSON.stringify({ key: selected, profile: target }) });
            flash("Restoring…");
            const res = await watchOp(r.commandId, (s) => flash(`Restoring… (${s})`));
            flash(res.status === "Success" ? "✔ restore complete" : "✖ restore failed: " + (res.error || res.status));
          } catch (e: any) { flash("✖ " + e.message); }
        }}>Restore</button>
      </div>
    </>
  );
}
