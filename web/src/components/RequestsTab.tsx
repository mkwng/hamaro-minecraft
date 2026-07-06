import { api, type JoinRequest } from "../api";
import { useAsync, useInterval } from "../hooks";
import { useOpStatus } from "./AdminPanel";

// Notification banner (not a tab): shows only while join requests are pending.
export default function RequestsBanner() {
  const flash = useOpStatus();
  const [data, reload] = useAsync(() => api<{ requests: JoinRequest[] }>("/join-requests"));
  useInterval(reload, 60000);

  const decide = async (username: string, action: "approve" | "deny") => {
    try {
      const r = await api<any>("/join-requests/decide", { method: "POST", body: JSON.stringify({ username, action }) });
      flash(r.approved
        ? (r.emailNotified ? `✔ ${username} whitelisted + emailed` : `✔ ${username} whitelisted (email couldn't be sent)`)
        : `✔ ${username} denied`);
      reload();
    } catch (e: any) { flash("✖ " + e.message); }
  };

  if (!data?.requests.length) return null;
  return (
    <div className="reqbanner">
      <b>🔔 {data.requests.length} join request{data.requests.length === 1 ? "" : "s"}</b>
      {data.requests.map((r) => (
        <span key={r.username} className="reqitem">
          <b>{r.username}</b> <span className="hint">({r.email})</span>
          <button className="primary mini" onClick={() => decide(r.username, "approve")}>Approve ✔</button>
          <button className="danger mini" onClick={() => decide(r.username, "deny")}>Deny</button>
        </span>
      ))}
    </div>
  );
}
