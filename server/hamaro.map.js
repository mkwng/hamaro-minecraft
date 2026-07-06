// Injected into the uNmINeD viewer by render-map.sh (overworld only).
// - refreshes custom.markers.js every 45s (live players + pins, no reload)
// - shift+click adds a pin (warp) via the admin API when signed in
(function () {
  const API = "https://api.mc.rowan.wang";
  const toast = (t) => (typeof Toastify !== "undefined"
    ? Toastify({ text: t, duration: 3500, gravity: "bottom" }).showToast() : alert(t));

  window.refreshHamaroMarkers = async function () {
    try {
      if (typeof unmined === "undefined" || !unmined.olMap) return;
      const txt = await (await fetch("custom.markers.js?t=" + Date.now(), { cache: "no-store" })).text();
      (0, eval)(txt);
      const m = (typeof UnminedCustomMarkers !== "undefined" && UnminedCustomMarkers.isEnabled && UnminedCustomMarkers.markers) || [];
      if (unmined.markersLayer) unmined.olMap.removeLayer(unmined.markersLayer);
      unmined.markersLayer = unmined.createMarkersLayer(m);
      unmined.olMap.addLayer(unmined.markersLayer);
    } catch (e) { /* transient */ }
  };
  setInterval(window.refreshHamaroMarkers, 45000);

  function armPinning() {
    if (typeof unmined === "undefined" || !unmined.olMap) return setTimeout(armPinning, 500);
    unmined.olMap.on("singleclick", (ev) => {
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
  }
  armPinning();
})();
