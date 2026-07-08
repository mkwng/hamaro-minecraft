// Injected into the uNmINeD viewer by render-map.sh (overworld only).
// - refreshes custom.markers.js every 45s (live players + pins, no reload)
// - auto-zooms to fit everyone online when the roster changes (join/leave/first
//   load) — but never within 30s of the user panning/zooming themselves
// - finer mousewheel zoom: fractional zoom levels, smaller steps
// - shift+click adds a pin (warp) via the admin API when signed in
(function () {
  const API = "https://api.mc.rowan.wang";
  const toast = (t) => (typeof Toastify !== "undefined"
    ? Toastify({ text: t, duration: 3500, gravity: "bottom" }).showToast() : alert(t));

  let lastUserMove = 0;   // ms timestamp of the user's last pan/zoom gesture
  let lastRoster = null;  // who was online at the previous marker refresh

  window.refreshHamaroMarkers = async function () {
    try {
      if (typeof unmined === "undefined" || !unmined.olMap) return;
      const txt = await (await fetch("custom.markers.js?t=" + Date.now(), { cache: "no-store" })).text();
      (0, eval)(txt);
      const m = (typeof UnminedCustomMarkers !== "undefined" && UnminedCustomMarkers.isEnabled && UnminedCustomMarkers.markers) || [];
      if (unmined.markersLayer) unmined.olMap.removeLayer(unmined.markersLayer);
      unmined.markersLayer = unmined.createMarkersLayer(m);
      unmined.olMap.addLayer(unmined.markersLayer);
      smartZoom(m.filter((k) => k.isPlayer));
    } catch (e) { /* transient */ }
  };
  setInterval(window.refreshHamaroMarkers, 45000);

  // Fit the view around the group of online players (generously padded, which
  // also keeps a lone player from zooming in to max). Only when the roster
  // actually changes, and never right after the user drove the map — a live
  // map that keeps yanking the camera is worse than no auto-zoom at all.
  function smartZoom(players) {
    const roster = players.map((p) => p.text).sort().join(",");
    const changed = roster !== lastRoster;
    lastRoster = roster;
    if (!changed || players.length === 0 || Date.now() - lastUserMove < 30000) return;
    const xs = players.map((p) => p.x), zs = players.map((p) => p.z);
    const PAD = 96; // blocks of breathing room around the group
    const a = ol.proj.transform([Math.min(...xs) - PAD, Math.min(...zs) - PAD], unmined.dataProjection, unmined.viewProjection);
    const b = ol.proj.transform([Math.max(...xs) + PAD, Math.max(...zs) + PAD], unmined.dataProjection, unmined.viewProjection);
    unmined.olMap.getView().fit(ol.extent.boundingExtent([a, b]), { padding: [60, 60, 60, 60], duration: 800 });
  }

  function armMap() {
    if (typeof unmined === "undefined" || !unmined.olMap) return setTimeout(armMap, 500);
    const map = unmined.olMap;

    // Finer wheel zoom: default OL snaps a whole 2× level per notch. Allow
    // fractional resolutions and cap each wheel burst at a fraction of a level.
    const view = map.getView();
    if (view.setConstrainResolution) view.setConstrainResolution(false);
    map.getInteractions().getArray().slice()
      .filter((i) => i instanceof ol.interaction.MouseWheelZoom)
      .forEach((i) => map.removeInteraction(i));
    map.addInteraction(new ol.interaction.MouseWheelZoom({ maxDelta: 0.4, duration: 250, timeout: 80 }));

    // Any human gesture pauses auto-zoom for a while.
    const mark = () => { lastUserMove = Date.now(); };
    map.on("pointerdrag", mark);
    map.getViewport().addEventListener("wheel", mark, { passive: true });

    map.on("singleclick", (ev) => {
      if (!ev.originalEvent.shiftKey) return;
      const [wx, wz] = ol.proj.transform(ev.coordinate, unmined.viewProjection, unmined.dataProjection);
      const token = localStorage.getItem("hamaro-token");
      if (!token) return toast("Sign in on the Grown-ups page to add pins");
      const name = prompt(`Pin at ${Math.round(wx)}, ${Math.round(wz)} — name it:`);
      if (!name) return;
      const type = (prompt("Type: pin / home / farm / portal / danger / star", "pin") || "pin").trim();
      fetch(API + "/warps", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ name, x: Math.round(wx), y: 64, z: Math.round(wz), type }),
      })
        .then((r) => r.json())
        .then((r) => { if (r.error) throw new Error(r.error); toast("📍 pinned " + name); window.refreshHamaroMarkers(); })
        .catch((e) => toast("✖ " + e.message));
    });

    window.refreshHamaroMarkers(); // initial load doubles as the first smart zoom
  }
  armMap();
})();
