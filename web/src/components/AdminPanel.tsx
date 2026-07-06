import { createContext, useContext, useState } from "react";
import { auth, type Status } from "../api";
import PlayersTab from "./PlayersTab";
import WorldTab from "./WorldTab";
import AdminsTab from "./AdminsTab";
import ConsoleTab from "./ConsoleTab";

// Small shared "op status" line so any tab can report background progress.
export const OpStatusCtx = createContext<(msg: string) => void>(() => {});
export const useOpStatus = () => useContext(OpStatusCtx);

// Four tabs, clear ownership: People / Place / Access / Power tools.
// (World has sub-sections: overview, warps, mods, settings, backups.)
const TABS = ["Players", "World", "Admins", "Console"] as const;

export default function AdminPanel({ status }: { status: Status | null }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Players");
  const [opMsg, setOpMsg] = useState("");
  const serverReady = status?.instance === "running" && status?.server?.state === "running";

  return (
    <OpStatusCtx.Provider value={setOpMsg}>
      <nav className="tabs">
        {TABS.map((t, i) => (
          <button key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>
            <span className="hex">0x{i.toString(16).padStart(2, "0")}</span>{t}
          </button>
        ))}
      </nav>
      <div className="pane">
        {tab === "Players" && <PlayersTab serverUp={serverReady} />}
        {tab === "World" && <WorldTab activeProfile={status?.activeProfile || ""} serverUp={serverReady} />}
        {tab === "Admins" && <AdminsTab />}
        {tab === "Console" && <ConsoleTab serverUp={serverReady} />}
      </div>
      {opMsg && <div className="opstatus">{opMsg}</div>}
      <div className="row logout-row">
        <span className="hint spacer">{auth.email && `signed in as ${auth.email}`}</span>
        <button onClick={() => auth.clear()}>Log out</button>
      </div>
    </OpStatusCtx.Provider>
  );
}
