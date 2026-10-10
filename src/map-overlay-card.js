import L from "leaflet";
import leafletCss from "leaflet/dist/leaflet.css";

const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

const DEFAULTS = {
  latitude: null, // null = use the Home Assistant home location (hass.config)
  longitude: null,
  location: null, // { latitude, longitude } as written by the visual editor's location picker
  zoom: 10,
  height: 450,
  dark: false,
  tomtom_key: "",
  show_flow: true,
  show_incidents: true,
  flow_style: null, // auto: relative0 / relative0-dark
  incidents_style: null, // auto: s0 / s0-dark
  show_radar: true,
  radar_source: "nowcoast", // nowcoast | nexrad | rainviewer
  radar_smoothing: false,
  radar_hours: 3,
  radar_step_minutes: 10,
  radar_opacity: 0.6,
  frame_ms: 600,
  show_home_marker: true,
  home_entity: "zone.home",
  autoplay: true,
  full_height: true,
  traffic_refresh_minutes: 5,
  radar_refresh_minutes: 5,
  show_people: true,
  entities: null, // null = every person with GPS + every device_tracker with GPS not owned by a person
  show_zones: false,
  show_quakes: true,
  quake_min_magnitude: 2.5,
  quake_units: "imperial", // imperial (mi) | metric (km)
  quake_radius: null, // in quake_units; null = worldwide (measured from home)
  quake_radius_km: null, // legacy (0.3.0)
  people: null, // { "person.x": { name: "...", image: "<url>" | <media selector value> } }
  quake_refresh_minutes: 5,
  base_url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  base_attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  base_max_zoom: 19, // tile.openstreetmap.org serves z0-19 (z20 returns HTTP 400, checked 2026-10-10)
};

const FLOW_STYLES = ["absolute", "relative", "relative0", "relative0-dark", "relative-delay", "reduced-sensitivity"];
const INC_STYLES = ["s0", "s0-dark", "s1", "s2", "s3", "night"];
const NEXRAD_WMS = "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi";
const NOWCOAST_WMS = "https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows";
const NOWCOAST_LAYER = "conus_base_reflectivity_mosaic";
const NOWCOAST_CAPS = "https://nowcoast.noaa.gov/geoserver/observations/weather_radar/conus_base_reflectivity_mosaic/ows?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0";
// Hours of history each source actually serves (checked 2026-10-10): nowCOAST capabilities list ~8 h;
// IEM NEXRAD n0q-t serves archive (days), capped at 24 h here; RainViewer public API = 2 h (13 frames).
const SOURCE_MAX_HOURS = { nowcoast: 8, nexrad: 24, rainviewer: 2 };
const RV_API = "https://api.rainviewer.com/public/weather-maps.json";

function fail(msg) { throw new Error(`map-overlay-card: ${msg}`); }
function num(cfg, k, min, max) {
  const v = cfg[k];
  if (typeof v !== "number" || Number.isNaN(v)) fail(`'${k}' must be a number (got ${JSON.stringify(v)})`);
  if (v < min || v > max) fail(`'${k}' must be between ${min} and ${max} (got ${v})`);
}
function bool(cfg, k) { if (typeof cfg[k] !== "boolean") fail(`'${k}' must be true or false`); }

export function validateConfig(input) {
  if (!input || typeof input !== "object") fail("invalid configuration");
  const known = new Set([...Object.keys(DEFAULTS), "type", "view_layout", "grid_options", "visibility", "layout_options"]);
  for (const k of Object.keys(input)) if (!known.has(k)) fail(`unknown option '${k}'`);
  const c = { ...DEFAULTS, ...input };
  if (typeof c.height === "string" && /^\d+(px|vh)?$/.test(c.height)) c.height = c.height;
  else num(c, "height", 150, 3000);
  if (c.location != null) {
    if (typeof c.location !== "object") fail("'location' must have latitude and longitude");
    c.latitude = c.location.latitude; c.longitude = c.location.longitude;
  }
  if (c.latitude != null || c.longitude != null) { num(c, "latitude", -90, 90); num(c, "longitude", -180, 180); }
  num(c, "zoom", 1, 19);
  num(c, "quake_min_magnitude", -1, 10);
  if (!["imperial", "metric"].includes(c.quake_units)) fail("'quake_units' must be 'imperial' or 'metric'");
  if (c.quake_radius != null) num(c, "quake_radius", 1, 20040);
  if (c.quake_radius_km != null) num(c, "quake_radius_km", 1, 20040);
  if (c.people != null && (typeof c.people !== "object" || Array.isArray(c.people))) fail("'people' must map entity ids to { name, image }");
  num(c, "quake_refresh_minutes", 0, 1440);
  c.quake_refresh_minutes = Math.min(60, Math.max(1, c.quake_refresh_minutes)); // USGS feeds regenerate every 60 s
  num(c, "traffic_refresh_minutes", 1, 60); num(c, "radar_refresh_minutes", 2, 60);
  if (c.entities != null) {
    if (!Array.isArray(c.entities)) fail("'entities' must be a list of person/device_tracker entity ids");
    c.entities = c.entities.map((e) => (typeof e === "string" ? e : e?.entity));
    for (const e of c.entities) if (typeof e !== "string" || !/^(person|device_tracker)\./.test(e)) fail(`'entities': '${e}' is not a person or device_tracker entity`);
    if (!c.entities.length) c.entities = null;
  }
  num(c, "radar_hours", 0.5, 24); num(c, "radar_step_minutes", 2, 120);
  if (c.radar_source === "nexrad" && c.radar_step_minutes % 5) fail("'radar_step_minutes' must be a multiple of 5 for radar_source nexrad");
  num(c, "radar_opacity", 0, 1); num(c, "frame_ms", 100, 5000);
  for (const k of ["show_quakes", "full_height", "show_people", "show_zones", "radar_smoothing", "dark", "show_flow", "show_incidents", "show_radar", "show_home_marker", "autoplay"]) bool(c, k);
  if (typeof c.tomtom_key !== "string") fail("'tomtom_key' must be a string");
  if (!["nowcoast", "nexrad", "rainviewer"].includes(c.radar_source)) fail("'radar_source' must be 'nowcoast', 'nexrad' or 'rainviewer'");
  if (c.flow_style != null && !FLOW_STYLES.includes(c.flow_style)) fail(`'flow_style' must be one of ${FLOW_STYLES.join(", ")}`);
  if (c.incidents_style != null && !INC_STYLES.includes(c.incidents_style)) fail(`'incidents_style' must be one of ${INC_STYLES.join(", ")}`);
  if (typeof c.base_url !== "string" || !/^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(c.base_url)) fail("'base_url' must be an https tile URL containing {z}, {x} and {y}");
  if (typeof c.base_attribution !== "string") fail("'base_attribution' must be a string");
  num(c, "base_max_zoom", 1, 22);
  if (c.zoom > c.base_max_zoom) fail(`'zoom' must be at most ${c.base_max_zoom} (highest zoom the base map serves)`);
  if (c.home_entity && typeof c.home_entity !== "string") fail("'home_entity' must be an entity id");
  return c;
}

const CARD_CSS = `
:host { display:block; }
ha-card { overflow:hidden; position:relative; }
/* Own stacking context so Leaflet's z-indexes (400-1000) never rise above HA's edit-mode overlay. */
.wrap { position:relative; width:100%; isolation:isolate; z-index:0; }
/* Sections view: HA sizes the grid cell; fill it instead of using the px height. */
:host([layout=grid]) { height:100%; }
:host([layout=grid]) ha-card { height:100%; }
:host([layout=grid]) .wrap { height:100% !important; min-height:var(--moc-grid-h, 0px); }
/* Sections "Auto height": the cell has no fixed height, so use the configured height. */
:host([layout=grid]) .wrap.auto { height:var(--moc-h) !important; }
.map { position:absolute !important; top:0; left:0; width:100%; height:100%; touch-action:none; background:#ddd; }
.map.dark { background:#222; }
.map.dark .base-tiles { filter: invert(1) hue-rotate(180deg) brightness(.9) contrast(.9); }
.panel { position:absolute; z-index:1000; left:8px; bottom:22px; right:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;
  background:rgba(255,255,255,.88); color:#111; border-radius:10px; padding:6px 8px; font:13px/1.2 system-ui,sans-serif; box-shadow:0 1px 4px rgba(0,0,0,.3); }
.dark .panel, .panel.dark { background:rgba(30,30,30,.88); color:#eee; }
.panel button { font:inherit; border:1px solid #888; background:transparent; color:inherit; border-radius:6px; padding:3px 8px; cursor:pointer; }
.panel button.on { background:#2a7de1; color:#fff; border-color:#2a7de1; }
.panel label { display:flex; align-items:center; gap:4px; }
.panel input[type=range] { width:80px; }
.time { min-width:120px; font-weight:600; font-variant-numeric:tabular-nums; }
.note { position:absolute; z-index:1000; top:8px; left:50px; right:8px; background:rgba(255,235,160,.95); color:#222; padding:4px 8px;
  border-radius:6px; font:12px system-ui,sans-serif; }
.recenter { position:absolute; z-index:1000; top:80px; left:10px; width:34px; height:34px; border-radius:4px; border:2px solid rgba(0,0,0,.2);
  background:#fff; cursor:pointer; font-size:18px; line-height:28px; text-align:center; color:#333; padding:0; }
.radar-smooth { filter: blur(2px); }
/* People: pill = avatar (picture or initials) on the left, friendly name on the right. Fixed light colors: readable on light and dark maps. */
.person { width:auto !important; height:auto !important; margin:0 !important; background:none; border:0; }
.person .pill { position:absolute; left:-23px; top:-23px; }
.pill { display:flex; align-items:center; gap:8px; height:46px; box-sizing:border-box; padding:0 14px 0 1px; border-radius:23px; background:#fff; color:#222;
  border:2px solid var(--primary-color,#03a9f4); box-shadow:0 1px 5px rgba(0,0,0,.5); cursor:pointer; white-space:nowrap; }
.pill .av { flex:none; width:40px; height:40px; border-radius:50%; background:#e0e0e0; display:flex; align-items:center;
  justify-content:center; font:600 15px system-ui,sans-serif; color:#333; }
.pill .av { position:relative; overflow:hidden; }
.pill .av img { position:absolute; inset:0; width:40px; height:40px; object-fit:cover; border-radius:50%; image-rendering:auto; }
.pill .nm { font:600 15px/1 system-ui,sans-serif; max-width:170px; overflow:hidden; text-overflow:ellipsis; }
.people-group { width:auto !important; height:auto !important; background:none; border:0; }
.people-group .bubble { position:absolute; left:0; bottom:10px; transform:translateX(-50%); display:flex; flex-direction:column; gap:4px; padding:5px;
  background:#fff; border:1px solid rgba(0,0,0,.25); border-radius:27px; box-shadow:0 0 0 2px rgba(255,255,255,.55), 0 1px 6px rgba(0,0,0,.6); }
.people-group .bubble::after { content:""; position:absolute; left:50%; bottom:-8px; margin-left:-8px; border:8px solid transparent; border-bottom:0;
  border-top-color:#fff; }
.people-group .pill { box-shadow:none; }
.radarctl { display:contents; }
.quake span { display:flex; align-items:center; justify-content:center; width:100%; height:100%; border-radius:50%; box-sizing:border-box;
  border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 1px 4px rgba(0,0,0,.5); font-weight:700; font-family:system-ui,sans-serif; cursor:pointer; }
.qpop { font:13px/1.35 system-ui,sans-serif; color:#222; }
.qpop table { border-collapse:collapse; margin:4px 0; }
.qpop th { text-align:left; font-weight:600; padding:1px 8px 1px 0; color:#555; vertical-align:top; }
.qpop td { padding:1px 0; }
.sep { width:1px; align-self:stretch; background:#999; opacity:.5; }
`;

const LABELS = {
  tomtom_key: "TomTom API key", location: "Map center (empty = home)", zoom: "Zoom", height: "Map height (px)",
  full_height: "Full screen mode", radar_source: "Radar source", radar_hours: "Radar history (h)",
  radar_step_minutes: "Frame step (min)", radar_opacity: "Radar opacity",
  traffic_refresh_minutes: "Traffic refresh (min)", radar_refresh_minutes: "Radar refresh (min)",
  show_radar: "Radar", show_flow: "Traffic flow", show_incidents: "Traffic incidents", show_people: "People",
  entities: "People to show", show_zones: "Show zones",
  show_quakes: "Earthquakes", quake_min_magnitude: "Min magnitude", quake_radius: "Radius", quake_units: "Units", quake_refresh_minutes: "Quake refresh (min)",
  dark: "Dark map", radar_smoothing: "Smooth NEXRAD", autoplay: "Autoplay radar", show_home_marker: "Home marker",
};
const RADAR_NAMES = { nowcoast: "nowCOAST", nexrad: "NEXRAD", rainviewer: "RainViewer" };
const radarHelper = (src) => `${RADAR_NAMES[src]} max ${SOURCE_MAX_HOURS[src]} h (longer values are trimmed)`;
const HELPERS = {
  tomtom_key: "Optional. Enables traffic.",
  full_height: "In Layout, turn Auto height on.",
  entities: "Empty = everyone with GPS",
  show_zones: "Areas like Home or Work (see README)",
  quake_radius: "From home. Empty = worldwide",
  quake_min_magnitude: "Last 24 h, from USGS",
};

function initials(name) { return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""); }
function esc(t) { return String(t).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }

const USGS_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";
function distKm(a, b, c, d) {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
// Yellow (~2-3) -> amber (~4.5) -> red (6+), by magnitude.
function quakeColor(m) {
  const stops = [[2, [255, 214, 0]], [3, [255, 193, 7]], [4.5, [255, 143, 0]], [5.3, [244, 81, 30]], [6, [213, 0, 0]]];
  if (m <= stops[0][0]) return "rgb(255,214,0)";
  for (let i = 1; i < stops.length; i++) if (m <= stops[i][0]) {
    const [m0, c0] = stops[i - 1], [m1, c1] = stops[i], t = (m - m0) / (m1 - m0);
    return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(",")})`;
  }
  return "rgb(213,0,0)";
}
function quakeIcon(m) {
  const size = Math.round(Math.min(44, 26 + Math.max(0, m - 2) * 3));
  const fg = m >= 5 ? "#fff" : "#222";
  return L.divIcon({ className: "quake", iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
    html: `<span style="background:${quakeColor(m)};color:${fg};font-size:${size >= 34 ? 13 : 11}px">${m.toFixed(1)}</span>` });
}
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`;
}
const fmtLen = (km, metric) => (metric ? `${km < 10 ? km.toFixed(1) : Math.round(km)} km` : `${km / 1.609344 < 10 ? (km / 1.609344).toFixed(1) : Math.round(km / 1.609344)} mi`);
function quakePopup(f, dKm, metric) {
  const p = f.properties, g = f.geometry.coordinates;
  const row = (k, v) => (v === null || v === undefined || v === "" ? "" : `<tr><th>${k}</th><td>${esc(v)}</td></tr>`);
  const t = new Date(p.time);
  return `<div class="qpop"><b>M${p.mag.toFixed(1)} ${esc(p.magType || "")}</b><div>${esc(p.place || "Unknown location")}</div><table>
    ${row("Time", t.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}
    ${row("", ago(p.time))}
    ${row("From home", typeof dKm === "number" ? fmtLen(dKm, metric) : null)}
    ${row("Depth", typeof g[2] === "number" ? fmtLen(Math.max(0, g[2]), metric) : null)}
    ${row("Felt reports", p.felt)}
    ${row("MMI", typeof p.mmi === "number" ? p.mmi.toFixed(1) : null)}
    ${row("CDI", typeof p.cdi === "number" ? p.cdi.toFixed(1) : null)}
    ${row("PAGER alert", p.alert)}
    ${row("Tsunami", p.tsunami ? "Possible (see USGS / NOAA)" : "No")}
    ${row("Status", p.status)}
    ${row("Type", p.type)}
  </table>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">USGS event page</a>` : ""}</div>`;
}

class MapOverlayCard extends HTMLElement {
  static getStubConfig() { return { tomtom_key: "" }; }

  static getConfigElement() { return document.createElement("map-overlay-card-editor"); }

  static getConfigForm() {
    return {
      schema: [
        { name: "tomtom_key", selector: { text: { type: "password" } } },
        { name: "location", selector: { location: {} } },
        { type: "grid", name: "", schema: [
          { name: "zoom", selector: { number: { min: 1, max: 19, mode: "box" } } },
          { name: "height", selector: { number: { min: 150, max: 3000, step: 10, mode: "box" } } },
        ] },
        { name: "full_height", selector: { boolean: {} } },
        { name: "radar_source", selector: { select: { mode: "dropdown", options: [
          { value: "nowcoast", label: "NOAA nowCOAST (US)" },
          { value: "nexrad", label: "NEXRAD Iowa Mesonet (US)" },
          { value: "rainviewer", label: "RainViewer (worldwide)" },
        ] } } },
        { name: "radar_hours", selector: { number: { min: 0.5, max: 24, step: 0.5, mode: "box" } } },
        { name: "radar_step_minutes", selector: { number: { min: 2, max: 120, step: 1, mode: "box" } } },
        { name: "radar_opacity", selector: { number: { min: 0, max: 1, step: 0.05, mode: "slider" } } },
        { type: "grid", name: "", schema: [
          { name: "traffic_refresh_minutes", selector: { number: { min: 1, max: 60, mode: "box" } } },
          { name: "radar_refresh_minutes", selector: { number: { min: 2, max: 60, mode: "box" } } },
        ] },
        { type: "expandable", name: "", title: "Overlays on at start", schema: [
          { name: "show_radar", selector: { boolean: {} } },
          { name: "show_flow", selector: { boolean: {} } },
          { name: "show_incidents", selector: { boolean: {} } },
          { name: "show_people", selector: { boolean: {} } },
          { name: "show_quakes", selector: { boolean: {} } },
        ] },
        { type: "expandable", name: "", title: "Earthquakes", schema: [
          { name: "quake_min_magnitude", selector: { number: { min: -1, max: 9, step: 0.1, mode: "box" } } },
          { name: "quake_units", selector: { select: { mode: "dropdown", options: [{ value: "imperial", label: "Imperial (mi)" }, { value: "metric", label: "Metric (km)" }] } } },
          { name: "quake_radius", selector: { number: { min: 1, max: 20040, step: 1, mode: "box", unit_of_measurement: "mi" } } },
          { name: "quake_refresh_minutes", selector: { number: { min: 1, max: 60, step: 1, mode: "box" } } },
        ] },
        { type: "expandable", name: "", title: "People and zones", schema: [
          { name: "entities", selector: { entity: { multiple: true, filter: [{ domain: "person" }, { domain: "device_tracker" }] } } },
          { name: "show_zones", selector: { boolean: {} } },
        ] },
        { type: "expandable", name: "", title: "Display", schema: [
          { name: "dark", selector: { boolean: {} } },
          { name: "autoplay", selector: { boolean: {} } },
          { name: "show_home_marker", selector: { boolean: {} } },
          { name: "radar_smoothing", selector: { boolean: {} } },
        ] },
      ],
      computeLabel: (s) => LABELS[s.name],
      computeHelper: (s) => (s.name === "radar_hours" ? radarHelper(DEFAULTS.radar_source) : HELPERS[s.name]),
      assertConfig: (config) => {
        validateConfig(config);
        if (typeof config.height === "string") throw new Error("height as text (e.g. '90vh') is only editable in YAML");
        if (Array.isArray(config.entities) && config.entities.some((e) => typeof e !== "string")) throw new Error("entity options are only editable in YAML");
      },
    };
  }

  _center() {
    const c = this._config;
    if (typeof c.latitude === "number" && typeof c.longitude === "number") return [c.latitude, c.longitude];
    const hc = this._hass?.config;
    if (hc && typeof hc.latitude === "number" && typeof hc.longitude === "number") return [hc.latitude, hc.longitude];
    return null;
  }

  // Home location: zone.home, else HA config.
  _home_ll() {
    const z = this._hass?.states?.["zone.home"]?.attributes;
    if (z && typeof z.latitude === "number" && typeof z.longitude === "number") return [z.latitude, z.longitude];
    const hc = this._hass?.config;
    return hc && typeof hc.latitude === "number" ? [hc.latitude, hc.longitude] : null;
  }

  // Picture URL: per-entity override (URL or media selector value) or entity_picture. Relative URLs go through hass.hassUrl like HA's map.
  _picUrl(id, entityPic) {
    const ov = this._config.people?.[id]?.image;
    let u = "";
    if (typeof ov === "string" && ov) u = ov;
    else if (ov && typeof ov.media_content_id === "string" && !ov.media_content_id.startsWith("media-source://")) u = ov.media_content_id;
    else if (ov && typeof ov.media_content_id === "string") {
      const m = ov.media_content_id.match(/^media-source:\/\/image_upload\/([^/]+)/);
      if (m) u = `/api/image/serve/${m[1]}/512x512`;
      else u = this._resolveMedia(ov.media_content_id) || "";
    }
    if (!u) u = entityPic || "";
    // Never use a small thumbnail: HA image_upload serves 256x256 or 512x512; always take 512.
    u = u.replace(/(\/api\/image\/serve\/[^/]+\/)\d+x\d+/, "$1512x512");
    if (u && u.startsWith("/") && typeof this._hass?.hassUrl === "function") u = this._hass.hassUrl(u);
    return u;
  }

  // Other media sources (e.g. local media): resolve to a signed URL once, then re-render.
  _resolveMedia(mid) {
    this._media = this._media || new Map();
    if (this._media.has(mid)) return this._media.get(mid);
    this._media.set(mid, "");
    this._hass?.callWS?.({ type: "media_source/resolve_media", media_content_id: mid })
      .then((r) => { this._media.set(mid, r?.url || ""); this._peopleSig = null; this._updatePeople(); })
      .catch((e) => console.warn("map-overlay-card: could not resolve picture", mid, e));
    return "";
  }

  _updatePeople() {
    const c = this._config;
    if (!this._map || !this._hass || !this._peopleLayer) return;
    const st = this._hass.states || {};
    const ids = trackedIds(st, c.entities);
    const data = [];
    for (const id of ids) {
      const a = st[id]?.attributes || {};
      if (typeof a.latitude !== "number" || typeof a.longitude !== "number") continue;
      const ov = c.people?.[id] || {};
      data.push({ id, lat: a.latitude, lon: a.longitude, acc: a.gps_accuracy, pic: this._picUrl(id, a.entity_picture), name: (ov.name && String(ov.name).trim()) || a.friendly_name || id });
    }
    const sig = JSON.stringify(data);
    if (sig !== this._peopleSig) {
      this._peopleSig = sig; this._peopleData = data;
      // Accuracy circles: one per entity at its true position.
      for (const cir of this._circles.values()) this._peopleLayer.removeLayer(cir);
      this._circles.clear();
      for (const d of data) if (typeof d.acc === "number" && d.acc > 0)
        this._circles.set(d.id, L.circle([d.lat, d.lon], { radius: d.acc, color: "#03a9f4", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(this._peopleLayer));
      this._renderPeople();
    }
    // Zones
    if (c.show_zones) {
      for (const [id, s] of Object.entries(st)) {
        if (!id.startsWith("zone.")) continue;
        const a = s.attributes || {};
        if (typeof a.latitude !== "number" || typeof a.longitude !== "number" || this._zones.has(id)) continue;
        const z = L.circle([a.latitude, a.longitude], { radius: a.radius || 100, color: id === "zone.home" ? "#03a9f4" : "#ff9800", weight: 1,
          dashArray: a.passive ? "4 4" : null, fillOpacity: 0.1, interactive: false }).bindTooltip(a.friendly_name || id);
        z.addTo(this._peopleLayer); this._zones.set(id, z);
      }
    }
  }

  _pill(d) {
    // <img> over the initials; if the picture fails to load, it removes itself and the initials show.
    const av = `<span class="av">${esc(initials(d.name))}${d.pic ? `<img src="${esc(d.pic)}" alt="" draggable="false" width="40" height="40" decoding="async" onload="window.__mocSharpen && window.__mocSharpen(this)" onerror="console.warn('map-overlay-card: picture failed to load', this.src); this.remove()">` : ""}</span>`;
    return `<span class="pill" data-id="${esc(d.id)}" title="${esc(d.name)}">${av}<span class="nm">${esc(d.name)}</span></span>`;
  }

  // Group people whose markers would overlap at the current zoom into one callout
  // (avatars side by side, pointer at the group's position). Own implementation.
  _renderPeople() {
    if (!this._map || !this._peopleLayer || !this._peopleData) return;
    for (const m of this._markers) this._peopleLayer.removeLayer(m);
    this._markers = []; this._people = new Map();
    const pts = this._peopleData.map((d) => ({ d, p: this._map.latLngToLayerPoint([d.lat, d.lon]) }));
    const near = (a, b) => Math.abs(a.y - b.y) < PILL_H && Math.abs(a.x - b.x) < PILL_W;
    const groups = [];
    for (const it of pts) {
      const g = groups.find((gr) => gr.items.some((o) => near(o.p, it.p)));
      if (g) g.items.push(it); else groups.push({ items: [it] });
    }
    // Merge groups that became close after growing.
    for (let i = 0; i < groups.length; i++) for (let j = groups.length - 1; j > i; j--)
      if (groups[i].items.some((a) => groups[j].items.some((b) => near(a.p, b.p)))) { groups[i].items.push(...groups[j].items); groups.splice(j, 1); }
    const fire = (id) => this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: id }, bubbles: true, composed: true }));
    for (const g of groups) {
      const items = g.items.map((x) => x.d);
      const lat = items.reduce((t, d) => t + d.lat, 0) / items.length, lon = items.reduce((t, d) => t + d.lon, 0) / items.length;
      const icon = items.length === 1
        ? L.divIcon({ className: "person", iconSize: null, html: this._pill(items[0]) })
        : L.divIcon({ className: "people-group", iconSize: null, html: `<div class="bubble">${items.map((d) => this._pill(d)).join("")}</div>` });
      const m = L.marker([lat, lon], { icon, zIndexOffset: 1000 });
      m.on("click", (e) => { const t = e.originalEvent?.target?.closest?.("[data-id]"); fire(t ? t.dataset.id : items[0].id); });
      m.addTo(this._peopleLayer); this._markers.push(m);
      for (const d of items) this._people.set(d.id, { marker: m, group: items.length > 1 });
    }
  }

  _quakeFeed() {
    const m = this._config.quake_min_magnitude;
    const f = m >= 4.5 ? "4.5_day" : m >= 2.5 ? "2.5_day" : m >= 1 ? "1.0_day" : "all_day";
    return `${USGS_FEED}${f}.geojson`;
  }

  async _refreshQuakes() {
    const c = this._config;
    if (!this._map || !this._quakeLayer) return;
    let data;
    try { const r = await fetch(this._quakeFeed(), { cache: "no-store" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); data = await r.json(); }
    catch (e) { console.warn("map-overlay-card: earthquake feed failed", e); return; }
    if (!this._quakeLayer) return;
    const now = Date.now(), home = this._home_ll();
    const metric = c.quake_units === "metric";
    const radKm = c.quake_radius != null ? (metric ? c.quake_radius : c.quake_radius * 1.609344) : c.quake_radius_km;
    const keep = new Set();
    for (const f of data.features || []) {
      const p = f.properties || {}, g = f.geometry?.coordinates;
      if (!g || typeof p.mag !== "number" || p.mag < c.quake_min_magnitude || now - p.time > 86400000) continue;
      const dKm = home ? distKm(home[0], home[1], g[1], g[0]) : null;
      if (radKm && dKm != null && dKm > radKm) continue;
      keep.add(f.id);
      const sig = `${p.updated}`;
      const old = this._quakes.get(f.id);
      if (old && old.sig === sig) continue;
      if (old) this._quakeLayer.removeLayer(old.marker);
      const m = L.marker([g[1], g[0]], { icon: quakeIcon(p.mag), zIndexOffset: 500, title: `M${p.mag.toFixed(1)} ${p.place || ""}` })
        .bindPopup(() => quakePopup(f, dKm, metric), { maxWidth: 280 });
      m.addTo(this._quakeLayer); this._quakes.set(f.id, { marker: m, sig, mag: p.mag });
    }
    for (const [id, q] of this._quakes) if (!keep.has(id)) { this._quakeLayer.removeLayer(q.marker); this._quakes.delete(id); }
    this._quakeUpdated = new Date();
  }

  setConfig(config) {
    this._config = validateConfig(config);
    if (this._built) { this._teardown(); this._setup(); }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (this._built && !this._map) this._tryInit();
    this._updateHome();
    if (!prev || prev.states !== hass.states) this._updatePeople();
  }

  getCardSize() { const h = typeof this._config?.height === "number" ? this._config.height : 450; return Math.ceil(h / 50); }
  // Sections view sizing (developers.home-assistant.io custom-card docs). Users resize with HA's card size controls.
  getGridOptions() { return { columns: "full", rows: 8, min_columns: 6, min_rows: 4 }; }
  // Older HA (2024.3-2024.10) name for the same thing.
  getLayoutOptions() { return { grid_columns: 4, grid_rows: 8, grid_min_columns: 2, grid_min_rows: 4 }; }
  // HA's hui-card sets layout = "grid" when the card sits in a sections grid.
  set layout(v) { this._layout = v; this.toggleAttribute("layout", false); if (v) this.setAttribute("layout", v); if (v === "grid") this._applyGrid(); }
  get layout() { return this._layout; }

  connectedCallback() { if (this._config && !this._built) requestAnimationFrame(() => this._setup()); }
  disconnectedCallback() { this._teardown(); }

  _setup() {
    if (this._built || !this.isConnected || !this._config) return;
    this._built = true;
    const c = this._config;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const h = c.full_height ? "calc(100vh - var(--header-height, 56px) - 32px)" : typeof c.height === "number" ? `${c.height}px` : c.height;
    this.shadowRoot.innerHTML = `<style>${leafletCss}${CARD_CSS}</style>
      <ha-card><div class="wrap" style="height:${h};--moc-h:${h}"><div class="map ${c.dark ? "dark" : ""}"></div>
      <button class="recenter" title="Recenter"><svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align:middle"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg></button><div class="panel ${c.dark ? "dark" : ""}"></div></div></ha-card>`;
    const root = this.shadowRoot;
    const mapEl = root.querySelector(".map");
    const wrap = root.querySelector(".wrap");
    // Keep gestures on the map from reaching the dashboard (view swipe / scroll).
    for (const ev of ["touchstart", "touchmove", "pointerdown", "wheel", "mousedown"]) wrap.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });

    this._pendingInit = () => this._initMap(root, mapEl, wrap);
    this._wrap = wrap;
    this._ro = new ResizeObserver(() => {
      if (!this._map) { this._tryInit(); return; }
      this._map.invalidateSize();
    });
    this._ro.observe(wrap);
    this._ro.observe(mapEl);
  }

  // Sections grid: rows from grid_options (default 8). "auto" = Auto height -> use height/full screen.
  // Otherwise keep at least the grid height (HA: 56px rows, 8px gaps), e.g. while the edit overlay re-wraps the card.
  _applyGrid() {
    const w = this._wrap; if (!w || !this._config) return;
    const rows = this._config.grid_options?.rows ?? 8;
    w.classList.toggle("auto", rows === "auto");
    w.style.setProperty("--moc-grid-h", typeof rows === "number" ? `calc(${rows} * var(--row-height, 56px) + ${rows - 1} * var(--row-gap, 8px))` : "0px");
  }

  _tryInit() {
    const w = this._wrap;
    if (w && this._layout === "grid") this._applyGrid();
    // Wait until the card is laid out and we know where to center (config or hass.config).
    if (this._pendingInit && w && w.clientHeight > 0 && w.clientWidth > 0 && this._center()) this._pendingInit();
  }

  _initMap(root, mapEl, wrap) {
    if (this._map) return;
    const c = this._config;
    const center = this._center();
    const map = (this._map = L.map(mapEl, { zoomControl: true, attributionControl: true, maxZoom: c.base_max_zoom, minZoom: 1 }).setView(center, Math.min(c.zoom, c.base_max_zoom)));
    this._people = new Map(); this._zones = new Map(); this._circles = new Map(); this._markers = []; this._peopleSig = null; this._peopleData = null;
    this._peopleLayer = L.layerGroup();
    map.on("zoomend", () => this._renderPeople());
    // Earthquakes: separate layer, never part of people grouping.
    this._quakeLayer = L.layerGroup(); this._quakes = new Map();
    if (c.show_quakes) this._quakeLayer.addTo(map);
    if (c.show_people) this._peopleLayer.addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    L.tileLayer(c.base_url, {
      maxZoom: c.base_max_zoom, className: "base-tiles",
      referrerPolicy: "strict-origin-when-cross-origin", // OSM tile policy requires a Referer
      attribution: c.base_attribution,
    }).addTo(map);

    // Traffic
    this._flow = this._inc = null;
    if (c.tomtom_key) {
      const k = encodeURIComponent(c.tomtom_key);
      const fs = c.flow_style || (c.dark ? "relative0-dark" : "relative0");
      const is = c.incidents_style || (c.dark ? "s0-dark" : "s0");
      const ttAttr = '&copy; <a href="https://www.tomtom.com">TomTom</a> traffic';
      this._flowUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/${fs}/{z}/{x}/{y}.png?key=${k}&tileSize=256`;
      this._incUrl = `https://api.tomtom.com/traffic/map/4/tile/incidents/${is}/{z}/{x}/{y}.png?key=${k}&t=-1`;
      this._flow = L.tileLayer(this._flowUrl, { maxZoom: 22, zIndex: 300, attribution: ttAttr });
      this._inc = L.tileLayer(this._incUrl, { maxZoom: 22, zIndex: 310, attribution: ttAttr });
      // Re-fetch traffic tiles periodically (cache-busting query parameter).
      this._trafficTimer = setInterval(() => {
        const ts = `&_ts=${Date.now()}`;
        this._flow.setUrl(this._flowUrl + ts); this._inc.setUrl(this._incUrl + ts);
        this._trafficRefreshes = (this._trafficRefreshes || 0) + 1;
        this._lastUpdate = new Date(); if (!this._radarOn) this._show(this._idx);
      }, c.traffic_refresh_minutes * 60000);
      if (c.show_flow) this._flow.addTo(map);
      if (c.show_incidents) this._inc.addTo(map);
    } else {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = "Traffic layers hidden: add your free TomTom API key in the card settings (tomtom_key).";
      wrap.appendChild(n);
    }

    // Radar
    this._radarOn = c.show_radar;
    this._opacity = c.radar_opacity;
    this._frameMs = c.frame_ms;
    this._playing = c.autoplay;
    this._frames = []; // {time: Date, layer}
    this._idx = 0;
    this._lastUpdate = new Date();
    this._buildPanel(root.querySelector(".panel"));
    this._show(this._idx);
    root.querySelector(".recenter").addEventListener("click", () => map.setView(this._center() || center, c.zoom));

    this._refreshFrames();
    this._refreshTimer = setInterval(() => this._refreshFrames(), c.radar_refresh_minutes * 60000);
    this._updateHome();
    this._updatePeople();
    this._refreshQuakes();
    this._quakeTimer = setInterval(() => this._refreshQuakes(), c.quake_refresh_minutes * 60000);
    this._restartAnim();
  }

  _teardown() {
    clearInterval(this._refreshTimer); clearInterval(this._animTimer); clearInterval(this._trafficTimer);
    clearInterval(this._quakeTimer); this._quakeTimer = null; this._quakeLayer = null; this._quakes = new Map();
    this._refreshTimer = this._animTimer = this._trafficTimer = null;
    this._people = new Map(); this._zones = new Map(); this._circles = new Map(); this._markers = []; this._peopleLayer = null; this._peopleSig = null;
    this._ro?.disconnect(); this._ro = null;
    if (this._map) { this._map.remove(); this._map = null; }
    this._frames = []; this._home = null; this._built = false; this._pendingInit = null;
  }

  _buildPanel(p) {
    const c = this._config;
    const btn = (label, on, fn, title) => { const b = document.createElement("button"); b.textContent = label; b.title = title || label; b.classList.toggle("on", on); b.addEventListener("click", () => b.classList.toggle("on", fn())); p.appendChild(b); return b; };
    // Radar-only controls live in one group that hides when radar is off.
    const host = p; const grp = document.createElement("span"); grp.className = "radarctl"; p.appendChild(grp); p = grp;
    this._radarCtl = grp;
    this._playBtn = btn(this._playing ? "❚❚" : "▶", false, () => { this._playing = !this._playing; this._playBtn.textContent = this._playing ? "❚❚" : "▶"; this._restartAnim(); return false; }, "Play/pause radar");
    this._timeEl = document.createElement("span"); this._timeEl.className = "time"; this._timeEl.textContent = "Radar loading…"; p.appendChild(this._timeEl);
    const speed = document.createElement("label"); speed.innerHTML = `Speed <select><option value="1200">0.5×</option><option value="600">1×</option><option value="300">2×</option><option value="150">4×</option></select>`;
    const sel = speed.querySelector("select"); sel.value = String(this._frameMs); if (!sel.value) { const o = new Option(`${this._frameMs}ms`, this._frameMs); sel.add(o); sel.value = String(this._frameMs); }
    sel.addEventListener("change", () => { this._frameMs = Number(sel.value); this._restartAnim(); }); p.appendChild(speed);
    const op = document.createElement("label"); op.innerHTML = `Opacity <input type="range" min="0" max="1" step="0.05">`;
    const r = op.querySelector("input"); r.value = String(this._opacity); r.addEventListener("input", () => { this._opacity = Number(r.value); this._show(this._idx); }); p.appendChild(op);
    p = host;
    this._timeEl.remove(); p.insertBefore(this._timeEl, grp);
    const s = document.createElement("span"); s.className = "sep"; p.appendChild(s);
    btn("Radar", this._radarOn, () => { this._radarOn = !this._radarOn; this._show(this._idx); return this._radarOn; });
    if (this._flow) btn("Flow", c.show_flow, () => this._toggle(this._flow), "TomTom traffic flow");
    if (this._inc) btn("Incidents", c.show_incidents, () => this._toggle(this._inc), "TomTom traffic incidents");
    btn("People", c.show_people, () => this._toggle(this._peopleLayer), "People and zones");
    btn("Quakes", c.show_quakes, () => this._toggle(this._quakeLayer), "Earthquakes (USGS, last 24 h)");
  }

  _toggle(layer) { if (this._map.hasLayer(layer)) { this._map.removeLayer(layer); return false; } layer.addTo(this._map); return true; }

  async _frameTimes() {
    const c = this._config;
    if (c.radar_source === "rainviewer") {
      const r = await fetch(RV_API, { cache: "no-store" });
      if (!r.ok) throw new Error(`RainViewer HTTP ${r.status}`);
      const d = await r.json();
      return (d.radar?.past || []).map((f) => ({ key: f.path, time: new Date(f.time * 1000), url: `${d.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
    }
    if (c.radar_source === "nowcoast") {
      const r = await fetch(NOWCOAST_CAPS, { cache: "no-store" });
      if (!r.ok) throw new Error(`nowCOAST HTTP ${r.status}`);
      const xml = new DOMParser().parseFromString(await r.text(), "text/xml");
      let dim = null;
      for (const layer of xml.getElementsByTagName("Layer")) {
        const name = [...layer.children].find((e) => e.localName === "Name")?.textContent;
        if (name === NOWCOAST_LAYER || name?.endsWith(":" + NOWCOAST_LAYER)) {
          dim = [...layer.children].find((e) => e.localName === "Dimension" && e.getAttribute("name") === "time");
          if (dim) break;
        }
      }
      if (!dim) dim = [...xml.getElementsByTagName("Dimension")].find((e) => e.getAttribute("name") === "time");
      if (!dim) throw new Error("nowCOAST: no time dimension in capabilities");
      const avail = dim.textContent.trim().split(",").map((t) => new Date(t.trim())).filter((d) => !Number.isNaN(+d)).sort((a, b) => a - b);
      if (!avail.length) throw new Error("nowCOAST: empty time list");
      const latest = +avail[avail.length - 1];
      const step = c.radar_step_minutes * 60000;
      const n = Math.max(2, Math.floor((this._hours() * 3600000) / step) + 1);
      const picked = [];
      for (let i = n - 1; i >= 0; i--) {
        const target = latest - i * step;
        if (target < +avail[0] - step / 2) continue;
        let best = avail[0];
        for (const a of avail) if (Math.abs(a - target) < Math.abs(best - target)) best = a;
        if (!picked.length || +picked[picked.length - 1] !== +best) picked.push(best);
      }
      return picked.map((t) => ({ key: t.toISOString(), time: t }));
    }
    // NEXRAD (Iowa Environmental Mesonet): 5-minute composites, ~5-10 min latency.
    const step = c.radar_step_minutes * 60000;
    const latest = Math.floor((Date.now() - 10 * 60000) / 300000) * 300000;
    const n = Math.max(2, Math.floor((this._hours() * 3600000) / step) + 1);
    const out = [];
    for (let i = n - 1; i >= 0; i--) { const t = new Date(latest - i * step); out.push({ key: t.toISOString(), time: t }); }
    return out;
  }

  _hours() { return Math.min(this._config.radar_hours, SOURCE_MAX_HOURS[this._config.radar_source] || 24); }

  _makeLayer(f) {
    if (this._config.radar_source === "rainviewer") {
      return L.tileLayer(f.url, { opacity: 0, zIndex: 400, maxNativeZoom: 7, maxZoom: 19, attribution: 'Weather data by <a href="https://www.rainviewer.com">RainViewer</a>' });
    }
    if (this._config.radar_source === "nowcoast") {
      return L.tileLayer.wms(NOWCOAST_WMS, {
        layers: NOWCOAST_LAYER, format: "image/png", transparent: true, version: "1.1.1", tileSize: 512,
        time: f.key.replace(/\.\d{3}Z$/, "Z"), opacity: 0, zIndex: 400,
        attribution: 'Radar: <a href="https://nowcoast.noaa.gov/">NOAA nowCOAST</a>',
      });
    }
    return L.tileLayer.wms(NEXRAD_WMS, {
      className: this._config.radar_smoothing ? "radar-smooth" : "",
      layers: "nexrad-n0q-wmst", format: "image/png", transparent: true, version: "1.1.1", tileSize: 512, zoomOffset: 0,
      time: f.key.replace(/\.\d{3}Z$/, "Z"), opacity: 0, zIndex: 400,
      attribution: 'NEXRAD radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>',
    });
  }

  async _refreshFrames() {
    if (!this._map) return;
    let list;
    try { list = await this._frameTimes(); } catch (e) { console.warn("map-overlay-card: radar frame list failed", e); if (this._timeEl) this._timeEl.textContent = "Radar unavailable"; return; }
    if (!this._map) return;
    const old = new Map(this._frames.map((f) => [f.key, f]));
    const next = list.map((f) => old.get(f.key) || { ...f, layer: this._makeLayer(f) });
    for (const f of this._frames) if (!next.includes(f)) this._map.removeLayer(f.layer);
    for (const f of next) if (!this._map.hasLayer(f.layer)) f.layer.addTo(this._map); // preload (opacity 0)
    this._frames = next;
    this._idx = Math.min(this._idx, next.length - 1);
    if (!this._playing) this._idx = next.length - 1;
    this._show(this._idx);
  }

  _show(i) {
    if (this._radarCtl) this._radarCtl.style.display = this._radarOn ? "" : "none";
    if (!this._radarOn && this._timeEl) {
      // Radar off: show when the map/traffic was last updated instead of a radar frame time.
      this._timeEl.textContent = "Updated " + (this._lastUpdate || new Date()).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    }
    if (!this._frames.length) return;
    this._idx = i;
    this._frames.forEach((f, j) => f.layer.setOpacity(this._radarOn && j === i ? this._opacity : 0));
    const f = this._frames[i];
    if (this._timeEl && this._radarOn) this._timeEl.textContent = f.time.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + (i === this._frames.length - 1 ? " (latest)" : "");
  }

  _restartAnim() {
    clearInterval(this._animTimer); this._animTimer = null;
    if (!this._map) return;
    if (this._playing) {
      this._animTimer = setInterval(() => {
        if (!this._frames.length) return;
        // hold a little longer on the latest frame
        const last = this._frames.length - 1;
        if (this._idx === last && !this._hold) { this._hold = true; return; }
        this._hold = false;
        this._show(this._idx >= last ? 0 : this._idx + 1);
      }, this._frameMs);
    } else if (this._frames.length) this._show(this._frames.length - 1);
  }

  _updateHome() {
    const c = this._config;
    if (!this._map || !c?.show_home_marker || !this._hass || !c.home_entity) return;
    const s = this._hass.states?.[c.home_entity];
    const lat = s?.attributes?.latitude, lon = s?.attributes?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return;
    if (!this._home) this._home = L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#2a7de1", fillOpacity: 1, zIndex: 900 }).bindTooltip(s.attributes.friendly_name || "Home").addTo(this._map);
    else this._home.setLatLng([lat, lon]);
  }
}

// Visual editor: HA's ha-form, but shown with the effective defaults filled in.
// Only keys the user actually changes (or already had) are written back, so the
// saved config stays minimal and never gains home coordinates unless the pin is set.
const FORM_DEFAULT_KEYS = ["zoom", "height", "radar_source", "radar_hours", "radar_step_minutes", "radar_opacity",
  "traffic_refresh_minutes", "radar_refresh_minutes", "show_radar", "show_flow", "show_incidents", "show_people",
  "show_zones", "show_quakes", "quake_min_magnitude", "quake_refresh_minutes", "quake_units", "full_height", "dark", "autoplay", "show_home_marker", "radar_smoothing"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function formData(config) {
  const d = {};
  for (const k of FORM_DEFAULT_KEYS) d[k] = DEFAULTS[k];
  d.tomtom_key = "";
  const out = { ...d, ...config };
  // YAML latitude/longitude: show them on the pin instead of the home location.
  if (!config.location && typeof config.latitude === "number" && typeof config.longitude === "number") out.location = { latitude: config.latitude, longitude: config.longitude };
  return out;
}
function formToConfig(orig, data) {
  const out = { ...orig };
  for (const [k, v] of Object.entries(data)) {
    const had = Object.prototype.hasOwnProperty.call(orig, k);
    const empty = v === undefined || v === null || (Array.isArray(v) && !v.length) || (k === "location" && !(v && typeof v.latitude === "number"));
    if (empty) { if (had && k !== "tomtom_key") delete out[k]; continue; }
    if (k === "location" && !had && v.latitude === orig.latitude && v.longitude === orig.longitude) continue; // pin not moved
    if (k === "location" && !had && "latitude" in orig) { delete out.latitude; delete out.longitude; } // moved: location replaces flat coords
    if (!had && k in DEFAULTS && same(v, DEFAULTS[k])) continue; // unchanged default: keep YAML minimal
    if (!had && k === "tomtom_key" && v === "") continue;
    out[k] = v;
  }
  for (const k of Object.keys(out)) if (!(k in data) && FORM_DEFAULT_KEYS.includes(k) && out[k] === undefined) delete out[k];
  return out;
}
class MapOverlayCardEditor extends HTMLElement {
  setConfig(config) {
    MapOverlayCard.getConfigForm().assertConfig(config); // throwing switches HA to the YAML editor
    this._config = config; this._render();
  }
  set hass(h) { this._hass = h; if (this._form) this._form.hass = h; else this._render(); }
  _render() {
    if (!this._config || !this._hass) return;
    const f = MapOverlayCard.getConfigForm();
    // Radar history max follows the selected source.
    const src = this._config.radar_source || DEFAULTS.radar_source;
    const fix = (sch) => sch.map((x) => (x.schema ? { ...x, schema: fix(x.schema) } : x.name === "radar_hours" ? { ...x, selector: { number: { ...x.selector.number, max: SOURCE_MAX_HOURS[src] } } } : x));
    f.schema = fix(f.schema);
    // Radius unit follows quake_units.
    const unit = (this._config.quake_units || DEFAULTS.quake_units) === "metric" ? "km" : "mi";
    const fixU = (sch) => sch.map((x) => (x.schema ? { ...x, schema: fixU(x.schema) } : x.name === "quake_radius" ? { ...x, selector: { number: { ...x.selector.number, unit_of_measurement: unit } } } : x));
    f.schema = fixU(f.schema);
    // Per-person overrides: optional name and picture (HA media selector with image upload -> image_upload integration).
    const st = this._hass.states || {};
    const ids = trackedIds(st, (this._config.entities || []).map((e) => (typeof e === "string" ? e : e.entity)));
    const fname = (id) => st[id]?.attributes?.friendly_name || id;
    if (ids.length) f.schema.push({ type: "expandable", name: "", title: "Names", schema: ids.map((id) => ({ name: `pname:${id}`, selector: { text: {} } })) });
    // Loader: a media selector makes HA load ha-picture-upload (used below for cropped pictures) if it isn't loaded yet.
    if (!customElements.get("ha-picture-upload")) f.schema.push({ name: "_loader", selector: { media: { image_upload: true } } });
    this._picIds = ids; this._fname = fname;
    const lab = f.computeLabel;
    const labelFn = (x) => (x.name?.startsWith("pname:") ? `${fname(x.name.slice(6))}: name` : x.name?.startsWith("pimg:") ? `${fname(x.name.slice(5))}: picture` : lab(x));
    const baseHelper = f.computeHelper;
    f.computeHelper = (x) => (x.name === "radar_hours" ? radarHelper(src) : baseHelper(x));
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const v = { ...ev.detail.value }; delete v._loader;
        const people = JSON.parse(JSON.stringify(this._config.people || {}));
        for (const k of Object.keys(v)) {
          const m = k.match(/^pname:(.+)$/); if (!m) continue;
          // Keep the text exactly as typed (spaces included) so typing isn't disturbed; the card trims
          // leading/trailing spaces when it uses the name. Blank -> override removed.
          const raw = typeof v[k] === "string" ? v[k] : ""; delete v[k];
          (this._nameDraft = this._nameDraft || {})[m[1]] = raw;
          if (raw.trim()) (people[m[1]] = people[m[1]] || {}).name = raw; else if (people[m[1]]) delete people[m[1]].name;
        }
        for (const id of Object.keys(people)) if (!Object.keys(people[id]).length) delete people[id];
        v.people = Object.keys(people).length ? people : undefined;
        const cfg = formToConfig(this._config, v);
        // Keep the user's own radar_hours; the form only shows it trimmed to the source cap.
        const prev = this._config.radar_hours;
        if (typeof prev === "number" && ev.detail.value.radar_hours === this._shownHours && prev > this._shownHours) cfg.radar_hours = prev;
        this._config = cfg; this._render();
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.schema = f.schema; this._form.computeLabel = labelFn;
    this._form.computeHelper = (x) => (x.name?.startsWith("pname:") ? "Empty = entity name" : x.name === "_loader" ? "" : f.computeHelper(x));
    this._form.hass = this._hass;
    const data = formData(this._config);
    data.radar_hours = this._shownHours = Math.min(data.radar_hours, SOURCE_MAX_HOURS[src]);
    delete data.people;
    for (const id of ids) data[`pname:${id}`] = this._nameDraft?.[id] ?? this._config.people?.[id]?.name ?? "";
    this._renderPics();
    this._form.data = data;
  }
}
// Pill size used for overlap grouping (pill 46px tall; avatar 40 + name up to 170px + padding).
const PILL_H = 50, PILL_W = 220;
// Sharp avatars: browsers shrink a 512px photo to 40px in one step, which aliases/blurs. Pre-scale once per
// image to exactly 40 x devicePixelRatio with stepwise halving + high-quality smoothing, cover-cropped square.
const AV = 40, _sharp = new Map();
window.__mocSharpen = (img) => {
  if (img.dataset.sharp || !img.naturalWidth) return;
  const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1)), px = Math.round(AV * dpr), key = img.src + "@" + px;
  const done = (url) => { img.dataset.sharp = "1"; if (url) img.src = url; };
  if (_sharp.has(key)) return done(_sharp.get(key));
  try {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (side <= px) return done(null); // already small: nothing to gain
    let c = document.createElement("canvas"); c.width = c.height = side;
    let x = c.getContext("2d"); x.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, side, side);
    let cur = side;
    while (cur / 2 >= px) { const n = document.createElement("canvas"); n.width = n.height = Math.round(cur / 2);
      const nx = n.getContext("2d"); nx.imageSmoothingQuality = "high"; nx.drawImage(c, 0, 0, n.width, n.height); c = n; cur = n.width; }
    const f = document.createElement("canvas"); f.width = f.height = px; const fx = f.getContext("2d"); fx.imageSmoothingQuality = "high";
    fx.drawImage(c, 0, 0, px, px);
    const url = f.toDataURL("image/png"); _sharp.set(key, url); done(url);
  } catch (e) { done(null); } // cross-origin image without CORS: keep the original
};

// Which entities get a marker. Default (no list): every person.* plus every device_tracker.* with GPS that no
// person lists in its device_trackers attribute. With a list: those entities, plus the people who own listed trackers
// (the tracker is shown through its person, with the person's name and picture). Trackers owned by a shown person are hidden.
function trackedIds(st, list) {
  const gps = (id) => typeof st[id]?.attributes?.latitude === "number" && typeof st[id]?.attributes?.longitude === "number";
  const owner = {};
  for (const id of Object.keys(st)) if (id.startsWith("person.")) for (const t of st[id].attributes?.device_trackers || []) owner[t] ??= id;
  let ids = list && list.length ? [...list] : Object.keys(st).filter((id) => id.startsWith("person.") || (id.startsWith("device_tracker.") && gps(id)));
  for (const id of [...ids]) if (owner[id] && !ids.includes(owner[id])) ids.splice(ids.indexOf(id), 0, owner[id]);
  ids = [...new Set(ids)];
  return ids.filter((id) => !(owner[id] && ids.includes(owner[id])));
}

// Per-person pictures: HA's own ha-picture-upload with the same square/round crop settings as Settings > People
// (dialog-person-detail: crop, select-media, cropOptions { round: true, quality: 0.75, aspectRatio: 1 }).
// It uploads to the image_upload integration and returns /api/image/serve/<id>/512x512.
const PERSON_CROP = { round: true, quality: 0.75, aspectRatio: 1 };
MapOverlayCardEditor.prototype._renderPics = function () {
  const ids = this._picIds || [];
  if (!this._pics) { this._pics = document.createElement("div"); this._pics.className = "moc-pics"; this.appendChild(this._pics); }
  if (!ids.length) { this._pics.replaceChildren(); return; }
  if (!customElements.get("ha-picture-upload")) {
    if (!this._waitPic) { this._waitPic = true; customElements.whenDefined("ha-picture-upload").then(() => this._render()); }
    this._pics.textContent = "";
    return;
  }
  const key = ids.join("|");
  if (this._picsKey !== key) {
    this._picsKey = key; this._pics.replaceChildren();
    const h = document.createElement("div"); h.textContent = "Pictures"; h.style.cssText = "font-weight:500;margin:16px 0 4px"; this._pics.appendChild(h);
    for (const id of ids) {
      const row = document.createElement("div"); row.style.cssText = "margin:8px 0";
      const lab = document.createElement("div"); lab.textContent = `${this._fname(id)}: picture (empty = entity picture)`; lab.style.cssText = "font-size:14px;margin-bottom:4px";
      const up = document.createElement("ha-picture-upload");
      up.hass = this._hass; up.crop = true; up.selectMedia = true; up.cropOptions = PERSON_CROP; up.dataset.id = id;
      up.addEventListener("change", () => {
        const people = JSON.parse(JSON.stringify(this._config.people || {}));
        if (up.value) (people[id] = people[id] || {}).image = up.value;
        else if (people[id]) { delete people[id].image; if (!Object.keys(people[id]).length) delete people[id]; }
        const cfg = { ...this._config }; if (Object.keys(people).length) cfg.people = people; else delete cfg.people;
        this._config = cfg;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
      });
      row.append(lab, up); this._pics.appendChild(row);
    }
  }
  for (const up of this._pics.querySelectorAll("ha-picture-upload")) {
    up.hass = this._hass;
    const img = this._config.people?.[up.dataset.id]?.image;
    up.value = typeof img === "string" ? img : null;
  }
};
if (!customElements.get("map-overlay-card-editor")) customElements.define("map-overlay-card-editor", MapOverlayCardEditor);

if (!customElements.get("map-overlay-card")) customElements.define("map-overlay-card", MapOverlayCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "map-overlay-card"))
  window.customCards.push({
    type: "map-overlay-card",
    name: "Map Overlay Card",
    description: "One map with live traffic (TomTom), an animated weather radar loop and people.",
    preview: true,
    documentationURL: "https://github.com/codemonkey2k5/map-overlay-card",
  });
console.info(`%c MAP-OVERLAY-CARD %c v${VERSION} `, "background:#2a7de1;color:#fff", "");
