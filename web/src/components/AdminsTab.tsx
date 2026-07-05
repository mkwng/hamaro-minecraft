import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../hooks";

export default function AdminsTab() {
  const [data, reload] = useAsync(() => api<{ admins: string[] }>("/admins"));
  const [email, setEmail] = useState("");
  const admins = data?.admins || [];

  return (
    <>
      <p>Admins sign in with email links. Add the other dads here; remove an email to revoke access.</p>
      <ul className="list">
        {admins.map((e) => (
          <li key={e}>{e}<span className="spacer" />
            <button onClick={async () => {
              if (!confirm(`Remove ${e} from admins?`)) return;
              await api("/admins", { method: "PUT", body: JSON.stringify({ admins: admins.filter((x) => x !== e) }) });
              reload();
            }}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input type="email" placeholder="dad@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button onClick={async () => {
          if (!email) return;
          await api("/admins", { method: "PUT", body: JSON.stringify({ admins: [...admins, email] }) });
          setEmail(""); reload();
        }}>Add admin</button>
      </div>
    </>
  );
}
