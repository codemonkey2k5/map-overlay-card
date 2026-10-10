// Headless tests in the HA-like harness. Usage: node test/run-test.mjs [keyfile]
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyFile = process.argv[2];
const KEY = keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
const types = { ".html": "text/html", ".js": "text/javascript" };
const srv = createServer(async (req, res) => {
  try { const b = await readFile(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname))); res.writeHead(200, { "content-type": types[extname(req.url.split("?")[0])] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}/test/harness-ha.html`;
const exe = process.env.CHROME || undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const results = []; const ok = (name, pass, info = "") => { results.push({ name, pass, info }); console.log(pass ? "PASS" : "FAIL", name, info); };
const usgsHits = [];
let extraQuakes = [];
const q = (id, mag, dLat, dLon, hoursAgo, extra = {}) => ({ type: "Feature", id, geometry: { type: "Point", coordinates: [-113.584 + dLon, 37.104 + dLat, 8.2] },
  properties: { mag, place: `Test place ${id}`, time: Date.now() - hoursAgo * 3600000, updated: 1, magType: "ml", type: "earthquake", status: "reviewed", url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, felt: 12, mmi: 4.1, cdi: 3.4, alert: "green", tsunami: 0, ...extra } });
const usgsFeed = () => ({ type: "FeatureCollection", features: [q("a12", 1.2, 0.1, 0.1, 1), q("b27", 2.7, 0.2, 0, 2), q("c46", 4.6, -0.2, 0.2, 3), q("d63", 6.3, 0.3, -0.3, 5, { tsunami: 1, alert: "orange" }), q("old", 5.0, 0, 0.1, 30), q("far", 5.5, 30, 30, 1), ...extraQuakes] });
const haReq = [];
async function open(params, init, dpr = 1) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 }, deviceScaleFactor: dpr });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const reqs = []; page.on("request", (r) => reqs.push(r.url()));
  if (init) await page.addInitScript(init);
  // Fake USGS feed (fixed test data, no network).
  await page.route("**/earthquake.usgs.gov/**", (route) => { usgsHits.push(route.request().url()); route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(usgsFeed()) }); });
  await page.route("https://ha.example/**", (route) => { haReq.push(route.request().url()); if (route.request().url().endsWith("/local/x.png")) return route.fulfill({ status: 404, body: "" });
    if (route.request().url().includes("/api/image/serve/big")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: readFileSync(new URL("./big512.svg", import.meta.url)) }); route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") }); });
  await page.goto(`${base}?${new URLSearchParams(params)}`);
  await page.waitForFunction(() => window.__card?._map, null, { timeout: 15000 }).catch(() => {});
  return { page, reqs };
}
const timerSpy = () => { window.__iv = new Map(); const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = (f, d, ...a) => { const id = si(f, d, ...a); window.__iv.set(id, d); return id; };
  window.clearInterval = (id) => { window.__iv.delete(id); return ci(id); }; };

// 1. form schema + assertConfig
{ const { page } = await open({});
  const r = await page.evaluate(() => { const C = customElements.get("map-overlay-card"); const f = C.getConfigForm();
    const names = []; const walk = (s) => s.forEach((x) => (x.schema ? walk(x.schema) : names.push(x.name))); walk(f.schema);
    const bad = []; for (const c of [{ zoom: 40 }, { traffic_refresh_minutes: 0 }, { radar_refresh_minutes: 999 }, { entities: ["light.x"] }, { bogus: 1 }, { height: "90vh" }]) { try { f.assertConfig(c); bad.push("accepted " + JSON.stringify(c)); } catch {} }
    try { f.assertConfig({ tomtom_key: "x", location: { latitude: 1, longitude: 2 }, entities: ["person.a"], show_radar: false }); } catch (e) { bad.push("rejected good: " + e.message); }
    const stub = C.getStubConfig(); const cc = (window.customCards || []).find((x) => x.type === "map-overlay-card");
    return { names, bad, labels: names.filter((n) => !f.computeLabel({ name: n })), stub, cc }; });
  const need = ["tomtom_key", "location", "zoom", "height", "radar_source", "radar_hours", "radar_step_minutes", "radar_opacity", "traffic_refresh_minutes", "radar_refresh_minutes", "show_radar", "show_flow", "show_incidents", "show_people", "entities", "show_zones", "dark", "autoplay", "show_home_marker", "radar_smoothing"];
  ok("form schema has all fields", need.every((n) => r.names.includes(n)), `missing=${need.filter((n) => !r.names.includes(n))}`);
  ok("form labels for every field", r.labels.length === 0, r.labels.join(","));
  ok("assertConfig rejects bad / accepts good", r.bad.length === 0, r.bad.join("; "));
  ok("stub config has no coords", !("latitude" in r.stub) && !("longitude" in r.stub), JSON.stringify(r.stub));
  ok("picker registration preview:true", r.cc?.preview === true && r.cc?.name === "Map Overlay Card");
  await page.close(); }

// 2. defaults from hass.config + overlay defaults + timers
{ const { page, reqs } = await open({ key: KEY, home: "43.49,-112.03" }, timerSpy);
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => { const c = window.__card, m = c._map, ctr = m.getCenter();
    return { lat: ctr.lat, lng: ctr.lng, zoom: m.getZoom(), flow: m.hasLayer(c._flow), inc: m.hasLayer(c._inc), people: m.hasLayer(c._peopleLayer), radarOn: c._radarOn, iv: [...window.__iv.values()] }; });
  ok("center falls back to hass.config", Math.abs(r.lat - 43.49) < 1e-6 && Math.abs(r.lng + 112.03) < 1e-6, `${r.lat},${r.lng} z${r.zoom}`);
  ok("default overlays all on", r.flow && r.inc && r.people && r.radarOn);
  ok("timers: radar, traffic, quake refresh 5 min", r.iv.filter((d) => d === 300000).length === 3, JSON.stringify(r.iv));
  ok("TomTom flow+incidents requested", reqs.some((u) => u.includes("/tile/flow/")) && reqs.some((u) => u.includes("/tile/incidents/")));
  ok("nowCOAST radar requested", reqs.some((u) => u.includes("nowcoast.noaa.gov") && /[?&]time=/i.test(u)));
  // cleanup
  await page.evaluate(() => window.__card.remove()); await page.waitForTimeout(200);
  const left = await page.evaluate(() => [...window.__iv.values()]);
  ok("cleanup clears all intervals on disconnect", left.length === 0, JSON.stringify(left));
  await page.close(); }

// 3. overlay defaults off + custom intervals
{ const cfg = { show_radar: false, show_flow: false, show_incidents: true, show_people: false, traffic_refresh_minutes: 1, radar_refresh_minutes: 10 };
  const { page, reqs } = await open({ key: KEY, cfg: JSON.stringify(cfg) }, timerSpy);
  await page.waitForTimeout(3000);
  let r = await page.evaluate(() => { const c = window.__card, m = c._map; const btns = [...c.shadowRoot.querySelectorAll(".panel button")].map((b) => b.textContent + ":" + b.classList.contains("on"));
    return { flow: m.hasLayer(c._flow), inc: m.hasLayer(c._inc), people: m.hasLayer(c._peopleLayer), radarOn: c._radarOn, op: c._frames.map((f) => f.layer.options.opacity), btns, iv: [...window.__iv.values()] }; });
  ok("overlay defaults respected", !r.flow && r.inc && !r.people && !r.radarOn && r.op.every((o) => o === 0), r.btns.join(" "));
  ok("custom intervals 1 and 10 min", r.iv.includes(60000) && r.iv.includes(600000), JSON.stringify(r.iv));
  // on-map toggle still works
  await page.evaluate(() => [...window.__card.shadowRoot.querySelectorAll(".panel button")].find((b) => b.textContent === "Flow").click());
  r = await page.evaluate(() => window.__card._map.hasLayer(window.__card._flow));
  ok("on-map Flow toggle turns flow on", r);
  if (KEY) { const n0 = reqs.filter((u) => u.includes("_ts=")).length; await page.waitForTimeout(63000);
    const ts = reqs.filter((u) => u.includes("api.tomtom.com") && u.includes("_ts="));
    ok("traffic tiles re-fetched with cache-bust after 1 min", ts.length > n0, `${ts.length} cache-busted TomTom requests`); }
  await page.close(); }

// 4. people overlay (fake entities)
{ const { page } = await open({ people: "1", cfg: JSON.stringify({ show_zones: true }) });
  await page.waitForTimeout(1500);
  let r = await page.evaluate(() => { const c = window.__card; return { ids: [...c._people.keys()], zones: [...c._zones.keys()], imgs: c.shadowRoot.querySelectorAll(".pill .av img").length, txt: [...c.shadowRoot.querySelectorAll(".pill")].map((e) => [e.querySelector(".av").textContent, e.querySelector(".nm").textContent]) }; });
  ok("default people = persons + standalone GPS trackers", JSON.stringify(r.ids.sort()) === JSON.stringify(["device_tracker.demo_car", "person.alex_demo", "person.sam_sample"]), r.ids.join(","));
  ok("pills: picture or initials on left + friendly_name from state", r.imgs === 1 && r.txt.some((x) => x[0] === "SS" && x[1] === "Sam Sample") && r.txt.some((x) => x[0] === "AD" && x[1] === "Alex Demo"), JSON.stringify(r.txt));
  ok("zones drawn", r.zones.includes("zone.home"));
  const nm = await page.evaluate(() => { const st = JSON.parse(JSON.stringify(window.__states)); st["person.sam_sample"].attributes.friendly_name = "P1 Renamed"; window.__setHass(st);
    return [...window.__card.shadowRoot.querySelectorAll(".person .nm")].map((e) => e.textContent); });
  ok("pill name follows friendly_name changes", nm.includes("P1 Renamed"), JSON.stringify(nm));
  r = await page.evaluate(() => { const st = JSON.parse(JSON.stringify(window.__states)); st["person.sam_sample"].attributes.latitude += 0.01; window.__setHass(st);
    return window.__card._people.get("person.sam_sample").marker.getLatLng().lat; });
  const exp = 37.104 - 0.05 + 0.01;
  ok("marker moves on state change", Math.abs(r - exp) < 1e-9, String(r));
  await page.evaluate(() => window.__card._people.get("person.alex_demo").marker.fire("click"));
  ok("tap fires hass-more-info", (await page.evaluate(() => window.__events)).includes("person.alex_demo"));
  await page.evaluate(() => [...window.__card.shadowRoot.querySelectorAll(".panel button")].find((b) => b.textContent === "People").click());
  ok("People toggle hides layer", !(await page.evaluate(() => window.__card._map.hasLayer(window.__card._peopleLayer))));
  await page.close(); }
{ const { page } = await open({ people: "1", cfg: JSON.stringify({ entities: ["device_tracker.demo_car", "person.alex_demo", "person.no_gps"] }) });
  await page.waitForTimeout(1500);
  const ids = await page.evaluate(() => [...window.__card._people.keys()].sort());
  ok("entities list honored (skips no-GPS)", JSON.stringify(ids) === JSON.stringify(["device_tracker.demo_car", "person.alex_demo"]), ids.join(","));
  await page.close(); }

// 5. visual editor shows effective defaults, writes minimal config
{ const { page } = await open({});
  const r = await page.evaluate(() => {
    if (!customElements.get("ha-form")) customElements.define("ha-form", class extends HTMLElement {});
    const out = {}; const C = customElements.get("map-overlay-card");
    const mk = (cfg) => { const ed = C.getConfigElement(); const ev = []; ed.addEventListener("config-changed", (e) => ev.push(e.detail.config)); document.body.appendChild(ed); ed.setConfig(cfg); ed.hass = { config: { latitude: 1, longitude: 2 }, states: {} }; return { ed, ev, form: ed.querySelector("ha-form") }; };
    const send = (x, data) => x.form.dispatchEvent(new CustomEvent("value-changed", { detail: { value: data } }));
    let x = mk({ type: "custom:map-overlay-card", tomtom_key: "k" });
    out.data = x.form.data;
    send(x, { ...x.form.data, zoom: 12 }); out.afterZoom = x.ev.at(-1);
    send(x, { ...x.form.data, zoom: 12, location: { latitude: 1, longitude: 2 } }); out.afterPin = x.ev.at(-1);
    send(x, { ...x.form.data, zoom: 12, location: undefined }); out.afterClear = x.ev.at(-1);
    x = mk({ type: "custom:map-overlay-card", latitude: 5, longitude: 6, show_flow: false });
    out.flatLoc = x.form.data.location; out.flatFlow = x.form.data.show_flow;
    send(x, { ...x.form.data, radar_hours: 2 }); out.flatAfter = x.ev.at(-1);
    try { C.getConfigElement().setConfig({ type: "custom:map-overlay-card", height: "90vh" }); out.yaml = false; } catch { out.yaml = true; }
    out.stub = C.getStubConfig();
    return out; });
  const d = r.data;
  ok("editor shows effective defaults", d.zoom === 10 && d.height === 450 && d.radar_hours === 3 && d.radar_step_minutes === 10 && d.radar_opacity === 0.6 && d.traffic_refresh_minutes === 5 && d.radar_refresh_minutes === 5 && d.show_radar && d.show_flow && d.show_incidents && d.show_people && d.autoplay && d.show_home_marker && d.full_height === true && !d.dark && !d.show_zones && d.radar_source === "nowcoast" && d.location === undefined, JSON.stringify(d));
  ok("changing one field writes only that field", JSON.stringify(r.afterZoom) === JSON.stringify({ type: "custom:map-overlay-card", tomtom_key: "k", zoom: 12 }), JSON.stringify(r.afterZoom));
  ok("moving pin writes location", r.afterPin?.location?.latitude === 1, JSON.stringify(r.afterPin));
  ok("clearing pin removes location", !("location" in r.afterClear), JSON.stringify(r.afterClear));
  ok("YAML lat/lon shown on pin, kept as-is", r.flatLoc?.latitude === 5 && r.flatFlow === false && JSON.stringify(r.flatAfter) === JSON.stringify({ type: "custom:map-overlay-card", latitude: 5, longitude: 6, show_flow: false, radar_hours: 2 }), JSON.stringify(r.flatAfter));
  ok("text height falls back to YAML editor", r.yaml);
  ok("stub config minimal, no coords", JSON.stringify(r.stub) === JSON.stringify({ tomtom_key: "" }));
  await page.close(); }

// 6. sections-grid-like cell: fills height, follows resize, edit overlay stays on top
{ const { page } = await open({});
  await page.evaluate(async () => {
    document.body.innerHTML = "";
    const cell = document.createElement("div"); cell.id = "cell"; cell.style.cssText = "position:relative;width:600px;height:504px";
    const sr = cell.attachShadow({ mode: "open" });
    sr.innerHTML = `<style>.card-wrapper{position:relative;height:100%;z-index:0}.ov{position:absolute;inset:0;z-index:0;background:rgba(0,0,0,.3)}</style><div class="card-wrapper"><slot></slot></div><div class="ov" id="ov"></div>`;
    const card = document.createElement("map-overlay-card");
    card.setConfig({ type: "custom:map-overlay-card", height: 300 });
    card.layout = "grid"; cell.appendChild(card); document.body.appendChild(cell);
    card.hass = { config: { latitude: 37.1, longitude: -113.58 }, states: {} };
    window.__g = card; });
  await page.waitForFunction(() => window.__g._map, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const sz = () => page.evaluate(() => { const m = window.__g._map.getSize(); return [m.x, m.y]; });
  const a = await sz();
  await page.evaluate(() => { const c = document.getElementById("cell"); c.style.height = "504px"; c.style.width = "400px"; });
  await page.waitForTimeout(500);
  const b = await sz();
  const top = await page.evaluate(() => { const c = document.getElementById("cell"); const el = c.shadowRoot.elementFromPoint(200, 140); return el?.id; });
  const opts = await page.evaluate(() => [window.__g.getGridOptions(), window.__g.getLayoutOptions(), window.__g.getAttribute("layout")]);
  ok("grid layout fills cell height (ignores height px)", a[0] === 600 && a[1] === 504, JSON.stringify(a));
  ok("resize -> invalidateSize follows cell", b[0] === 400 && b[1] === 504, JSON.stringify(b));
  ok("edit overlay stays above map", top === "ov", String(top));
  await page.evaluate(() => { const c = document.getElementById("cell"); c.style.height = "auto"; });
  await page.waitForTimeout(400);
  const ce = await sz();
  ok("edit-mode-like auto-height wrapper keeps 8-row grid height", ce[1] === 504, JSON.stringify(ce));
  ok("getGridOptions / getLayoutOptions", opts[0].rows === 8 && opts[0].min_rows === 4 && opts[1].grid_rows === 8 && opts[2] === "grid", JSON.stringify(opts));
  await page.close(); }
{ const { page } = await open({ cfg: JSON.stringify({ height: 300, full_height: false }) });
  await page.waitForTimeout(800);
  const h = await page.evaluate(() => window.__card._map.getSize().y);
  ok("outside grid uses height px", h === 300, String(h));
  await page.close(); }

// 7. auto height, full height, per-source history caps
{ const { page } = await open({});
  await page.evaluate(() => {
    document.body.innerHTML = "";
    const mk = (id, cfg) => { const cell = document.createElement("div"); cell.style.cssText = "width:500px"; const c = document.createElement("map-overlay-card");
      c.setConfig({ type: "custom:map-overlay-card", ...cfg }); c.layout = "grid"; cell.appendChild(c); document.body.appendChild(cell);
      c.hass = { config: { latitude: 37.1, longitude: -113.58 }, states: {} }; window[id] = c; };
    mk("__a", { height: 520, full_height: false, grid_options: { rows: "auto" } }); mk("__f", { grid_options: { rows: "auto" } });
  });
  await page.waitForFunction(() => window.__a._map && window.__f._map, null, { timeout: 10000 });
  const r = await page.evaluate(() => [window.__a._map.getSize().y, window.__f._map.getSize().y, innerHeight]);
  ok("auto height uses configured height", r[0] === 520, String(r[0]));
  ok("full_height ~ viewport minus header", r[1] > r[2] - 120 && r[1] <= r[2], JSON.stringify(r));
  const g = await page.evaluate(() => window.__a.getGridOptions());
  ok("default grid columns full", g.columns === "full", JSON.stringify(g));
  await page.close(); }
{ const { page } = await open({ cfg: JSON.stringify({ radar_source: "rainviewer", radar_hours: 6 }) });
  await page.waitForFunction(() => window.__card?._frames?.length, null, { timeout: 15000 }).catch(() => {});
  const n = await page.evaluate(() => [window.__card._hours(), window.__card._frames.length]);
  ok("rainviewer history clamped to 2 h", n[0] === 2 && n[1] <= 13, JSON.stringify(n));
  const e = await page.evaluate(() => {
    if (!customElements.get("ha-form")) customElements.define("ha-form", class extends HTMLElement {});
    const C = customElements.get("map-overlay-card"); const ed = C.getConfigElement(); const out = [];
    ed.addEventListener("config-changed", (ev) => out.push(ev.detail.config)); document.body.appendChild(ed);
    ed.setConfig({ type: "custom:map-overlay-card", radar_hours: 6 }); ed.hass = { config: {}, states: {} };
    const maxOf = () => { let m; const w = (sc) => sc.forEach((x) => (x.schema ? w(x.schema) : x.name === "radar_hours" && (m = x.selector.number.max))); w(ed.querySelector("ha-form").schema); return m; };
    const m1 = maxOf(); const f = ed.querySelector("ha-form");
    f.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...f.data, radar_source: "rainviewer" } } }));
    const r2 = [maxOf(), f.data.radar_hours, out.at(-1).radar_hours];
    f.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...f.data, radar_source: "nowcoast" } } }));
    return [m1, ...r2, f.data.radar_hours, out.at(-1).radar_hours]; });
  ok("editor: max follows source, display trimmed, user value kept and restored", JSON.stringify(e) === JSON.stringify([8, 2, 2, 6, 6, 6]), JSON.stringify(e));
  await page.close(); }

// 8. label/helper widths and people grouping
{ const { page } = await open({});
  const w = await page.evaluate(() => {
    const C = customElements.get("map-overlay-card"); const f = C.getConfigForm();
    const cv = document.createElement("canvas").getContext("2d"); const out = [];
    const walk = (sc, inGrid) => sc.forEach((x) => { if (x.schema) return walk(x.schema, x.type === "grid");
      cv.font = "16px Roboto, Arial, sans-serif"; const lw = cv.measureText(f.computeLabel(x) || "").width;
      cv.font = "12px Roboto, Arial, sans-serif"; const hw = cv.measureText(f.computeHelper(x) || "").width;
      out.push({ n: x.name, lw: Math.round(lw), hw: Math.round(hw), limit: inGrid ? 170 : 330 }); });
    walk(f.schema, false);
    cv.font = "12px Roboto, Arial, sans-serif";
    const rh = ["nowcoast", "nexrad", "rainviewer"].map((s) => Math.round(cv.measureText(`${{ nowcoast: "nowCOAST", nexrad: "NEXRAD", rainviewer: "RainViewer" }[s]} max 24 h (longer values are trimmed)`).width));
    return { out, rh }; });
  const bad = w.out.filter((x) => x.lw > x.limit || x.hw > 330);
  ok("labels fit one line (grid half ~170px, full ~330px at 400px form)", bad.length === 0 && w.rh.every((x) => x <= 330), JSON.stringify(bad) + " radarHelper=" + w.rh);
  await page.close(); }
{ const { page } = await open({ cfg: JSON.stringify({ zoom: 10 }) });
  await page.waitForTimeout(1200);
  const base = [37.2, -113.5];
  const mk = (pts) => Object.fromEntries(pts.map(([id, dl], i) => [id, { state: "x", attributes: { friendly_name: id.split(".")[1], latitude: base[0] + dl, longitude: base[1] + dl, ...(i === 0 ? { entity_picture: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" } : {}) } }]));
  const info = () => page.evaluate(() => { const c = window.__card; return { groups: c.shadowRoot.querySelectorAll(".people-group").length, singles: c.shadowRoot.querySelectorAll(".person").length, avs: [...c.shadowRoot.querySelectorAll(".people-group .pill")].map((e) => e.dataset.id), names: [...c.shadowRoot.querySelectorAll(".people-group .nm")].map((e) => e.textContent) }; });
  await page.evaluate((st) => window.__setHass(st), mk([["person.a", 0], ["person.b", 0]]));
  await page.waitForTimeout(200); let r = await info();
  ok("2 people same spot -> 1 callout with 2 avatars", r.groups === 1 && r.singles === 0 && r.avs.length === 2, JSON.stringify(r));
  await page.evaluate((st) => window.__setHass(st), mk([["person.a", 0], ["person.b", 0.0004], ["person.c", 0.0008]]));
  await page.waitForTimeout(200); r = await info();
  ok("3 nearby people -> 1 callout with 3 pills named from state", r.groups === 1 && r.avs.length === 3 && JSON.stringify(r.names) === JSON.stringify(["a", "b", "c"]), JSON.stringify(r));
  const clicked = await page.evaluate(() => { window.__events.length = 0; const av = window.__card.shadowRoot.querySelector('.people-group .pill[data-id="person.c"] .nm'); av.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 })); return window.__events.slice(); });
  ok("tap avatar in callout opens that entity", clicked.includes("person.c"), JSON.stringify(clicked));
  await page.evaluate(() => window.__card._map.setZoom(18, { animate: false })); await page.waitForTimeout(400); r = await info();
  ok("zoomed in -> separate markers", r.groups === 0 && r.singles === 3, JSON.stringify(r));
  await page.evaluate(() => window.__card._map.setZoom(10, { animate: false })); await page.waitForTimeout(400); r = await info();
  ok("zoomed out -> grouped again", r.groups === 1 && r.avs.length === 3, JSON.stringify(r));
  await page.close(); }

// 9. radar off hides radar controls; zoom cap
{ const { page } = await open({ key: KEY, cfg: JSON.stringify({ show_radar: false }) });
  await page.waitForTimeout(2500);
  const st = () => page.evaluate(() => { const r = window.__card.shadowRoot; const g = r.querySelector(".radarctl");
    return { hidden: getComputedStyle(g).display === "none", playVisible: !!r.querySelector(".radarctl button")?.offsetParent, time: r.querySelector(".time").textContent }; });
  let r = await st();
  ok("radar off: radar controls hidden, time shows last update", r.hidden && !r.playVisible && /^Updated \w{3} \d/.test(r.time), JSON.stringify(r));
  await page.evaluate(() => [...window.__card.shadowRoot.querySelectorAll(".panel button")].find((b) => b.textContent === "Radar").click());
  await page.waitForTimeout(800); r = await st();
  ok("radar on: controls back, frame time shown", !r.hidden && r.playVisible && !/^Updated/.test(r.time), JSON.stringify(r));
  await page.evaluate(() => [...window.__card.shadowRoot.querySelectorAll(".panel button")].find((b) => b.textContent === "Radar").click());
  r = await st(); ok("radar off again: hidden", r.hidden && /^Updated/.test(r.time), JSON.stringify(r));
  const z = await page.evaluate(() => { const m = window.__card._map; m.setZoom(22, { animate: false }); return [m.getMaxZoom(), m.getZoom()]; });
  ok("map zoom capped at 19 (OSM max)", z[0] === 19 && z[1] === 19, JSON.stringify(z));
  const v = await page.evaluate(() => { const f = customElements.get("map-overlay-card").getConfigForm(); let max; const w = (sc) => sc.forEach((x) => (x.schema ? w(x.schema) : x.name === "zoom" && (max = x.selector.number.max))); w(f.schema);
    let rej = false; try { f.assertConfig({ zoom: 20 }); } catch { rej = true; } return [max, rej]; });
  ok("Zoom setting max 19, zoom 20 rejected", v[0] === 19 && v[1], JSON.stringify(v));
  await page.close(); }

// 10. people bubble readable on dark map with a dark HA theme
{ const { page } = await open({ people: "1", cfg: JSON.stringify({ dark: true, show_radar: false }) });
  await page.waitForTimeout(1200);
  const bg = await page.evaluate(() => { const st = JSON.parse(JSON.stringify(window.__states)); st["person.sam_sample"].attributes.latitude = st["person.alex_demo"].attributes.latitude; st["person.sam_sample"].attributes.longitude = st["person.alex_demo"].attributes.longitude; window.__setHass(st);
    const b = window.__card.shadowRoot.querySelector(".people-group .bubble"); return [getComputedStyle(document.documentElement).getPropertyValue("--card-background-color").trim(), getComputedStyle(b).backgroundColor]; });
  ok("bubble white on dark map even with dark theme card color", bg[0] === "#1c1c1c" && bg[1] === "rgb(255, 255, 255)", JSON.stringify(bg));
  await page.close(); }

// 11. earthquakes
{ usgsHits.length = 0; extraQuakes = [];
  const { page } = await open({ people: "1", cfg: JSON.stringify({ show_radar: false, quake_min_magnitude: 2.5 }) }, timerSpy);
  await page.waitForTimeout(1500);
  let r = await page.evaluate(() => { const c = window.__card; return { ids: [...c._quakes.keys()].sort(), on: c._map.hasLayer(c._quakeLayer), iv: [...window.__iv.values()],
    colors: [...c.shadowRoot.querySelectorAll(".quake span")].map((e) => [e.textContent, e.style.background]), btn: [...c.shadowRoot.querySelectorAll(".panel button")].some((b) => b.textContent === "Quakes") }; });
  ok("quake feed chosen for min 2.5 = 2.5_day", usgsHits.some((u) => u.endsWith("/2.5_day.geojson")), usgsHits.join(","));
  ok("quakes: >= min mag, last 24 h only (worldwide)", JSON.stringify(r.ids) === JSON.stringify(["b27", "c46", "d63", "far"]), r.ids.join(","));
  ok("quake markers show magnitude, yellow->red", r.colors.find((x) => x[0] === "2.7")?.[1].startsWith("rgb(255, 199") && r.colors.find((x) => x[0] === "6.3")?.[1] === "rgb(213, 0, 0)", JSON.stringify(r.colors));
  ok("quakes on by default + Quakes button + 5 min timer", r.on && r.btn && r.iv.includes(300000), JSON.stringify(r.iv));
  const pop = await page.evaluate(() => { const m = window.__card._quakes.get("d63").marker; m.openPopup(); return window.__card.shadowRoot.querySelector(".qpop")?.innerText || ""; });
  ok("popup has all details", ["M6.3 ml", "Test place d63", "ago", "Depth", "5.1 mi", "Felt reports", "MMI", "CDI", "PAGER alert", "orange", "Tsunami", "Possible", "Status", "reviewed", "USGS event page"].every((s) => pop.includes(s)), pop.replace(/\s+/g, " "));
  // people grouping unaffected: put a quake right at a person
  extraQuakes = [q("atp", 3.3, 0.03, -0.06, 0.5)];
  await page.evaluate(() => window.__card._refreshQuakes()); await page.waitForTimeout(500);
  r = await page.evaluate(() => { const c = window.__card; return { q: c._quakes.has("atp"), groups: c.shadowRoot.querySelectorAll(".people-group").length, singles: c.shadowRoot.querySelectorAll(".person").length }; });
  ok("new quake appears on refresh; people grouping unaffected", r.q && r.groups === 1 && r.singles === 1, JSON.stringify(r));
  extraQuakes = [];
  await page.evaluate(() => window.__card._refreshQuakes()); await page.waitForTimeout(300);
  ok("quake gone from feed is removed", !(await page.evaluate(() => window.__card._quakes.has("atp"))));
  await page.evaluate(() => [...window.__card.shadowRoot.querySelectorAll(".panel button")].find((b) => b.textContent === "Quakes").click());
  ok("Quakes toggle hides layer", !(await page.evaluate(() => window.__card._map.hasLayer(window.__card._quakeLayer))));
  await page.close(); }
{ usgsHits.length = 0;
  const { page } = await open({ cfg: JSON.stringify({ show_radar: false, show_quakes: false, quake_min_magnitude: 0.5, quake_radius_km: 100, quake_refresh_minutes: 0.2 }) }, timerSpy);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => { const c = window.__card; return { ids: [...c._quakes.keys()].sort(), on: c._map.hasLayer(c._quakeLayer), iv: [...window.__iv.values()] }; });
  ok("min 0.5 -> all_day feed; radius 100 km filters far quake", usgsHits.some((u) => u.endsWith("/all_day.geojson")) && JSON.stringify(r.ids) === JSON.stringify(["a12", "b27", "c46", "d63"]), r.ids.join(","));
  ok("show_quakes false = off at start; refresh clamped to 1 min", !r.on && r.iv.includes(60000), JSON.stringify(r.iv));
  const feeds = await page.evaluate(() => { const c = window.__card, o = c._config.quake_min_magnitude, out = [];
    for (const m of [0, 1, 2.5, 4.5, 6]) { c._config.quake_min_magnitude = m; out.push(c._quakeFeed().split("/").pop()); } c._config.quake_min_magnitude = o; return out; });
  ok("feed selection by min magnitude", JSON.stringify(feeds) === JSON.stringify(["all_day.geojson", "1.0_day.geojson", "2.5_day.geojson", "4.5_day.geojson", "4.5_day.geojson"]), feeds.join(","));
  await page.evaluate(() => window.__card.remove()); await page.waitForTimeout(200);
  ok("quake timer cleared on disconnect", (await page.evaluate(() => [...window.__iv.values()])).length === 0);
  await page.close(); }

// 12. pictures, per-person overrides, quake units
{ const { page } = await open({ cfg: JSON.stringify({ show_radar: false, people: { "person.p1": { name: "Custom Name", image: { media_content_id: "media-source://image_upload/abc123", media_content_type: "image/png" } }, "person.p2": { image: "/local/x.png" } } }) });
  await page.waitForTimeout(1000);
  const r = await page.evaluate(async () => {
    const base = { config: { latitude: 37.104, longitude: -113.584 }, themes: {}, hassUrl: (p) => "https://ha.example" + p };
    window.__card.hass = { ...base, states: {
      "person.p1": { state: "x", attributes: { friendly_name: "P1", latitude: 37.3, longitude: -113.3, entity_picture: "/api/image/serve/orig/512x512" } },
      "person.p2": { state: "x", attributes: { friendly_name: "P2", latitude: 36.9, longitude: -113.9 } },
      "person.p3": { state: "x", attributes: { friendly_name: "Pat Three", latitude: 37.0, longitude: -113.2, entity_picture: "/api/image/serve/0123456789abcdef0123456789abcdef/512x512" } } } };
    await new Promise((res) => setTimeout(res, 300));
    const pills = [...window.__card.shadowRoot.querySelectorAll(".pill")].map((p) => ({ id: p.dataset.id, nm: p.querySelector(".nm").textContent, src: p.querySelector("img")?.getAttribute("src") || null }));
    await new Promise((res) => setTimeout(res, 1500)); // let broken images fail
    const after = [...window.__card.shadowRoot.querySelectorAll(".pill")].map((p) => ({ id: p.dataset.id, img: !!p.querySelector("img"), initials: p.querySelector(".av").firstChild?.textContent }));
    return { pills, after }; });
  const by = Object.fromEntries(r.pills.map((x) => [x.id, x]));
  ok("override name used, else friendly_name", by["person.p1"]?.nm === "Custom Name" && by["person.p3"]?.nm === "Pat Three", JSON.stringify(r.pills));
  ok("uploaded image -> /api/image/serve/<id>/512x512 via hassUrl", by["person.p1"]?.src === "https://ha.example/api/image/serve/abc123/512x512", by["person.p1"]?.src);
  ok("URL override and real entity_picture form go through hassUrl", haReq.includes("https://ha.example/local/x.png") && by["person.p3"]?.src === "https://ha.example/api/image/serve/0123456789abcdef0123456789abcdef/512x512", JSON.stringify(r.pills));
  ok("pictures load; failed picture (404) falls back to initials", JSON.stringify(r.after.map((x) => x.img)) === "[true,false,true]" && r.after[1].initials === "P", JSON.stringify(r.after));
  await page.close(); }
{ const { page } = await open({ cfg: JSON.stringify({ show_radar: false, quake_min_magnitude: 2.5, quake_radius: 20 }) });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => { const c = window.__card; const ids = [...c._quakes.keys()].sort(); c._quakes.get("b27").marker.openPopup(); return { ids, pop: c.shadowRoot.querySelector(".qpop").innerText }; });
  // b27 is 0.2 deg north of home (~13.8 mi); c46 ~0.28 deg (~19.3 mi? includes lon) ; d63 ~0.42 deg (~ 29 mi)
  ok("radius 20 mi from home (imperial default)", JSON.stringify(r.ids) === JSON.stringify(["b27", "c46"]), r.ids.join(","));
  ok("popup: distance from home and depth in miles", /From home\s*14 mi/.test(r.pop) && /Depth\s*5\.1 mi/.test(r.pop), r.pop.replace(/\s+/g, " "));
  await page.close(); }
{ const { page } = await open({ cfg: JSON.stringify({ show_radar: false, quake_units: "metric", quake_radius: 25 }) });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => { const c = window.__card; const ids = [...c._quakes.keys()].sort(); c._quakes.get("b27").marker.openPopup(); return { ids, pop: c.shadowRoot.querySelector(".qpop").innerText }; });
  ok("metric: radius 25 km from home", JSON.stringify(r.ids) === JSON.stringify(["b27"]), r.ids.join(","));
  ok("metric popup units", /km/.test(r.pop) && !/\d mi\b/.test(r.pop), r.pop.replace(/\s+/g, " "));
  await page.close(); }
{ const { page } = await open({});
  const r = await page.evaluate(async () => {
    if (!customElements.get("ha-form")) customElements.define("ha-form", class extends HTMLElement {});
    // stand-in for HA's ha-picture-upload: records crop settings, emits "change" like the real one
    customElements.define("ha-picture-upload", class extends HTMLElement {});
    const C = customElements.get("map-overlay-card"); const ed = C.getConfigElement(); const out = [];
    ed.addEventListener("config-changed", (e) => out.push(e.detail.config)); document.body.appendChild(ed);
    ed.setConfig({ type: "custom:map-overlay-card" });
    ed.hass = { config: {}, states: { "person.p1": { state: "x", attributes: { friendly_name: "P1" } } } };
    const f = ed.querySelector("ha-form"); const names = []; const w = (sc) => sc.forEach((x) => (x.schema ? w(x.schema) : names.push([x.name, Object.keys(x.selector)[0], JSON.stringify(x.selector)]))); w(f.schema);
    const label = f.computeLabel({ name: "pname:person.p1" });
    f.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...f.data, "pname:person.p1": "Dad" } } }));
    const c1 = out.at(-1);
    const up = ed.querySelector('ha-picture-upload[data-id="person.p1"]');
    const crop = up && { crop: up.crop, selectMedia: up.selectMedia, opts: up.cropOptions };
    up.value = "/api/image/serve/xyz/512x512"; up.dispatchEvent(new Event("change"));
    const c2 = out.at(-1);
    f.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...ed.querySelector("ha-form").data, "pname:person.p1": "" } } }));
    const c3 = out.at(-1);
    up.value = null; up.dispatchEvent(new Event("change"));
    return { names, label, c1, c2, c3, c4: out.at(-1), crop, unit: names.find((x) => x[0] === "quake_radius")?.[2] }; });
  ok("editor: per-person name field", r.names.some((x) => x[0] === "pname:person.p1" && x[1] === "text") && r.label === "P1: name", JSON.stringify(r.names.filter((x) => x[0].startsWith("p"))));
  ok("editor: picture uses ha-picture-upload with People crop (square, round)", r.crop?.crop === true && r.crop.selectMedia === true && JSON.stringify(r.crop.opts) === JSON.stringify({ round: true, quality: 0.75, aspectRatio: 1 }), JSON.stringify(r.crop));
  ok("editor: name + picture saved under people; each clears independently", r.c1.people?.["person.p1"]?.name === "Dad" && r.c2.people["person.p1"].image === "/api/image/serve/xyz/512x512" && r.c2.people["person.p1"].name === "Dad" && !r.c3.people["person.p1"].name && r.c3.people["person.p1"].image && !("people" in r.c4), JSON.stringify([r.c1, r.c2, r.c3, r.c4]));
  ok("radius unit shows mi by default", r.unit.includes('"unit_of_measurement":"mi"'), r.unit);
  await page.close(); }

// 0.3.2: owner-linked tracker setup (fake coords): person.alex owns device_tracker.alex_phone; sam_tracker is standalone.
for (const [label, ents, want] of [["default", null, ["person.alex", "device_tracker.sam_tracker"]],
                                   ["saved list of trackers only", ["device_tracker.sam_tracker", "device_tracker.alex_phone"], ["device_tracker.sam_tracker", "person.alex"]],
                                   ["list with person + its phone", ["person.alex", "device_tracker.alex_phone"], ["person.alex"]]]) {
  const { page } = await open({});
  const r = await page.evaluate(async (ents) => {
    const st = {
      "person.alex": { state: "home", attributes: { friendly_name: "Alex", device_trackers: ["device_tracker.alex_phone"], source: "device_tracker.alex_phone", latitude: 37.10, longitude: -113.58, gps_accuracy: 100, entity_picture: "/api/image/serve/0123456789abcdef0123456789abcdef/512x512" } },
      "device_tracker.alex_phone": { state: "home", attributes: { friendly_name: "Alex Phone", source_type: "gps", latitude: 37.10, longitude: -113.58, gps_accuracy: 100 } },
      "device_tracker.sam_tracker": { state: "not_home", attributes: { friendly_name: "Sam Tracker", source_type: "gps", latitude: 37.30, longitude: -113.20, gps_accuracy: 20 } },
      "device_tracker.router_thing": { state: "home", attributes: { friendly_name: "Router thing", source_type: "router" } } };
    const old = window.__card; const card = document.createElement("map-overlay-card"); window.__card = card;
    const cfg = { type: "custom:map-overlay-card", show_radar: false, show_flow: false, show_incidents: false, show_quakes: false, zoom: 8 };
    if (ents) cfg.entities = ents;
    card.setConfig(cfg); old.replaceWith(card);
    card.hass = { config: { latitude: 37.104, longitude: -113.584 }, themes: {}, states: st, hassUrl: (p) => "https://ha.example" + p };
    await new Promise((res) => setTimeout(res, 1500));
    const pills = [...card.shadowRoot.querySelectorAll(".pill")].map((e) => ({ id: e.dataset.id, nm: e.querySelector(".nm")?.textContent, img: e.querySelector("img")?.src || null, w: e.querySelector("img")?.naturalWidth || 0 }));
    return pills; }, ents);
  const ids = r.map((x) => x.id);
  ok(`Linked tracker setup (${label}): markers ${want.join(", ")}`, JSON.stringify([...ids].sort()) === JSON.stringify([...want].sort()), JSON.stringify(r));
  if (label === "default") {
    const t = r.find((x) => x.id === "person.alex"), e = r.find((x) => x.id === "device_tracker.sam_tracker");
    ok("Linked tracker setup: Alex pill named 'Alex' with picture loaded", t?.nm === "Alex" && t.img === "https://ha.example/api/image/serve/0123456789abcdef0123456789abcdef/512x512" && t.w > 0, JSON.stringify(t));
    ok("Linked tracker setup: Sam Tracker under its own name, initials", e?.nm === "Sam Tracker" && !e.img, JSON.stringify(e));
  }
  await page.close();
}
// 0.3.3: name override accepts spaces while typing (HA round-trips each change through setConfig)
{ const { page } = await open({});
  const r = await page.evaluate(async () => {
    if (!customElements.get("ha-form")) customElements.define("ha-form", class extends HTMLElement {});
    const st = { "device_tracker.sam_tracker": { state: "x", attributes: { friendly_name: "Sam Tracker", latitude: 37.1, longitude: -113.58 } } };
    const ed = customElements.get("map-overlay-card").getConfigElement(); document.body.appendChild(ed);
    let cfg = { type: "custom:map-overlay-card" }; ed.addEventListener("config-changed", (e) => { cfg = e.detail.config; ed.setConfig(cfg); });
    ed.setConfig(cfg); ed.hass = { config: {}, states: st };
    const shown = [];
    for (const typed of ["E", "Sam", "Sam ", "Sam S", "Sam Smith", " Sam Smith "]) {
      const f = ed.querySelector("ha-form");
      f.dispatchEvent(new CustomEvent("value-changed", { detail: { value: { ...f.data, "pname:device_tracker.sam_tracker": typed } } }));
      shown.push(ed.querySelector("ha-form").data["pname:device_tracker.sam_tracker"]);
    }
    const old = window.__card; const card = document.createElement("map-overlay-card"); window.__card = card;
    card.setConfig({ ...cfg, show_radar: false, show_flow: false, show_incidents: false, show_quakes: false }); old.replaceWith(card);
    card.hass = { config: { latitude: 37.1, longitude: -113.58 }, themes: {}, states: st };
    await new Promise((res) => setTimeout(res, 1200));
    return { shown, saved: cfg.people?.["device_tracker.sam_tracker"]?.name, nm: card.shadowRoot.querySelector(".pill .nm")?.textContent }; });
  ok("name field keeps spaces while typing", JSON.stringify(r.shown) === JSON.stringify(["E", "Sam", "Sam ", "Sam S", "Sam Smith", " Sam Smith "]), JSON.stringify(r.shown));
  ok("'Sam Smith' saves and displays (trimmed on the map)", r.saved?.trim() === "Sam Smith" && r.nm === "Sam Smith", JSON.stringify(r));
  await page.close(); }
// 0.3.3: pill size, sharp avatars, grouping threshold
for (const dpr of [1, 2, 3]) {
  const { page } = await open({}, null, dpr);
  await page.route("**/api/image/serve/big**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: readFileSync(new URL("./big512.svg", import.meta.url)) }));
  const r = await page.evaluate(async () => {
    const st = { "person.alex": { state: "home", attributes: { friendly_name: "Alex", latitude: 37.10, longitude: -113.58, entity_picture: "/api/image/serve/bigabc/256x256" } },
                 "person.b": { state: "home", attributes: { friendly_name: "Bea", latitude: 37.30, longitude: -113.20 } } };
    const old = window.__card; const card = document.createElement("map-overlay-card"); window.__card = card;
    card.setConfig({ type: "custom:map-overlay-card", show_radar: false, show_flow: false, show_incidents: false, show_quakes: false, zoom: 8 }); old.replaceWith(card);
    card.hass = { config: { latitude: 37.104, longitude: -113.584 }, themes: {}, states: st, hassUrl: (p) => p }; // same origin, like real HA
    await new Promise((res) => setTimeout(res, 2000));
    const pill = card.shadowRoot.querySelector('.pill[data-id="person.alex"]'), av = pill.querySelector(".av"), img = av.querySelector("img"), nm = pill.querySelector(".nm");
    const cs = getComputedStyle(img);
    return { dpr: devicePixelRatio, pillH: pill.getBoundingClientRect().height, av: av.getBoundingClientRect().width, nm: getComputedStyle(nm).fontSize, fit: cs.objectFit,
      sharp: img.dataset.sharp, isData: img.src.startsWith("data:image/png"), nat: img.naturalWidth, rendered: img.getBoundingClientRect().width };
  });
  ok(`DPR ${dpr}: pill 46px, avatar 40px, name 15px, object-fit cover`, r.pillH === 46 && r.av === 40 && r.nm === "15px" && r.fit === "cover", JSON.stringify(r));
  ok(`DPR ${dpr}: avatar pre-scaled to exactly ${40 * dpr}px (no browser downscale)`, r.sharp === "1" && r.isData && r.nat === 40 * dpr && r.rendered === 40, JSON.stringify(r));
  await page.close();
}
{ const { page } = await open({});
  const r = await page.evaluate(async () => {
    const pics = []; const old = window.__card; const card = document.createElement("map-overlay-card"); window.__card = card;
    card.setConfig({ type: "custom:map-overlay-card", show_radar: false, show_flow: false, show_incidents: false, show_quakes: false, zoom: 10, latitude: 37.1, longitude: -113.58 }); old.replaceWith(card);
    const mk = (dy) => ({ "person.a": { state: "x", attributes: { friendly_name: "Ann", latitude: 37.1, longitude: -113.58, entity_picture: "/api/image/serve/xyz/256x256" } },
      "person.b": { state: "x", attributes: { friendly_name: "Bob", latitude: 37.1 - dy, longitude: -113.58 } } });
    const res = [];
    for (let i = 0; i < 50 && !card._map; i++) await new Promise((r) => setTimeout(r, 100));
    for (const px of [44, 60]) { // vertical pixel gap between the two people
      const m = card._map; const p = m.latLngToContainerPoint([37.1, -113.58]); const ll = m.containerPointToLatLng([p.x, p.y + px]);
      card.hass = { config: { latitude: 37.1, longitude: -113.58 }, themes: {}, states: mk(37.1 - ll.lat), hassUrl: (p) => "https://ha.example" + p };
      await new Promise((r) => setTimeout(r, 700));
      res.push(card.shadowRoot.querySelectorAll(".people-group").length);
      pics.push(card.shadowRoot.querySelector('.pill[data-id="person.a"] img')?.getAttribute("src"));
    }
    return { res, pics }; });
  ok("grouping: 44px apart (would overlap 46px pills) -> 1 callout; 60px apart -> separate", JSON.stringify(r.res) === "[1,0]", JSON.stringify(r.res));
  ok("serve thumbnail 256x256 upgraded to 512x512", /\/api\/image\/serve\/xyz\/512x512$/.test(r.pics[0] || "") || (r.pics[0] || "").startsWith("data:"), JSON.stringify(r.pics));
  await page.close(); }
await browser.close(); srv.close();
const f = results.filter((r) => !r.pass).length; console.log(`\n${results.length - f}/${results.length} passed`); process.exit(f ? 1 : 0);
