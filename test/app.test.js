"use strict";

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

// app.js requires "homey", which only exists inside Homey itself. Stub it (and
// homey-api) so the pure logic can be tested with plain node --test.
const homeyApiStub = { HomeyAPI: {} };
const load = Module._load;
Module._load = (request, ...rest) => {
  if (request === "homey") return { App: class { log() {} error() {} } };
  if (request === "homey-api") return homeyApiStub;
  return load(request, ...rest);
};
const RoomLights = require("../app.js");
Module._load = load;

function fakeApp({ zones, devices, roles }) {
  const app = new RoomLights();
  const stored = { lightRoles: roles || {} };
  app.homey = {
    settings: {
      get: (key) => stored[key],
      set: (key, value) => {
        stored[key] = value;
      },
    },
    setTimeout: () => {},
    clearTimeout: () => {},
  };
  app.homeyApi = {
    zones: { getZones: async () => zones },
    devices: { getDevices: async () => devices },
  };
  return app;
}

const light = (id, zone) => ({ id, zone, class: "light", capabilities: ["onoff", "dim"] });

test("app.js stays parseable on Node 12", () => {
  // app.json declares compatibility >=5.0.0, and Homey Pro (2016-2019) below
  // firmware v7.4.0 runs Node 12. These are Node 14+/15+ syntax, so they are a
  // load-time SyntaxError there — the app would not start at all.
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.ok(!/\?\./.test(source), "optional chaining (?.) needs Node 14");
  assert.ok(!/\?\?/.test(source), "nullish coalescing (?? / ??=) needs Node 14+");
});

test("parseHexToHSL converts the corners of the colour space", () => {
  const app = new RoomLights();
  assert.deepStrictEqual(app.parseHexToHSL("#000000"), [0, 0, 0]);
  assert.deepStrictEqual(app.parseHexToHSL("#ffffff"), [0, 0, 1]);
  assert.deepStrictEqual(app.parseHexToHSL("#ff0000"), [0, 1, 0.5]);
  assert.deepStrictEqual(app.parseHexToHSL("#00ff00"), [0.333, 1, 0.5]);
  assert.deepStrictEqual(app.parseHexToHSL("#0000ff"), [0.667, 1, 0.5]);
});

test("zones prefixed with _ are hidden from the room picker", async () => {
  const app = fakeApp({
    zones: { a: { id: "a", name: "Kitchen", parent: null }, b: { id: "b", name: "_hidden", parent: null } },
    devices: {},
  });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(app.zoneFilter, [{ id: "a", name: "Kitchen" }]);
});

test("a parent zone reaches the lights of its whole subtree", async () => {
  const app = fakeApp({
    zones: {
      house: { id: "house", name: "House", parent: null },
      floor: { id: "floor", name: "Upstairs", parent: "house" },
      room: { id: "room", name: "Bedroom", parent: "floor" },
    },
    devices: {
      1: light(1, "house"),
      2: light(2, "floor"),
      3: light(3, "room"),
    },
  });
  await app.buildRoomLightsZones();

  const ids = (zoneId) => app.roomLights({ id: zoneId }).map((d) => d.id).sort();
  assert.deepStrictEqual(ids("house"), [1, 2, 3], "grandchild lights must roll up to the top zone");
  assert.deepStrictEqual(ids("floor"), [2, 3]);
  assert.deepStrictEqual(ids("room"), [3]);
});

test("rebuilding does not duplicate zones or devices", async () => {
  const app = fakeApp({
    zones: { a: { id: "a", name: "Kitchen", parent: null } },
    devices: { 1: light(1, "a") },
  });
  await app.buildRoomLightsZones();
  await app.buildRoomLightsZones();
  assert.strictEqual(app.zoneFilter.length, 1);
  assert.strictEqual(app.roomLights({ id: "a" }).length, 1);
});

test("a zone with no lights is a no-op instead of a crash", async () => {
  const app = fakeApp({ zones: { a: { id: "a", name: "Hallway", parent: null } }, devices: {} });
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.5, 0.5);
  await app.setRoomLightsColors({ id: "unknown" }, 0.5, "#ff0000");
});

test("brightness 0 turns lights off, otherwise dim and temperature are applied", async () => {
  const calls = [];
  const bulb = {
    ...light(1, "a"),
    capabilities: ["onoff", "dim", "light_temperature"],
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({ zones: { a: { id: "a", name: "Kitchen", parent: null } }, devices: { 1: bulb } });
  await app.buildRoomLightsZones();

  await app.setLightsBrightness({ id: "a" }, 0.4, 0.7);
  assert.deepStrictEqual(calls, [["dim", 0.4], ["light_temperature", 0.7]]);

  calls.length = 0;
  await app.setLightsBrightness({ id: "a" }, 0, 0.7);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("a white bulb keeps its brightness when a colour is set", async () => {
  const calls = [];
  const white = {
    ...light(1, "a"),
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({ zones: { a: { id: "a", name: "Kitchen", parent: null } }, devices: { 1: white } });
  await app.buildRoomLightsZones();

  await app.setRoomLightsColors({ id: "a" }, 0.6, "#ff0000");
  assert.deepStrictEqual(calls, [["dim", 0.6]], "must not be switched off just for lacking light_hue");
});

test("a failed event subscription still leaves the Flow cards registered", async () => {
  const app = fakeApp({ zones: { a: { id: "a", name: "Kitchen", parent: null } }, devices: {} });
  const api = app.homeyApi;
  api.devices.connect = async () => {
    throw new Error("no socket");
  };
  api.zones.connect = async () => {};
  homeyApiStub.HomeyAPI.createAppAPI = async () => api;

  const registered = [];
  const card = {
    registerRunListener: () => card,
    registerArgumentAutocompleteListener: () => card,
  };
  app.homey = {
    flow: {
      getActionCard: (id) => {
        registered.push(id);
        return card;
      },
    },
    setTimeout: () => {},
    clearTimeout: () => {},
  };

  await app.onInit();
  assert.deepStrictEqual(registered, [
    "setroomlights",
    "setroomlightscolors",
    "setroomlightsrole",
    "setroomlightscolorsrole",
    "turnoffroomlights",
  ]);
});

test("argId accepts both a dropdown id string and a value object", () => {
  const app = new RoomLights();
  assert.strictEqual(app.argId("ambient"), "ambient");
  assert.strictEqual(app.argId({ id: "ambient" }), "ambient");
  assert.strictEqual(app.argId(null), null);
});

test("a colour bulb gets hue and saturation", async () => {
  const calls = [];
  const rgb = {
    ...light(1, "a"),
    capabilities: ["onoff", "dim", "light_hue", "light_saturation"],
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({ zones: { a: { id: "a", name: "Kitchen", parent: null } }, devices: { 1: rgb } });
  await app.buildRoomLightsZones();

  await app.setRoomLightsColors({ id: "a" }, 0.6, "#00ff00");
  assert.deepStrictEqual(calls, [["dim", 0.6], ["light_hue", 0.333], ["light_saturation", 1]]);
});

const roleZones = { a: { id: "a", name: "Salon", parent: null } };

// A factory, not a shared constant: tests mutate capabilitiesObj, and shared
// device objects would leak that mutation into every later test.
const roleDevices = () => ({
  1: { id: 1, zone: "a", class: "light", name: "spot", capabilities: ["onoff", "dim"] },
  2: { id: 2, zone: "a", class: "light", name: "strip", capabilities: ["onoff", "dim"] },
  3: { id: 3, zone: "a", class: "light", name: "circadian", capabilities: ["onoff", "dim"] },
});
const roleMap = { 2: "ambient", 3: "excluded" };

async function roleApp() {
  const app = fakeApp({ zones: roleZones, devices: roleDevices(), roles: roleMap });
  await app.buildRoomLightsZones();
  return app;
}

const idsOf = (lights) => lights.map((d) => d.id).sort();

test("role all returns every light except excluded ones", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "all", "all")), [1, 2]);
});

test("excluded is dropped even with no role argument at all", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" })), [1, 2]);
});

test("role main returns only lights with no stored role", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "main", "all")), [1]);
});

test("role ambient returns only ambient lights", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "ambient", "all")), [2]);
});

test("state on skips lights whose onoff is false", async () => {
  const app = await roleApp();
  app.myHome["a"].devices["light"][0].capabilitiesObj = { onoff: { value: false } };
  app.myHome["a"].devices["light"][1].capabilitiesObj = { onoff: { value: true } };
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "all", "on")), [2]);
});

test("a light with unknown onoff state is treated as on", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "all", "on")), [1, 2]);
});

test("a stale device id in lightRoles is ignored", async () => {
  const app = fakeApp({ zones: roleZones, devices: roleDevices(), roles: { 999: "excluded" } });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "all", "all")), [1, 2, 3]);
});

function recordingApp(capabilities, roles) {
  const calls = [];
  const bulb = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities,
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb },
    roles,
  });
  return { app, calls, bulb };
}

test("turnOn writes onoff true before the brightness", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, 0.5, { turnOn: true });
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4]]);
});

test("without turnOn the brightness is written alone", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, 0.5, {});
  assert.deepStrictEqual(calls, [["dim", 0.4]]);
});

test("brightness 0 turns off and never writes onoff true", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0, 0.5, { turnOn: true });
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("turnOffRoomLights switches off every light of the role", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.turnOffRoomLights({ id: "a" }, "all");
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("turnOffRoomLights leaves excluded lights alone", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"], { 1: "excluded" });
  await app.buildRoomLightsZones();
  await app.turnOffRoomLights({ id: "a" }, "all");
  assert.deepStrictEqual(calls, []);
});

const apiZones = {
  house: { id: "house", name: "Home", parent: null },
  salon: { id: "salon", name: "Salon", parent: "house" },
};
const apiDevices = () => ({
  1: { id: 1, zone: "salon", class: "light", name: "Salon spot 1", capabilities: ["onoff"] },
  2: { id: 2, zone: "house", class: "light", name: "Circadian Zone", capabilities: ["onoff"] },
});

test("getLightsByZone lists each light once, under its own zone", async () => {
  const app = fakeApp({ zones: apiZones, devices: apiDevices(), roles: { 2: "excluded" } });
  await app.buildRoomLightsZones();
  const byName = {};
  for (const zone of app.getLightsByZone()) {
    byName[zone.name] = zone.lights.map((l) => l.name + ":" + l.role).sort();
  }
  assert.deepStrictEqual(byName, {
    Home: ["Circadian Zone:excluded"],
    Salon: ["Salon spot 1:main"],
  });
});

test("setLightRoles keeps only valid roles for known lights", async () => {
  const app = fakeApp({ zones: apiZones, devices: apiDevices(), roles: {} });
  await app.buildRoomLightsZones();
  const saved = app.setLightRoles({ 1: "ambient", 2: "nonsense", 999: "excluded" });
  assert.deepStrictEqual(saved, { 1: "ambient" });
  assert.deepStrictEqual(app.lightRoles(), { 1: "ambient" });
});

test("setLightRoles drops main because it is the default", async () => {
  const app = fakeApp({ zones: apiZones, devices: apiDevices(), roles: { 1: "ambient" } });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(app.setLightRoles({ 1: "main" }), {});
});
