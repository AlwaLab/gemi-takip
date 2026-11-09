/* Gemi Takip — front end */
(() => {
  "use strict";

  const STALE_MIN = 30;            // a position older than this is shown as stale
  const EXPLORE_MIN_ZOOM = 7;      // explore only when zoomed in (server caps area too)
  const EXPLORE_COLOR = "#8a94a3";

  const SHIP_TYPES = [
    [20, 29, "Kanat etkili araç"], [30, 30, "Balıkçı"], [31, 32, "Römorkör (çekme)"],
    [33, 33, "Tarama"], [34, 34, "Dalış"], [35, 35, "Askerî"], [36, 36, "Yelkenli"],
    [37, 37, "Gezi teknesi"], [40, 49, "Yüksek hızlı tekne"], [50, 50, "Kılavuz"],
    [51, 51, "Arama-kurtarma"], [52, 52, "Römorkör"], [53, 53, "Liman hizmet"],
    [54, 54, "Kirlilik önleme"], [55, 55, "Kolluk"], [58, 58, "Tıbbi"],
    [60, 69, "Yolcu"], [70, 79, "Kargo"], [80, 89, "Tanker"], [90, 99, "Diğer"],
  ];
  const NAV_STATUS = {
    0: "Seyirde (makine)", 1: "Demirde", 2: "Manevra kabiliyeti yok", 3: "Kısıtlı manevra",
    4: "Su çekimi nedeniyle kısıtlı", 5: "Bağlı (rıhtımda)", 6: "Karaya oturmuş",
    7: "Balıkçılık yapıyor", 8: "Seyirde (yelken)", 14: "AIS-SART (acil)",
  };
  const shipType = (t) => (SHIP_TYPES.find(([a, b]) => t >= a && t <= b) || [])[2] || null;

  // ---------------------------------------------------------------- state
  const watch = new Map();     // mmsi -> {mmsi, label, color, vessel, marker, track}
  const explore = new Map();   // mmsi -> {vessel, marker}
  let selected = null;
  let exploreOn = false;
  let ws;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- map
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([39.5, 30], 5);
  const esri = (path, attribution, maxZoom = 16) =>
    L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom, attribution });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const darkGray = esri("Canvas/World_Dark_Gray_Base", "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap");
  const ocean = esri("Ocean/World_Ocean_Base", "&copy; Esri, GEBCO, NOAA, National Geographic", 13);
  const baseMap = dark ? darkGray : osm;
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 18, attribution: "Görüntü &copy; Esri, Maxar, Earthstar Geographics",
  });
  const seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a>',
  });
  baseMap.addTo(map);
  L.control.layers(
    { "Harita": baseMap, ...(dark ? { "Açık harita": osm } : { "Koyu harita": darkGray }), "Okyanus": ocean, "Uydu görüntüsü": satellite },
    { "Deniz işaretleri": seamarks },
    { position: "topright" },
  ).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const exploreLayer = L.layerGroup().addTo(map);

  function shipSvg(color, rotation, moving, big) {
    const s = big ? 30 : 22;
    if (!moving) {
      return `<svg width="${s}" height="${s}" viewBox="-12 -12 24 24"><circle r="${big ? 6 : 4.5}" fill="${color}" stroke="#fff" stroke-width="1.6"/></svg>`;
    }
    return `<svg width="${s}" height="${s}" viewBox="-12 -12 24 24"><g transform="rotate(${rotation})">
      <path d="M0 -10 L6 8 L0 4.5 L-6 8 Z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g></svg>`;
  }

  function iconFor(v, color, big) {
    const rot = v.heading ?? v.cog ?? 0;
    const moving = (v.sog ?? 0) >= 0.5 && (v.heading != null || v.cog != null);
    const s = big ? 30 : 22;
    return L.divIcon({ className: "vessel-icon", html: shipSvg(color, rot, moving, big), iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
  }

  const displayName = (w) => w.label || w.vessel?.name || `MMSI ${w.mmsi}`;

  // ---------------------------------------------------------------- formatting
  function ago(ts) {
    if (!ts) return null;
    const m = Math.max(0, (Date.now() / 1000 - ts) / 60);
    if (m < 1) return "az önce";
    if (m < 60) return `${Math.round(m)} dk önce`;
    if (m < 60 * 24) return `${Math.round(m / 60)} sa önce`;
    return `${Math.round(m / 1440)} gün önce`;
  }
  const isStale = (ts) => ts && Date.now() / 1000 - ts > STALE_MIN * 60;
  const fmt = (n, d = 1) => (n == null ? "—" : Number(n).toFixed(d));
  function coord(lat, lon) {
    if (lat == null) return "—";
    const f = (x, p, n) => `${Math.abs(x).toFixed(4)}° ${x >= 0 ? p : n}`;
    return `${f(lat, "K", "G")}, ${f(lon, "D", "B")}`;
  }

  // ---------------------------------------------------------------- watchlist UI
  function renderList() {
    const ul = $("watchlist");
    ul.innerHTML = "";
    $("count").textContent = watch.size;
    $("emptyMsg").hidden = watch.size > 0;
    for (const w of watch.values()) {
      const v = w.vessel || {};
      const li = document.createElement("li");
      li.className = "ship" + (selected === w.mmsi ? " selected" : "");
      li.dataset.mmsi = w.mmsi;
      const seen = v.ts ? `<span class="${isStale(v.ts) ? "stale" : ""}">${ago(v.ts)}</span>` : `<span class="nosig">sinyal bekleniyor</span>`;
      const sub = [v.name && w.label ? esc(v.name) : null, `MMSI ${w.mmsi}`].filter(Boolean).join(" · ");
      li.innerHTML = `
        <span class="bar" style="background:${w.color}"></span>
        <div class="ship-info">
          <div class="name">${esc(displayName(w))}</div>
          ${w.label || v.name ? `<div class="sub">${sub}</div>` : ""}
          ${v.destination ? `<div class="sub">→ ${esc(v.destination)}</div>` : ""}
        </div>
        <div class="meta">
          ${v.sog != null ? `<div class="spd">${fmt(v.sog)} kn</div>` : ""}
          <div>${seen}</div>
        </div>`;
      li.addEventListener("click", () => select(w.mmsi, true));
      ul.appendChild(li);
    }
  }

  function upsertWatchMarker(w) {
    const v = w.vessel;
    if (!v || v.lat == null) return;
    const big = selected === w.mmsi;
    const ll = [v.lat, v.lon];
    if (!w.marker) {
      w.marker = L.marker(ll, { icon: iconFor(v, w.color, big), zIndexOffset: 1000 })
        .addTo(map)
        .on("click", () => select(w.mmsi, false));
      w.marker.bindTooltip("", { permanent: true, direction: "right", offset: [12, 0], className: "vessel-label" });
    } else {
      w.marker.setLatLng(ll).setIcon(iconFor(v, w.color, big));
    }
    w.marker.setTooltipContent(esc(displayName(w)));
  }

  async function loadTrack(w) {
    const pts = await (await fetch(`/api/track/${w.mmsi}?hours=72`)).json();
    const lls = pts.map(([, lat, lon]) => [lat, lon]);
    if (w.track) w.track.setLatLngs(lls);
    else w.track = L.polyline(lls, { color: w.color, weight: 2.5, opacity: .75 }).addTo(map);
  }

  function addPointToTrack(w, point) {
    if (!point || !w.track) return;
    const lls = w.track.getLatLngs();
    const last = lls[lls.length - 1];
    if (!last || last.distanceTo([point[1], point[2]]) > 50) w.track.addLatLng([point[1], point[2]]);
  }

  // ---------------------------------------------------------------- detail panel
  function select(mmsi, pan) {
    const prev = selected;
    selected = mmsi;
    if (prev && watch.has(prev)) upsertWatchMarker(watch.get(prev));
    const w = watch.get(mmsi);
    const e = explore.get(mmsi);
    if (w) upsertWatchMarker(w);
    const v = (w && w.vessel) || (e && e.vessel);
    if (pan && v && v.lat != null) map.setView([v.lat, v.lon], Math.max(map.getZoom(), 9));
    renderDetail();
    renderList();
  }

  function renderDetail() {
    const box = $("detail");
    if (!selected) { box.hidden = true; return; }
    const w = watch.get(selected);
    const v = (w && w.vessel) || explore.get(selected)?.vessel || { mmsi: selected };
    const title = w ? displayName(w) : v.name || `MMSI ${selected}`;
    const status = NAV_STATUS[v.nav_status];
    const rows = [
      ["MMSI", v.mmsi || selected],
      ["IMO", v.imo], ["Çağrı işareti", v.callsign],
      ["Durum", status],
      ["Hız", v.sog != null ? `${fmt(v.sog)} knot` : null],
      ["Rota", v.cog != null ? `${fmt(v.cog, 0)}°` : null],
      ["Pruva", v.heading != null ? `${fmt(v.heading, 0)}°` : null],
      ["Varış yeri", v.destination], ["Tahmini varış", v.eta],
      ["Boyut", v.length ? `${v.length} × ${v.width ?? "?"} m` : null],
      ["Su çekimi", v.draught ? `${v.draught} m` : null],
      ["Konum", v.lat != null ? coord(v.lat, v.lon) : null],
      ["Son sinyal", v.ts ? ago(v.ts) : "henüz yok"],
    ].filter(([, val]) => val != null && val !== "");
    const typeLine = [shipType(v.ship_type), v.msg_class ? `AIS sınıf ${v.msg_class}` : null].filter(Boolean).join(" · ");
    $("detailBody").innerHTML = `
      <h3>${esc(title)}</h3>
      <div class="type">${esc(typeLine || "Tip bilgisi bekleniyor")}</div>
      <dl class="kv">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join("")}</dl>
      ${v.ts && isStale(v.ts) ? `<p class="ext">Son konum ${STALE_MIN} dakikadan eski: gemi alıcı kapsamı dışında olabilir.</p>` : ""}
      <div class="actions">
        ${w ? `<button class="btn" data-act="rename">Etiketi değiştir</button>
               <button class="btn danger" data-act="remove">Takipten çıkar</button>`
            : `<button class="btn primary" data-act="watch">Takibe al</button>`}
      </div>
      <p class="ext">Karşılaştır:
        <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${esc(selected)}" target="_blank" rel="noopener">MarineTraffic</a> ·
        <a href="https://www.vesselfinder.com/vessels/details/${esc(selected)}" target="_blank" rel="noopener">VesselFinder</a>
      </p>`;
    box.hidden = false;
  }

  $("detailBody").addEventListener("click", async (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act || !selected) return;
    const mmsi = selected;
    if (act === "watch") await addShip(mmsi, "");
    if (act === "remove") {
      await fetch(`/api/watchlist/${mmsi}`, { method: "DELETE" });
      const w = watch.get(mmsi);
      if (w?.marker) map.removeLayer(w.marker);
      if (w?.track) map.removeLayer(w.track);
      watch.delete(mmsi);
      selected = null;
      renderList(); renderDetail();
    }
    if (act === "rename") {
      const w = watch.get(mmsi);
      const label = prompt("Yeni etiket (boş bırakırsanız gemi adı kullanılır):", w.label || "");
      if (label === null) return;
      await fetch(`/api/watchlist/${mmsi}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
      w.label = label.trim() || null;
      upsertWatchMarker(w); renderList(); renderDetail();
    }
  });
  $("detailClose").addEventListener("click", () => { const p = selected; selected = null; if (watch.has(p)) upsertWatchMarker(watch.get(p)); renderDetail(); renderList(); });

  // ---------------------------------------------------------------- add ship
  async function addShip(mmsi, label) {
    const res = await fetch("/api/watchlist", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mmsi, label }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Eklenemedi");
    const e = explore.get(mmsi);
    if (e) { exploreLayer.removeLayer(e.marker); explore.delete(mmsi); }
    const w = { ...body, vessel: body.vessel };
    watch.set(mmsi, w);
    upsertWatchMarker(w);
    await loadTrack(w);
    select(mmsi, true);
    return w;
  }

  $("addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const mmsi = $("mmsiInput").value.trim();
    $("formMsg").textContent = "";
    if (!/^\d{9}$/.test(mmsi)) { $("formMsg").textContent = "MMSI 9 haneli bir sayı olmalı."; return; }
    try {
      await addShip(mmsi, $("labelInput").value.trim());
      $("mmsiInput").value = ""; $("labelInput").value = "";
    } catch (err) { $("formMsg").textContent = err.message; }
  });

  $("fitBtn").addEventListener("click", () => {
    const lls = [...watch.values()].map((w) => w.vessel).filter((v) => v?.lat != null).map((v) => [v.lat, v.lon]);
    if (lls.length === 1) map.setView(lls[0], 10);
    else if (lls.length) map.fitBounds(lls, { padding: [60, 60], maxZoom: 11 });
  });

  // ---------------------------------------------------------------- explore mode
  function exploreBbox() {
    const b = map.getBounds();
    const s = Math.max(b.getSouth(), -90), n = Math.min(b.getNorth(), 90);
    const w = Math.max(b.getWest(), -180), e = Math.min(b.getEast(), 180);
    return [[s, w], [n, e]];
  }

  function syncExplore() {
    const hint = $("exploreHint");
    if (!exploreOn) { hint.hidden = true; send({ type: "explore", bbox: null }); return; }
    if (map.getZoom() < EXPLORE_MIN_ZOOM) {
      hint.textContent = "Bölgedeki gemileri görmek için haritayı biraz daha yakınlaştırın.";
      hint.hidden = false;
      send({ type: "explore", bbox: null });
      return;
    }
    hint.textContent = "Görünür alandaki gemiler yükleniyor. Takibe almak için bir gemiye tıklayın.";
    hint.hidden = false;
    send({ type: "explore", bbox: exploreBbox() });
  }

  let exploreTimer;
  map.on("moveend", () => { if (exploreOn) { clearTimeout(exploreTimer); exploreTimer = setTimeout(syncExplore, 600); } });

  $("exploreBtn").addEventListener("click", () => {
    exploreOn = !exploreOn;
    $("exploreBtn").setAttribute("aria-pressed", String(exploreOn));
    if (!exploreOn) { exploreLayer.clearLayers(); explore.clear(); }
    syncExplore();
  });

  function onExplore(vessels) {
    if (!exploreOn) return;
    for (const v of vessels) {
      if (watch.has(v.mmsi)) continue;
      let e = explore.get(v.mmsi);
      if (!e) {
        e = { vessel: v, marker: L.marker([v.lat, v.lon], { icon: iconFor(v, EXPLORE_COLOR, false) }) };
        e.marker.on("click", () => select(v.mmsi, false));
        e.marker.bindTooltip("", { direction: "top", offset: [0, -8] });
        exploreLayer.addLayer(e.marker);
        explore.set(v.mmsi, e);
      } else {
        e.vessel = { ...e.vessel, ...v };
        e.marker.setLatLng([v.lat, v.lon]).setIcon(iconFor(e.vessel, EXPLORE_COLOR, false));
      }
      e.marker.setTooltipContent(esc(e.vessel.name || `MMSI ${v.mmsi}`));
    }
    const n = explore.size;
    $("exploreHint").textContent = `${n} gemi görünüyor. Takibe almak için bir gemiye tıklayın.`;
    if (selected && explore.has(selected)) renderDetail();
  }

  // ---------------------------------------------------------------- status & settings
  const WATCH_TEXT = { idle: "Takip listesi boş", connecting: "Veri kaynağına bağlanıyor…", live: "Canlı", error: "Bağlantı hatası" };
  function onStatus(s) {
    const el = $("status");
    const state = s.error ? "error" : s.watch;
    el.className = "status " + state;
    let text = s.error || WATCH_TEXT[s.watch] || s.watch;
    if (!s.error && s.watch === "live") text = `Canlı · ${s.provider}`;
    $("statusText").textContent = text;
    $("demoBanner").hidden = !s.demo;
  }

  async function openSettings() {
    const cfg = await (await fetch("/api/config")).json();
    $("keyInput").value = "";
    $("settings").returnValue = "";
    $("keyState").textContent = cfg.has_key ? `Kayıtlı anahtar: ${cfg.key_hint || "var"}. Boş bırakıp kaydederseniz demo moduna dönülür.` : "Şu an anahtar yok; demo modu çalışıyor.";
    $("settings").showModal();
  }
  $("settingsBtn").addEventListener("click", openSettings);
  $("demoSetup").addEventListener("click", openSettings);
  $("settings").addEventListener("close", async () => {
    if ($("settings").returnValue !== "save") return;
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aisstream_api_key: $("keyInput").value }) });
    if (exploreOn) { exploreLayer.clearLayers(); explore.clear(); syncExplore(); }
  });

  // ---------------------------------------------------------------- live socket
  function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => { if (exploreOn) syncExplore(); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "status") onStatus(msg);
      else if (msg.type === "explore") onExplore(msg.vessels);
      else if (msg.type === "vessel") {
        const w = watch.get(msg.vessel.mmsi);
        if (!w) return;
        const hadPos = w.vessel?.lat != null;
        w.vessel = msg.vessel;
        upsertWatchMarker(w);
        addPointToTrack(w, msg.point);
        if (!hadPos && selected === w.mmsi && msg.vessel.lat != null) map.setView([msg.vessel.lat, msg.vessel.lon], Math.max(map.getZoom(), 9));
        scheduleRender();
      }
    };
    ws.onclose = () => {
      onStatus({ watch: "connecting", error: "Sunucu bağlantısı koptu, yeniden deneniyor…" });
      setTimeout(connect, 2000);
    };
  }

  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; renderList(); if (selected) renderDetail(); });
  }
  setInterval(scheduleRender, 30000); // refresh "x dk önce"

  // ---------------------------------------------------------------- boot
  (async () => {
    const items = await (await fetch("/api/watchlist")).json();
    for (const w of items) {
      watch.set(w.mmsi, w);
      upsertWatchMarker(w);
      loadTrack(w);
    }
    renderList();
    if (items.some((w) => w.vessel?.lat != null)) $("fitBtn").click();
    connect();
  })();
})();
