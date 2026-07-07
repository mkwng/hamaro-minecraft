import { useEffect, useRef, useState } from "react";
import { api, auth, emit, type JoinRequest } from "../api";
import { useInterval } from "../hooks";

// Bell + dropdown in the topbar. Today's notification source is join requests;
// the item model is generic so future types (reaper events, failed backups)
// can slot in without redesign.
type Notice =
  | { kind: "join"; req: JoinRequest }
  | { kind: "info"; text: string };

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [msg, setMsg] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  const load = () => {
    if (!auth.token) return;
    api<{ requests: JoinRequest[] }>("/join-requests").then((r) => setRequests(r.requests)).catch(() => {});
  };
  useEffect(load, [auth.token]);
  useInterval(load, 15000); // near-live: knocks land within a watchdog minute + one poll

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!auth.token) return null;
  const notices: Notice[] = requests.map((req) => ({ kind: "join", req }));

  const decide = async (username: string, action: "approve" | "deny") => {
    try {
      const hasEmail = !!requests.find((q) => q.username === username)?.email;
      const r = await api<any>("/join-requests/decide", { method: "POST", body: JSON.stringify({ username, action }) });
      setMsg(r.approved
        ? `✔ ${username} whitelisted${hasEmail ? (r.emailNotified ? " + emailed" : " (email couldn't be sent)") : ""}`
        : `✔ ${username} denied`);
      if (r.approved) emit("roles-changed"); // Players tab picks up the new whitelist live
      load();
    } catch (e: any) { setMsg("✖ " + e.message); }
  };

  return (
    <div className="notif" ref={boxRef}>
      <button className="notifbell" title="notifications" onClick={() => { setOpen(!open); setMsg(""); }}>
        🔔{notices.length > 0 && <span className="notifbadge">{notices.length}</span>}
      </button>
      {open && (
        <div className="notifpanel">
          <div className="notifhead">notifications</div>
          {notices.length === 0 && <div className="notifempty">all quiet ✨</div>}
          {notices.map((n, i) =>
            n.kind === "join" ? (
              <div className="notifitem" key={i}>
                <div>
                  {n.req.knock
                    ? <><b>{n.req.username}</b> tried to join but isn't whitelisted 🚪</>
                    : <><b>{n.req.username}</b> asked to join</>}
                  <div className="hint">{n.req.email || "knocked at the server door"} · {new Date(n.req.at).toLocaleString()}</div>
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="primary mini" onClick={() => decide(n.req.username, "approve")}>Approve ✔</button>
                  <button className="danger mini" onClick={() => decide(n.req.username, "deny")}>Deny</button>
                </div>
              </div>
            ) : (
              <div className="notifitem" key={i}>{n.text}</div>
            ))}
          {msg && <div className="notifitem hint">{msg}</div>}
        </div>
      )}
    </div>
  );
}
