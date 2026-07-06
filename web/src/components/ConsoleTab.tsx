import { useEffect, useRef, useState } from "react";
import { api, watchOp } from "../api";
import { useInterval } from "../hooks";
import { useOpStatus } from "./AdminPanel";
import CommandBuilder from "./CommandBuilder";

// Full command history (who ran what, from every admin and the GUI) with re-run.
function ActionHistory() {
  const flash = useOpStatus();
  const [actions, setActions] = useState<{ ts: number; who: string; commands: string[] }[]>([]);
  useEffect(() => { api<{ actions: any[] }>("/actions").then((r) => setActions(r.actions)).catch(() => {}); }, []);
  if (!actions.length) return null;
  return (
    <>
      <h3>History <span className="hint">(every admin action — watch and learn)</span></h3>
      <div className="feed">
        {actions.slice(0, 15).map((a, i) => (
          <div key={a.ts + "-" + i} className="feeditem">
            <span className="hint">{new Date(a.ts).toLocaleString()} · {a.who}</span>
            <code>{a.commands.slice(0, 3).join("  ·  ")}{a.commands.length > 3 ? `  (+${a.commands.length - 3})` : ""}</code>
            <span className="spacer" />
            <button className="mini" title="run again" onClick={() =>
              api("/commands", { method: "POST", body: JSON.stringify({ commands: a.commands }) })
                .then(() => flash("✔ re-ran")).catch((e) => flash("✖ " + e.message))}>↻</button>
          </div>
        ))}
      </div>
    </>
  );
}

function LogLine({ line }: { line: string }) {
  const cls = /ERROR|Exception/i.test(line) ? "error" : /WARN/i.test(line) ? "warn" : "";
  return <div className={cls}>{line}</div>;
}

export default function ConsoleTab({ serverUp }: { serverUp: boolean }) {
  const flash = useOpStatus();
  const [log, setLog] = useState<string>("");
  const [paused, setPaused] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // stick to bottom unless the user scrolled up

  const loadLog = async () => {
    if (!serverUp || paused) return;
    try {
      const r = await api<{ log: string; serverUp: boolean }>("/logs?lines=150");
      setLog(r.serverUp ? r.log : "");
    } catch { /* transient */ }
  };
  useEffect(() => { loadLog(); }, [serverUp]);
  useInterval(loadLog, 5000);

  useEffect(() => {
    const el = pane.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const runCommand = async (command: string) => {
    try {
      const r = await api<{ commandId: string }>("/command", { method: "POST", body: JSON.stringify({ command }) });
      flash(`> ${command}`);
      const res = await watchOp(r.commandId, () => {});
      flash(res.status === "Success" ? `> ${command}\n${(res.output || "").trim() || "✔ done"}` : `✖ ${command}: ${res.error || res.status}`);
      loadLog();
    } catch (e: any) { flash("✖ " + e.message); }
  };

  return (
    <>
      {serverUp ? (
        <div
          className="logpane"
          ref={pane}
          onScroll={() => {
            const el = pane.current!;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {log ? log.split("\n").map((l, i) => <LogLine key={i} line={l} />) : "waiting for log…"}
        </div>
      ) : (
        <p className="hint">(server is asleep — logs and commands need it running)</p>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <label className="hint"><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> pause log</label>
      </div>

      <CommandBuilder onRun={runCommand} serverUp={serverUp} />

      <ActionHistory />

      <hr />
      <div className="row">
        <button onClick={async () => {
          try {
            const r = await api<{ commandId: string }>("/map/render", { method: "POST", body: "{}" });
            flash("Rendering world map…");
            const res = await watchOp(r.commandId, (s) => flash(`Rendering world map… (${s})`));
            flash(res.status === "Success" ? "✔ map updated — see /map/" : "✖ map render " + res.status);
          } catch (e: any) { flash("✖ " + e.message); }
        }}>Update world map now</button>
        <button className="danger" onClick={async () => {
          if (!confirm("Stop the server now? It saves and backs up first.")) return;
          try {
            const r = await api<{ commandId: string }>("/stop", { method: "POST", body: "{}" });
            flash("Stopping…");
            watchOp(r.commandId, (s) => flash(`Stopping… (${s})`));
          } catch (e: any) { flash("✖ " + e.message); }
        }}>Stop server now (saves + backs up first)</button>
      </div>
    </>
  );
}
