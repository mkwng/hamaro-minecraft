import { useEffect } from "react";
import { api, type JoinRequest } from "../api";
import { useAsync } from "../hooks";
import { useOpStatus } from "./AdminPanel";

export default function RequestsTab({ onCount }: { onCount: (n: number) => void }) {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ requests: JoinRequest[] }>("/join-requests"));
  useEffect(() => { onCount(data?.requests.length || 0); }, [data, onCount]);

  const decide = async (username: string, action: "approve" | "deny") => {
    try {
      const r = await api<any>("/join-requests/decide", { method: "POST", body: JSON.stringify({ username, action }) });
      flash(r.approved
        ? (r.emailNotified ? `✔ ${username} whitelisted + emailed` : `✔ ${username} whitelisted (email couldn't be sent)`)
        : `✔ ${username} denied`);
      reload();
    } catch (e: any) { flash("✖ " + e.message); }
  };

  return (
    <>
      <p>People who asked to join. Approving whitelists them instantly and emails them the good news.</p>
      <ul className="list">
        {!data?.requests.length && <li className="hint">No pending requests.</li>}
        {data?.requests.map((r) => (
          <li key={r.username}>
            <b>{r.username}</b>
            <span className="hint">{r.email} · {new Date(r.at).toLocaleDateString()}</span>
            <span className="spacer" />
            <button className="primary" onClick={() => decide(r.username, "approve")}>Approve ✔</button>
            <button className="danger" onClick={() => decide(r.username, "deny")}>Deny</button>
          </li>
        ))}
      </ul>
    </>
  );
}
