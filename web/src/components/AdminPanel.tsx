import { createContext, useContext, useState } from "react";
import { auth, type Status } from "../api";
import DeckTab from "./DeckTab";
import PlayersTab from "./PlayersTab";
import RequestsTab from "./RequestsTab";
import WorldsTab from "./WorldsTab";
import SettingsTab from "./SettingsTab";
import ModsTab from "./ModsTab";
import BackupsTab from "./BackupsTab";
import AdminsTab from "./AdminsTab";
import ConsoleTab from "./ConsoleTab";

// Small shared "op status" line so any tab can report background progress.
export const OpStatusCtx = createContext<(msg: string) => void>(() => {});
export const useOpStatus = () => useContext(OpStatusCtx);

const TABS = ["Deck", "Players", "Requests", "Worlds", "Mods", "Settings", "Backups", "Admins", "Console"] as const;

export default function AdminPanel({ status }: { status: Status | null }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Players");
  const [opMsg, setOpMsg] = useState("");
  const [reqCount, setReqCount] = useState(0);

  return (
    <OpStatusCtx.Provider value={setOpMsg}>
      <nav className="tabs">
        {TABS.map((t, i) => (
          <button key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>
            <span className="hex">0x{i.toString(16).padStart(2, "0")}</span>{t}
            {t === "Requests" && reqCount > 0 && <span className="badge" style={{ marginLeft: 6 }}>{reqCount}</span>}
          </button>
        ))}
      </nav>
      <div className="pane">
        {tab === "Deck" && <DeckTab serverUp={status?.instance === "running"} />}
        {tab === "Mods" && <ModsTab />}
        {tab === "Players" && <PlayersTab serverUp={status?.instance === "running"} />}
        {tab === "Requests" && <RequestsTab onCount={setReqCount} />}
        {tab === "Worlds" && <WorldsTab activeProfile={status?.activeProfile || ""} />}
        {tab === "Settings" && <SettingsTab />}
        {tab === "Backups" && <BackupsTab />}
        {tab === "Admins" && <AdminsTab />}
        {tab === "Console" && <ConsoleTab serverUp={status?.instance === "running"} />}
      </div>
      {opMsg && <div className="opstatus">{opMsg}</div>}
      <div className="row logout-row">
        <span className="hint spacer">{auth.email && `signed in as ${auth.email}`}</span>
        <button onClick={() => auth.clear()}>Log out</button>
      </div>
    </OpStatusCtx.Provider>
  );
}
