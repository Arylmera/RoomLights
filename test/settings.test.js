"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const lib = require("../lib/daylight.js");
const { PAGE, PAGE_IDS, byClass, byTag, contains, field, fields, loadPage } = require("./dom.js");

// The settings page is the half of this app with no other cover: it drives no
// Flow card, so nothing else exercises it, and it has now shipped two bugs.
//
// The fake server below validates a save with the app's OWN validDaylight, so a
// page that builds something the app would reject fails here rather than in the
// user's hands.

// The Measure button's field carries a blank caption, so its top edge lines up
// with the boxes beside it.
const BLANK = "&nbsp;";

const LUX_SOURCES = () => [
  { id: "lux", name: "Occupency bureau", value: 3.19 },
  { id: "bath", name: "Occupancy Salle de bain", value: 155 },
];
const WEATHER_SOURCES = () => [{ id: "sky", name: "Gembloux Weather", value: 97 }];
const ROOMS = () => [
  { id: "bureau", name: "Bureau" },
  { id: "salon", name: "Salon" },
];

function startPage(options) {
  const opts = options || {};
  const { sandbox, document } = loadPage();

  const state = {
    mappings: opts.mappings || {},
    offBelow: 0.05,
    daylight: opts.daylight || {},
    weather: opts.weather || null,
    luxSources: opts.luxSources || LUX_SOURCES(),
  };
  const alerts = [];
  const puts = [];
  let ready = false;

  const page = () => ({
    rooms: ROOMS(),
    variables: [{ id: "b", name: "Salon - Brightness" }],
    mappings: state.mappings,
    offBelow: state.offBelow,
    daylight: state.daylight,
    luxSources: state.luxSources,
    weatherSources: WEATHER_SOURCES(),
    weather: state.weather,
    modelled: opts.modelled === undefined ? 24000 : opts.modelled,
  });

  const luxIds = () => new Set(state.luxSources.map((source) => String(source.id)));
  const cloudIds = new Set(WEATHER_SOURCES().map((source) => String(source.id)));

  const Homey = {
    // Identity, so assertions name the key rather than the copy. Whether the
    // keys exist at all is checked separately, against both locale files.
    __: (key) => key,
    alert: (message) => alerts.push(message),
    ready: () => {
      ready = true;
    },
    api: (method, path, body, callback) => {
      if (method === "GET" && path === "/lights") {
        return callback(opts.lightsError || null, []);
      }
      if (method === "GET" && path === "/defaults") {
        return callback(opts.defaultsError || null, opts.defaultsError ? null : page());
      }
      if (method === "PUT" && path === "/roles") {
        return callback(null, body);
      }
      if (method === "PUT" && path === "/defaults") {
        puts.push(JSON.parse(JSON.stringify(body)));
        const daylight = {};
        for (const roomId of Object.keys(body.daylight || {})) {
          const valid = lib.validDaylight(body.daylight[roomId]);
          if (valid == null) continue;
          if (valid.source !== lib.MODELLED_SOURCE && !luxIds().has(String(valid.source))) continue;
          daylight[roomId] = valid;
        }
        state.daylight = daylight;
        state.mappings = body.mappings || {};
        state.weather = cloudIds.has(body.weather) ? body.weather : null;
        return callback(null, {
          mappings: state.mappings,
          offBelow: state.offBelow,
          daylight: daylight,
          weather: state.weather,
        });
      }
      throw new Error(`unexpected api call ${method} ${path}`);
    },
  };

  sandbox.onHomeyReady(Homey);
  return {
    Homey,
    alerts,
    puts,
    state,
    document,
    container: document.getElementById("daylight"),
    measureButton: (name) =>
      byClass(document.getElementById("daylight"), "dayroom")
        .filter((node) => node.childNodes[0].textContent === name)
        .flatMap((node) => fields(node))
        .filter((entry) => entry.label === BLANK)[0].control,
    isReady: () => ready,
    blocks: () => byClass(document.getElementById("daylight"), "dayroom"),
    block: (name) =>
      byClass(document.getElementById("daylight"), "dayroom").filter(
        (node) => node.childNodes[0].textContent === name
      )[0],
  };
}

// Picks an option by value on a rendered select and fires its handler, the way
// a person choosing from the dropdown does.
function choose(select, value) {
  select.childNodes.forEach((option) => {
    option.selected = option.value === value;
  });
  select.value = value;
  select.onchange();
}

function typeInto(input, value) {
  input.value = String(value);
  input.onchange();
}

test("the page's markup carries every id its script looks up", () => {
  const html = fs.readFileSync(PAGE, "utf8");
  for (const id of PAGE_IDS) {
    assert.ok(html.includes(`id="${id}"`), `settings/index.html has no id="${id}"`);
  }
});

test("every translation key the page uses exists in both locales", () => {
  const html = fs.readFileSync(PAGE, "utf8");
  const en = JSON.parse(fs.readFileSync("locales/en.json", "utf8"));
  const fr = JSON.parse(fs.readFileSync("locales/fr.json", "utf8"));
  const lookup = (bundle, key) => key.split(".").reduce((at, part) => (at == null ? null : at[part]), bundle);

  const keys = new Set();
  for (const match of html.matchAll(/Homey\.__\("([^"]+)"\)/g)) keys.add(match[1]);
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);
  // Built by concatenation in renderDaylight; not findable as a literal.
  for (const name of ["dark", "bright", "swing"]) keys.add(`daylight.${name}`);

  assert.ok(keys.size > 20, `only found ${keys.size} keys, the scan must be broken`);
  for (const key of keys) {
    assert.ok(typeof lookup(en, key) === "string", `missing from en.json: ${key}`);
    assert.ok(typeof lookup(fr, key) === "string", `missing from fr.json: ${key}`);
  }
});

test("a fresh page renders a block per room, with only a source to pick", () => {
  const app = startPage();
  assert.strictEqual(app.blocks().length, 2);
  assert.ok(app.isReady(), "Homey.ready() must be called or the page never appears");
  assert.deepStrictEqual(
    fields(app.block("Bureau")).map((entry) => entry.label),
    ["daylight.source"],
    "a room with no source has nothing else to configure yet"
  );
});

// The bug that shipped: picking a source built the entry and saved it, the save
// was accepted, so the redraw was skipped and the boxes kept the disabled state
// they were built with when the room had no source.
test("picking a source immediately offers usable fields", () => {
  const app = startPage();
  const source = field(app.block("Bureau"), "daylight.source").control;
  choose(source, "lux");

  const shown = fields(app.block("Bureau"));
  assert.deepStrictEqual(
    shown.map((entry) => entry.label),
    ["daylight.source", "daylight.mode", "daylight.fulllux", BLANK],
    "hold is the default, so the room gets one level field and a Measure button"
  );

  const level = field(app.block("Bureau"), "daylight.fulllux").control;
  assert.notStrictEqual(level.disabled, true, "the field must be usable at once");
  assert.ok(Number(level.value) > 0, `the field must be filled in, got "${level.value}"`);
});

test("a newly configured room is stored as hold, and the app accepts it", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");
  assert.deepStrictEqual(app.state.daylight.bureau, {
    mode: "hold",
    source: "lux",
    fullLux: 20,
  });
});

test("switching mode swaps the fields and drops the other mode's values", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");
  choose(field(app.block("Bureau"), "daylight.mode").control, "follow");

  assert.deepStrictEqual(
    fields(app.block("Bureau")).map((entry) => entry.label),
    ["daylight.source", "daylight.mode", "daylight.dark", "daylight.bright", "daylight.swing"]
  );
  // Asserted on what the page SENT, not on what came back: validDaylight strips
  // the other mode's fields itself, so checking the stored result would let a
  // page that leaks them look correct.
  assert.deepStrictEqual(app.puts[app.puts.length - 1].daylight.bureau, {
    mode: "follow",
    source: "lux",
    dark: 1,
    bright: 100,
    swing: 0.2,
  });

  choose(field(app.block("Bureau"), "daylight.mode").control, "hold");
  assert.deepStrictEqual(
    app.puts[app.puts.length - 1].daylight.bureau,
    { mode: "hold", source: "lux", fullLux: 20 },
    "a stale anchor must not survive to change what the room does later"
  );
});

test("modelled daylight can only follow, and says so", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "modelled");
  const mode = field(app.block("Bureau"), "daylight.mode").control;
  assert.strictEqual(mode.disabled, true, "the model never sees the room, so it cannot hold");
  assert.strictEqual(app.state.daylight.bureau.mode, "follow");
  assert.strictEqual(app.state.daylight.bureau.dark, 200, "and gets the outdoor-scale anchors");
});

// Typing in one field fires a save, and a save used to rebuild the table —
// destroying the field the person had already tabbed into.
test("an accepted save leaves the field being typed in alone", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");
  const level = field(app.block("Bureau"), "daylight.fulllux").control;

  typeInto(level, 42);
  assert.strictEqual(app.state.daylight.bureau.fullLux, 42);
  assert.ok(contains(app.container, level), "the very same input must still be on the page");
});

test("a rejected save snaps the page back to what was actually stored", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");
  choose(field(app.block("Bureau"), "daylight.mode").control, "follow");

  // Inverted anchors: validDaylight refuses the whole entry, so the room ends
  // up with no daylight at all rather than a half-applied one.
  typeInto(field(app.block("Bureau"), "daylight.dark").control, 500);
  assert.strictEqual(app.state.daylight.bureau, undefined);
  assert.deepStrictEqual(
    fields(app.block("Bureau")).map((entry) => entry.label),
    ["daylight.source"],
    "the page must show the rejection, not keep displaying numbers nobody stored"
  );
});

test("an empty box means leave it alone, not zero", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");
  typeInto(field(app.block("Bureau"), "daylight.fulllux").control, "");
  assert.strictEqual(app.state.daylight.bureau.fullLux, 20, "the stored value must survive");
});

test("Measure writes what the sensor reads right now", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");

  // The room is lit properly between picking the source and pressing Measure.
  app.state.luxSources = [{ id: "lux", name: "Occupency bureau", value: 47.5 }];
  app.measureButton("Bureau").onclick();

  assert.strictEqual(app.state.daylight.bureau.fullLux, 47.5);
  assert.strictEqual(
    Number(field(app.block("Bureau"), "daylight.fulllux").control.value),
    47.5,
    "and the box shows it"
  );
});

test("Measure says so when the source has no reading", () => {
  const app = startPage();
  choose(field(app.block("Bureau"), "daylight.source").control, "lux");
  app.state.luxSources = [{ id: "lux", name: "Occupency bureau", value: null }];
  app.measureButton("Bureau").onclick();
  assert.deepStrictEqual(app.alerts, ["daylight.unread"]);
  assert.strictEqual(app.state.daylight.bureau.fullLux, 20, "and stores nothing");
});

test("a source that has been unpaired is shown as gone, not as unset", () => {
  const app = startPage({ daylight: { bureau: { mode: "hold", source: "ghost", fullLux: 30 } } });
  const source = field(app.block("Bureau"), "daylight.source").control;
  const selected = source.childNodes.filter((option) => option.selected);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].textContent, "daylight.missing");
  assert.strictEqual(selected[0].value, "ghost");
});

// The page PUTs whole maps, and they are empty until the GET lands. One failed
// read plus one click would otherwise wipe every mapping and every room's
// daylight settings.
test("a page whose read never landed refuses to save", () => {
  const app = startPage({ defaultsError: new Error("no route to host") });
  assert.deepStrictEqual(app.alerts, [new Error("no route to host")]);

  // The wipe needs an interaction, and the page leaves one wired: Fill in from
  // names is a single click that PUTs both whole maps.
  app.document.getElementById("autofill").onclick();
  assert.deepStrictEqual(app.puts, [], "nothing may be written from a page that knows nothing");
});

// A weather device replaced in place gets a new id, which is how this house's
// own one went. Showing "None" would suggest nothing was ever configured.
test("the weather picker shows a device that no longer resolves", () => {
  const app = startPage({ weather: "gone" });
  const selected = app.document
    .getElementById("weather")
    .childNodes.filter((option) => option.selected);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].textContent, "daylight.missing");
});

test("the weather picker selects a device that does resolve", () => {
  const app = startPage({ weather: "sky" });
  const selected = app.document
    .getElementById("weather")
    .childNodes.filter((option) => option.selected);
  assert.strictEqual(selected.length, 1);
  assert.ok(selected[0].textContent.indexOf("Gembloux Weather") === 0, selected[0].textContent);
});

test("a room already stored without a mode keeps following, and shows follow's fields", () => {
  const app = startPage({
    daylight: { bureau: { source: "lux", dark: 2, bright: 30, swing: 0.15 } },
  });
  assert.deepStrictEqual(
    fields(app.block("Bureau")).map((entry) => entry.label),
    ["daylight.source", "daylight.mode", "daylight.dark", "daylight.bright", "daylight.swing"],
    "an upgrade must not change the control law under a room that was working"
  );
  assert.strictEqual(Number(field(app.block("Bureau"), "daylight.dark").control.value), 2);
});

test("changing the source of a follow room does not silently flip it to hold", () => {
  const app = startPage({
    daylight: { bureau: { source: "lux", dark: 2, bright: 30, swing: 0.15 } },
  });
  choose(field(app.block("Bureau"), "daylight.source").control, "bath");
  assert.strictEqual(app.state.daylight.bureau.mode, "follow");
  assert.strictEqual(app.state.daylight.bureau.dark, 2, "and keeps the anchors it was tuned with");
});
