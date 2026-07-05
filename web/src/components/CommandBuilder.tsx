import { useEffect, useMemo, useRef, useState } from "react";
import { api, type OnlinePlayer, type Warp } from "../api";
import { COMMANDS, validateArg, type CmdSpec } from "../commands";

type Suggestion = { value: string; label?: string; desc?: string; icon?: string };

// Tokenized command input: pick a command, then fill each argument with typed
// autocomplete (players/items/warps/enums) and validation. Enter runs it.
export default function CommandBuilder({ onRun, serverUp }: { onRun: (cmd: string) => void; serverUp: boolean }) {
  const [spec, setSpec] = useState<CmdSpec | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [players, setPlayers] = useState<string[]>([]);
  const [warps, setWarps] = useState<string[]>([]);
  const [items, setItems] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Context data for suggestions (players refresh while server is up).
  useEffect(() => {
    fetch("/items/index.json").then((r) => r.json()).then(setItems).catch(() => {});
    api<{ warps: Record<string, Warp> }>("/warps").then((r) => setWarps(Object.keys(r.warps))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!serverUp) return;
    const load = () => api<{ online: OnlinePlayer[] }>("/players").then((r) => setPlayers(r.online.map((p) => p.name))).catch(() => {});
    load();
    const id = setInterval(() => !document.hidden && load(), 15000);
    return () => clearInterval(id);
  }, [serverUp]);

  const argIdx = chips.length;
  const curArg = spec?.args[argIdx];
  const isTextArg = curArg?.type.kind === "text";

  const suggestions: Suggestion[] = useMemo(() => {
    const q = text.toLowerCase();
    if (!spec) {
      return COMMANDS
        .filter((c) => c.name.startsWith(q) || c.desc.toLowerCase().includes(q))
        .slice(0, 12)
        .map((c) => ({ value: c.name, desc: c.desc }));
    }
    if (!curArg || isTextArg) return [];
    switch (curArg.type.kind) {
      case "player": return players.filter((p) => p.toLowerCase().startsWith(q)).map((p) => ({ value: p, desc: "online" }));
      case "warp": return warps.filter((w) => w.toLowerCase().startsWith(q)).map((w) => ({ value: w, desc: "warp" }));
      case "item":
        return items.filter((i) => i.includes(q)).slice(0, 30).map((i) => ({ value: i, icon: `/items/${i}.png` }));
      case "enum": return curArg.type.options.filter((o) => o.toLowerCase().includes(q)).map((o) => ({ value: o }));
      default: return [];
    }
  }, [spec, curArg, isTextArg, text, players, warps, items]);

  useEffect(() => setSel(0), [text, spec, chips.length]);

  const err = curArg && text && !isTextArg ? validateArg(curArg.type, text) : null;
  const remainingRequired = spec ? spec.args.slice(argIdx).filter((a) => !a.optional).length : 1;
  const canRun = spec && (remainingRequired === 0 || (remainingRequired === 1 && curArg && !err && text.trim() !== ""));

  function accept(value: string) {
    if (!spec) {
      const c = COMMANDS.find((x) => x.name === value);
      if (c) { setSpec(c); setText(""); }
      return;
    }
    if (!curArg) return;
    const v = value.trim();
    if (!isTextArg && validateArg(curArg.type, v)) return; // invalid — keep editing
    if (v) { setChips([...chips, v]); setText(""); }
  }

  function run() {
    if (!spec) return;
    const parts = [...chips];
    if (text.trim()) parts.push(text.trim());
    onRun([spec.name, ...parts].join(" "));
    reset();
  }

  function reset() { setSpec(null); setChips([]); setText(""); }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !text) {
      e.preventDefault();
      if (chips.length) setChips(chips.slice(0, -1));
      else setSpec(null);
    } else if ((e.key === "Tab" || e.key === " ") && suggestions.length && !isTextArg) {
      if (e.key === "Tab" || (text && !suggestions.some((s) => s.value === text))) {
        e.preventDefault();
        accept(suggestions[sel]?.value ?? text);
      } else if (e.key === " " && text) {
        e.preventDefault();
        accept(text);
      }
    } else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (!spec && suggestions.length) accept(suggestions[sel].value);
      else if (spec && curArg && text && !isTextArg && suggestions.length && suggestions[sel].value.toLowerCase() === text.toLowerCase()) accept(suggestions[sel].value);
      else if (canRun) run();
      else if (spec && curArg && text) accept(text);
    } else if (e.key === "Escape") reset();
  }

  const hint = !spec
    ? "type a command… (say, give, tp, weather, gamemode …)"
    : curArg
      ? `${spec.name} → ${spec.args.map((a, i) => {
          const label = a.optional ? `[${a.name}]` : `<${a.name}>`;
          return i === argIdx ? `▶${label}` : label;
        }).join(" ")}`
      : "press Enter to run";

  return (
    <div className="cmdbuilder">
      <div className="chips" onClick={() => inputRef.current?.focus()}>
        {spec && <span className="chip cmd">{spec.name}</span>}
        {chips.map((c, i) => {
          const t = spec?.args[i]?.type;
          return <span className="chip" key={i}>
            {t?.kind === "item" && <img src={`/items/${c}.png`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
            {c}
          </span>;
        })}
        <input
          ref={inputRef}
          value={text}
          placeholder={spec ? (curArg ? curArg.name + (curArg.optional ? " (optional)" : "") : "↵ run") : "command…"}
          className={err ? "bad" : ""}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="primary" disabled={!canRun} onClick={run}>Run</button>
        {spec?.danger && <span className="err" title="destructive command">⚠</span>}
      </div>
      <div className="arghint">{err ? <span className="err">{err}</span> : hint}</div>
      {suggestions.length > 0 && document.activeElement === inputRef.current !== false && (
        <div className="suggest">
          {suggestions.map((s, i) => (
            <div key={s.value} className={i === sel ? "sel" : ""} onMouseDown={(e) => { e.preventDefault(); accept(s.value); }}>
              {s.icon && <img src={s.icon} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
              <span>{s.value}</span>
              {s.desc && <span className="desc">{s.desc}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
