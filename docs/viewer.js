/* Gemi Takip — read-only viewer for GitHub Pages.
   Data comes from data/latest.json and data/positions.csv, which the
   GitHub Action refreshes every 30 minutes. */
(() => {
  "use strict";

  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_H = 2;
  const PALETTE = ["#2f7df6", "#e8590c", "#2b8a3e", "#c2255c", "#7048e8",
                   "#0c8599", "#e67700", "#5c940d", "#a61e4d", "#1864ab"];
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

  const $ = (id) => document.getElementById(id);

  // Repo holding ships/: owner.github.io/repo/ -> github.com/owner/repo
  const REPO = location.hostname.endsWith(".github.io")
    ? `${location.hostname.split(".")[0]}/${location.pathname.split("/").filter(Boolean)[0]}`
    : "AlwaLab/gemi-takip";
  const GH = `https://github.com/${REPO}`;
  const addUrl = (mmsi, label) =>
    `${GH}/new/main/ships?filename=${mmsi}.txt&value=${encodeURIComponent(label && !/^MMSI /.test(label) ? label : "")}`;
  const editUrl = (mmsi) => `${GH}/edit/main/ships/${mmsi}.txt`;
  const deleteUrl = (mmsi) => `${GH}/delete/main/ships/${mmsi}.txt`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let ships = [];          // [{mmsi, color, state}]
  let rows = [];           // parsed CSV rows
  let selected = null;
  let firstLoad = true;
  const markers = new Map();
  const tracks = new Map();

  // ---------------------------------------------------------------- map
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const map = L.map("map", { worldCopyJump: true }).setView([39.5, 30], 5);
  const esri = (path, attribution, maxZoom = 16) =>
    L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom, attribution });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const darkGray = esri("Canvas/World_Dark_Gray_Base", "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap");
  const ocean = esri("Ocean/World_Ocean_Base", "&copy; Esri, GEBCO, NOAA, National Geographic", 13);
  const satellite = esri("World_Imagery", "Görüntü &copy; Esri, Maxar, Earthstar Geographics", 18);
  const seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a>',
  });
  const baseMap = dark ? darkGray : osm;
  baseMap.addTo(map);
  L.control.layers(
    { "Harita": baseMap, ...(dark ? { "Açık harita": osm } : { "Koyu harita": darkGray }), "Okyanus": ocean, "Uydu görüntüsü": satellite },
    { "Deniz işaretleri": seamarks },
  ).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  function icon(s, big) {
    const size = big ? 30 : 22;
    const moving = (s.sog ?? 0) >= 0.5 && (s.heading != null || s.cog != null);
    const rot = s.heading ?? s.cog ?? 0;
    const html = moving
      ? `<svg width="${size}" height="${size}" viewBox="-12 -12 24 24"><g transform="rotate(${rot})"><path d="M0 -10 L6 8 L0 4.5 L-6 8 Z" fill="${s.color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g></svg>`
      : `<svg width="${size}" height="${size}" viewBox="-12 -12 24 24"><circle r="${big ? 6 : 4.5}" fill="${s.color}" stroke="#fff" stroke-width="1.6"/></svg>`;
    return L.divIcon({ className: "vessel-icon", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  // ---------------------------------------------------------------- helpers
  const toTs = (iso) => (iso ? Date.parse(iso) / 1000 : null);
  function ago(ts) {
    if (!ts) return null;
    const m = Math.max(0, (Date.now() / 1000 - ts) / 60);
    if (m < 1) return "az önce";
    if (m < 60) return `${Math.round(m)} dk önce`;
    if (m < 60 * 24) return `${Math.round(m / 60)} sa önce`;
    return `${Math.round(m / 1440)} gün önce`;
  }
  const localTime = (ts) => new Date(ts * 1000).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
  const fmt = (n, d = 1) => (n == null || n === "" ? "—" : Number(n).toFixed(d));
  const coord = (lat, lon) => {
    const f = (x, p, n) => `${Math.abs(x).toFixed(4)}° ${x >= 0 ? p : n}`;
    return `${f(lat, "K", "G")}, ${f(lon, "D", "B")}`;
  };
  const nameOf = (s) => s.label || s.name || `MMSI ${s.mmsi}`;

  function parseCsv(text) {
    const out = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field.replace(/\r$/, "")); out.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field || row.length) { row.push(field); out.push(row); }
    const [head, ...body] = out;
    return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }

  // ---------------------------------------------------------------- render
  function renderList() {
    const ul = $("watchlist");
    ul.innerHTML = "";
    $("count").textContent = ships.length;
    $("emptyMsg").hidden = ships.length > 0;
    if (!ships.length) $("help").open = true;
    for (const s of ships) {
      const ts = toTs(s.last_seen);
      const stale = ts && Date.now() / 1000 - ts > STALE_H * 3600;
      const li = document.createElement("li");
      li.className = "ship" + (selected === s.mmsi ? " selected" : "");
      li.innerHTML = `
        <span class="bar" style="background:${s.color}"></span>
        <div class="ship-info">
          <div class="name">${esc(nameOf(s))}</div>
          ${s.label || s.name ? `<div class="sub">${[s.label && s.name ? esc(s.name) : null, `MMSI ${s.mmsi}`].filter(Boolean).join(" · ")}</div>` : ""}
          ${s.destination ? `<div class="sub">→ ${esc(s.destination)}</div>` : ""}
        </div>
        <div class="meta">
          ${s.sog != null && ts ? `<div class="spd">${fmt(s.sog)} kn</div>` : ""}
          <div>${ts ? `<span class="${stale ? "stale" : ""}">${ago(ts)}</span>` : `<span class="nosig">henüz konum yok</span>`}</div>
        </div>`;
      li.addEventListener("click", () => select(s.mmsi, true));
      ul.appendChild(li);
    }
  }

  function renderMap() {
    const days = Number($("range").value);
    const since = days ? Date.now() / 1000 - days * 86400 : 0;
    const keep = new Set(ships.map((s) => s.mmsi));
    for (const [m, layer] of [...markers, ...tracks]) {
      if (!keep.has(m)) { map.removeLayer(layer); markers.delete(m); tracks.delete(m); }
    }
    for (const s of ships) {
      const pts = rows.filter((r) => r.mmsi === s.mmsi && toTs(r.time_utc) >= since).map((r) => [Number(r.lat), Number(r.lon)]);
      if (tracks.has(s.mmsi)) tracks.get(s.mmsi).setLatLngs(pts).setStyle({ color: s.color });
      else tracks.set(s.mmsi, L.polyline(pts, { color: s.color, weight: 2.5, opacity: .75 }).addTo(map));

      if (s.lat == null) continue;
      const big = selected === s.mmsi;
      let mk = markers.get(s.mmsi);
      if (!mk) {
        mk = L.marker([s.lat, s.lon], { icon: icon(s, big), zIndexOffset: 1000 }).addTo(map);
        mk.on("click", () => select(s.mmsi, false));
        mk.bindTooltip("", { permanent: true, direction: "right", offset: [12, 0], className: "vessel-label" });
        markers.set(s.mmsi, mk);
      }
      mk.setLatLng([s.lat, s.lon]).setIcon(icon(s, big)).setTooltipContent(esc(nameOf(s)));
    }
  }

  function renderDetail() {
    const box = $("detail");
    const s = ships.find((x) => x.mmsi === selected);
    if (!s) { box.hidden = true; return; }
    const ts = toTs(s.last_seen);
    const n = rows.filter((r) => r.mmsi === s.mmsi).length;
    const kv = [
      ["MMSI", s.mmsi], ["IMO", s.imo], ["Çağrı işareti", s.callsign],
      ["Durum", NAV_STATUS[s.nav_status]],
      ["Hız", s.sog != null ? `${fmt(s.sog)} knot` : null],
      ["Rota", s.cog != null ? `${fmt(s.cog, 0)}°` : null],
      ["Varış yeri", s.destination], ["Tahmini varış", s.eta],
      ["Boyut", s.length ? `${s.length} × ${s.width ?? "?"} m` : null],
      ["Su çekimi", s.draught ? `${s.draught} m` : null],
      ["Konum", s.lat != null ? coord(s.lat, s.lon) : null],
      ["Son konum", ts ? `${localTime(ts)} (${ago(ts)})` : "henüz yok"],
      ["Kayıtlı konum", `${n} adet`],
    ].filter(([, v]) => v != null && v !== "");
    $("detailBody").innerHTML = `
      <h3>${esc(nameOf(s))}</h3>
      <div class="type">${esc(shipType(s.ship_type) || "Tip bilgisi bekleniyor")}</div>
      <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${ts && Date.now() / 1000 - ts > STALE_H * 3600 ? `<p class="ext">Son konum ${STALE_H} saatten eski: gemi kıyı alıcılarının menzili dışında olabilir.</p>` : ""}
      <div class="actions">
        <button class="btn" id="dlShip" ${n ? "" : "disabled"}>Konumlarını indir</button>
        <a class="btn" href="${editUrl(s.mmsi)}" target="_blank" rel="noopener">Etiketi değiştir</a>
        <a class="btn danger" href="${deleteUrl(s.mmsi)}" target="_blank" rel="noopener" title="GitHub'da dosyayı silip Commit changes deyin">Takipten çıkar</a>
      </div>
      <p class="ext">Karşılaştır:
        <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${esc(s.mmsi)}" target="_blank" rel="noopener">MarineTraffic</a> ·
        <a href="https://www.vesselfinder.com/vessels/details/${esc(s.mmsi)}" target="_blank" rel="noopener">VesselFinder</a></p>`;
    $("dlShip").addEventListener("click", () => downloadShip(s));
    box.hidden = false;
  }

  function downloadShip(s) {
    const cols = ["time_utc", "mmsi", "name", "label", "lat", "lon", "speed_kn", "course", "heading", "nav_status", "destination"];
    const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v ?? "");
    const lines = [cols.join(","), ...rows.filter((r) => r.mmsi === s.mmsi).map((r) => cols.map((c) => q(r[c])).join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
    a.download = `${(s.name || s.mmsi).replace(/[^\w-]+/g, "_")}_konumlar.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function select(mmsi, pan) {
    selected = mmsi;
    const s = ships.find((x) => x.mmsi === mmsi);
    if (pan && s?.lat != null) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 8));
    renderMap(); renderList(); renderDetail();
  }

  function fitAll() {
    const lls = ships.filter((s) => s.lat != null).map((s) => [s.lat, s.lon]);
    if (lls.length === 1) map.setView(lls[0], 9);
    else if (lls.length) map.fitBounds(lls, { padding: [60, 60], maxZoom: 10 });
  }

  // ---------------------------------------------------------------- data
  async function load() {
    const bust = `?t=${Date.now()}`;
    try {
      const [latest, csv] = await Promise.all([
        fetch(`data/latest.json${bust}`).then((r) => (r.ok ? r.json() : { ships: {} })),
        fetch(`data/positions.csv${bust}`).then((r) => (r.ok ? r.text() : "")),
      ]);
      rows = csv ? parseCsv(csv) : [];
      const order = latest.order || Object.keys(latest.ships || {});
      ships = order.map((m) => latest.ships[m]).filter(Boolean).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
      const upd = toTs(latest.updated);
      $("status").className = "status " + (upd && Date.now() / 1000 - upd < 3600 ? "live" : "connecting");
      $("statusText").textContent = upd ? `Son tarama: ${localTime(upd)} (${ago(upd)})` : "Henüz tarama yapılmadı";
      renderMap(); renderList(); renderDetail();
      if (firstLoad) { fitAll(); firstLoad = false; }
    } catch (err) {
      $("status").className = "status error";
      $("statusText").textContent = "Veri yüklenemedi: " + err.message;
    }
  }

  // ---------------------------------------------------------------- search
  const TR = { "İ": "I", "I": "I", "ı": "I", "Ş": "S", "ş": "S", "Ğ": "G", "ğ": "G", "Ü": "U", "ü": "U", "Ö": "O", "ö": "O", "Ç": "C", "ç": "C" };
  const norm = (s) => String(s || "").replace(/[İIıŞşĞğÜüÖöÇç]/g, (c) => TR[c]).toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  let directory = null;      // [[mmsi, name, type, imo, callsign], ...]
  let dirLoading = null;

  function loadDirectory() {
    if (!dirLoading) {
      dirLoading = fetch(`data/directory.json?t=${Math.floor(Date.now() / 1800000)}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
        .then((rows) => { directory = rows.map((r) => ({ r, key: norm(r[1]) })); return directory; });
    }
    return dirLoading;
  }

  function search(q) {
    const nq = norm(q);
    if (!nq) return [];
    const digits = /^\d+$/.test(nq);
    const tracked = new Set(ships.map((s) => s.mmsi));
    const hits = [];
    for (const { r, key } of directory) {
      let score = -1;
      if (digits) {
        if (r[0].startsWith(nq)) score = r[0] === nq ? 0 : 2;
        else if (r[3] && String(r[3]) === nq) score = 0;
      } else if (key === nq) score = 0;
      else if (key.startsWith(nq)) score = 1;
      else if (key.includes(nq)) score = 2;
      if (score >= 0) hits.push({ r, score: score - (tracked.has(r[0]) ? 0.5 : 0) });
    }
    hits.sort((a, b) => a.score - b.score || a.r[1].localeCompare(b.r[1]));
    return hits.slice(0, 30).map((h) => h.r);
  }

  function resultItem(mmsi, name, sub) {
    const tracked = ships.some((s) => s.mmsi === mmsi);
    const action = tracked
      ? `<span class="badge" data-show="${mmsi}">Takipte</span>`
      : `<a class="btn primary" href="${addUrl(mmsi, name)}" target="_blank" rel="noopener" data-add="${mmsi}">Takibe al</a>`;
    return `<li class="result"><div class="r-info"><div class="r-name">${esc(name)}</div><div class="r-sub">${esc(sub)}</div></div>${action}</li>`;
  }

  let searchTimer;
  async function runSearch() {
    const q = $("searchInput").value;
    const msg = $("searchMsg");
    const list = $("results");
    if (!norm(q)) { list.innerHTML = ""; msg.textContent = ""; return; }
    if (!directory) { msg.textContent = "Gemi rehberi yükleniyor…"; await loadDirectory(); }
    if (q !== $("searchInput").value) return; // user kept typing
    const hits = search(q);
    const nq = norm(q);
    let html = hits.map((r) => resultItem(r[0], r[1],
      [shipType(r[2]), `MMSI ${r[0]}`, r[3] ? `IMO ${r[3]}` : null, r[4]].filter(Boolean).join(" · "))).join("");
    if (/^\d{9}$/.test(nq) && !hits.some((r) => r[0] === nq)) {
      html = resultItem(nq, `MMSI ${nq}`, "Rehberde yok, MMSI ile ekle") + html;
    }
    list.innerHTML = html;
    if (hits.length) {
      msg.textContent = hits.length === 30 ? "İlk 30 sonuç gösteriliyor; aramayı daraltın." : "";
    } else if (!/^\d{9}$/.test(nq)) {
      msg.innerHTML = `Rehberde bulunamadı (${directory.length.toLocaleString("tr-TR")} gemi içinde). ` +
        `Rehber her 30 dakikada büyür. MMSI'yi <a href="https://www.vesselfinder.com/vessels?name=${encodeURIComponent(q.trim())}" target="_blank" rel="noopener">VesselFinder</a>'da bulup buraya yazabilirsiniz.`;
    } else msg.textContent = "";
  }

  $("searchInput").addEventListener("focus", loadDirectory, { once: true });
  $("searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
  $("results").addEventListener("click", (ev) => {
    const show = ev.target.closest("[data-show]");
    if (show) select(show.dataset.show, true);
    if (ev.target.closest("[data-add]")) {
      $("searchMsg").innerHTML = "GitHub'da açılan sayfada <strong>Commit changes</strong>'e basın. Gemi birkaç dakika içinde listeye gelir (sayfayı yenileyin).";
    }
  });

  $("range").addEventListener("change", renderMap);
  $("fitBtn").addEventListener("click", fitAll);
  $("detailClose").addEventListener("click", () => { selected = null; renderMap(); renderList(); renderDetail(); });
  load();
  setInterval(load, REFRESH_MS);
})();
