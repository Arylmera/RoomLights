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

function fakeApp({ zones, devices }) {
  const app = new RoomLights();
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
  assert.deepStrictEqual(registered, ["setroomlights", "setroomlightscolors"]);
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
