import { useEffect, useRef, useState } from "react";
import { api, auth, type Status } from "./api";
import { useInterval } from "./hooks";
import AdminPanel from "./components/AdminPanel";
import NotificationCenter from "./components/NotificationCenter";

function StatusCard({ status, onStarted }: { status: Status | null; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const startedAt = useRef(0);

  if (!status) return <section className="card frame"><div className="face">📡</div><div className="statusline">Can't reach the control API right now — try refreshing.</div></section>;

  const srv = status.server;
  const waking = status.instance === "pending" ||
    (status.instance === "running" && (!srv || srv.state === "starting" || srv.state === "unknown"));

  let body;
  if (status.instance === "stopped") {
    body = (<>
      <div className="face">😴</div>
      <div className="statusline">The server is asleep</div>
      <button className="bigbtn" disabled={busy} onClick={async () => {
        setBusy(true); setErr("");
        try { await api("/start", { method: "POST", body: "{}" }); startedAt.current = Date.now(); onStarted(); }
        catch (e: any) { setErr(e.message); }
        finally { setBusy(false); }
      }}>▶ Start the server</button>
      {err && <p className="err">{err}</p>}
    </>);
  } else if (waking) {
    const pct = Math.min(95, ((Date.now() - (startedAt.current || Date.now() - 30000)) / 120000) * 100);
    body = (<>
      <div className="face">🌅</div>
      <div className="statusline">Waking up…</div>
      <div className="bar"><div style={{ width: pct + "%" }} /></div>
      <p className="hint">this takes about 2 minutes</p>
    </>);
  } else if (status.instance === "running" && srv?.state === "running") {
    const n = srv.players ?? 0;
    body = (<>
      <div className="face">🟢</div>
      <div className="statusline">The server is ON — come play!</div>
      <div className="addr-row">
        <code className="addr">{status.address}</code>
        <CopyButton text={status.address} />
      </div>
      <p>{n === 0
        ? `Nobody on yet — world "${srv.profile}" is waiting (sleeps in ${Math.max(1, 15 - (srv.idleMinutes || 0))} min if empty)`
        : `🎮 ${n} player${n === 1 ? "" : "s"} on right now in "${srv.profile}"`}</p>
      <p className="hint">Open Minecraft → Multiplayer → Add Server → paste the address</p>
    </>);
  } else if (status.instance === "stopping") {
    body = <><div className="face">🌙</div><div className="statusline">Going to sleep… (world is being saved and backed up)</div></>;
  } else {
    body = <><div className="face">🤔</div><div className="statusline">Server machine is {status.instance}</div></>;
  }

  return (
    <section className="card frame">
      {body}
      <div className="row center">
        <a className="linkbtn" href="#/map">🗺️ World map</a>
      </div>
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
    {copied ? "Copied!" : "Copy"}
  </button>;
}

function JoinForm() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  return (
    <details className="section">
      <summary>Want to play here? Ask to join</summary>
      <p className="hint">Tell us your Minecraft username and an email. A grown-up will approve you and you'll get an email when you're in.</p>
      <div className="row">
        <input placeholder="Minecraft username" maxLength={16} value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button onClick={async () => {
          try {
            const r = await api<{ note: string }>("/join-request", { method: "POST", body: JSON.stringify({ username, email }) });
            setMsg(r.note); setUsername(""); setEmail("");
          } catch (e: any) { setMsg(e.message); }
        }}>Ask to join</button>
      </div>
      {msg && <p className="hint">{msg}</p>}
    </details>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  return (
    <section className="card frame" style={{ textAlign: "left" }}>
      <p className="hint">Admins sign in with an email link — no password to remember.</p>
      <div className="row">
        <input type="email" placeholder="your@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary" onClick={async () => {
          setErr("");
          try { setMsg((await api<{ note: string }>("/login-request", { method: "POST", body: JSON.stringify({ email }) })).note); }
          catch (e: any) { setErr(e.message); }
        }}>Email me a sign-in link</button>
      </div>
      {msg && <p className="hint ok">{msg}</p>}
      <details>
        <summary className="hint">use the break-glass password instead</summary>
        <div className="row">
          <input type="password" placeholder="Admin password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button onClick={async () => {
            setErr("");
            try {
              const r = await api<{ token: string }>("/login", { method: "POST", body: JSON.stringify({ password: pw }) });
              auth.set(r.token, "password login");
            } catch (e: any) { setErr(e.message); }
          }}>Log in</button>
        </div>
      </details>
      {err && <p className="err">{err}</p>}
    </section>
  );
}

function MapPage({ status }: { status: Status | null }) {
  const [dim, setDim] = useState<"" | "nether" | "end">("");
  const [dims, setDims] = useState<string[]>([""]);
  const [stats, setStats] = useState<{ km2: number } | null>(null);
  const [archive, setArchive] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const found = [""];
      for (const d of ["nether", "end"]) {
        try { if ((await fetch(`/map/${d}/index.html`, { method: "HEAD" })).ok) found.push(d); } catch {}
      }
      setDims(found);
      try { setStats(await (await fetch("/map/stats.json", { cache: "no-store" })).json()); } catch {}
      try { setArchive(await (await fetch("/map-archive/index.json", { cache: "no-store" })).json()); } catch {}
    })();
  }, []);

  const n = status?.server?.state === "running" ? status.server.players ?? 0 : 0;
  return (
    <div className="mapwrap">
      {dims.length > 1 && (
        <div className="dimtabs">
          {dims.map((d) => (
            <button key={d} className={"tab" + (dim === d ? " active" : "")} onClick={() => setDim(d as any)}>
              {d === "" ? "overworld" : d}
            </button>
          ))}
        </div>
      )}
      <iframe src={`/map/${dim ? dim + "/" : ""}index.html`} title="world map" />
      <p className="maphint">
        {n > 0 ? `🟢 ${n} playing now — heads on the map are live · ` : ""}
        {stats ? `explored ${stats.km2} km² · ` : ""}
        shift+click to pin (grown-ups)
        {archive.length > 0 && <> · history:{" "}
          {archive.map((a) => (
            <a key={a} href={`/map-archive/${a}`} target="_blank" rel="noopener">{a.replace(/^.*-(\d{4}-\d{2})\.png$/, "$1")}</a>
          )).reduce((acc: any[], el, i) => (i ? [...acc, " ", el] : [el]), [])}
        </>}
      </p>
    </div>
  );
}

const getRoute = () =>
  location.hash.startsWith("#/admin") ? "admin" : location.hash.startsWith("#/map") ? "map" : "home";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [route, setRoute] = useState<"home" | "admin" | "map">(getRoute());
  const [, force] = useState(0);

  useEffect(() => { auth.subscribe(() => force((n) => n + 1)); }, []);
  useEffect(() => {
    const onHash = () => setRoute(getRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = () => api<Status>("/status").then(setStatus).catch(() => setStatus(null));
  useEffect(() => { refresh(); }, []);
  useInterval(refresh, 5000);

  // Magic-link arrival (?login=<token>) — land on the admin page.
  useEffect(() => {
    const t = new URLSearchParams(location.search).get("login");
    if (!t) return;
    history.replaceState(null, "", location.pathname + "#/admin");
    setRoute("admin");
    api<{ token: string; email: string }>("/login-verify", { method: "POST", body: JSON.stringify({ token: t }) })
      .then((r) => auth.set(r.token, r.email))
      .catch((e) => alert(e.message));
  }, []);

  return (
    <>
      <nav className="topbar">
        <a href="#/" className="brand">HAMAR<span className="accent">0</span>×MC</a>
        <span className="spacer" />
        <a href="#/" className={"navlink" + (route === "home" ? " active" : "")}>home</a>
        <a href="#/map" className={"navlink" + (route === "map" ? " active" : "")}>map</a>
        <a href="#/admin" className={"navlink" + (route === "admin" ? " active" : "")}>grown-ups</a>
        <NotificationCenter />
      </nav>
      {route === "map" ? <MapPage status={status} /> : (
      <main className={route === "admin" ? "wide" : ""}>
        {route === "home" ? (
          <>
            <header>
              <h1>HAMAR<span className="accent">0</span>×MC<span className="cursor" /></h1>
              <p className="sub"><b>Hazel</b> · <b>Marlowe</b> · <b>Rowan</b> — family server // mc.rowan.wang</p>
              <div className="dither" />
            </header>
            <StatusCard status={status} onStarted={refresh} />
            <p className="note">The server takes a nap after 15 minutes with nobody playing — that's normal! Just press Start and it wakes right up.</p>
            <JoinForm />
          </>
        ) : (
          <>
            <header className="pagehead">
              <h2>0xADMIN<span className="cursor" /></h2>
              <p className="sub">server controls // signed-in grown-ups only</p>
            </header>
            {auth.token ? <AdminPanel status={status} /> : <Login />}
          </>
        )}
        <footer>
          runs on AWS · turns itself off to save money · built with ❤️ for H+M+R ·{" "}
          <a href="https://github.com/mkwng/hamaro-minecraft" rel="noopener">how it works</a>
        </footer>
      </main>
      )}
    </>
  );
}
