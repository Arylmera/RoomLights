"use strict";

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

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

function fakeApp({ zones, devices, roles, variables, defaults, offBelow, daylight, weatherDevice, geolocation }) {
  const app = new RoomLights();
  const stored = {
    lightRoles: roles || {},
    roomDefaults: defaults || {},
    offBelow,
    daylight: daylight || {},
    weatherDevice: weatherDevice || null,
  };
  app.homey = {
    settings: {
      // Real Homey settings are serialised in and out, so a caller that mutates
      // what it read changes nothing until it calls set(). Handing back the
      // live object instead would make every "it persists" assertion pass on a
      // code path that never saved — a stub wrong in the same direction as the
      // code it is meant to guard.
      get: (key) => (stored[key] === undefined ? undefined : structuredClone(stored[key])),
      set: (key, value) => {
        stored[key] = value;
      },
    },
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    // Gembloux, which is where the numbers in the daylight tests come from.
    // Pass null explicitly to test a Homey that cannot answer.
    geolocation:
      geolocation === undefined
        ? { getLatitude: () => 50.56, getLongitude: () => 4.69 }
        : geolocation,
  };
  app.homeyApi = {
    zones: { getZones: async () => zones },
    devices: { getDevices: async () => devices },
    logic: { getVariables: async () => variables || {} },
  };
  return app;
}

const light = (id, zone) => ({ id, zone, class: "light", capabilities: ["onoff", "dim"] });

test("parseHexToHSV converts the corners of the colour space", () => {
  const app = new RoomLights();
  assert.deepStrictEqual(app.parseHexToHSV("#000000"), [0, 0, 0]);
  assert.deepStrictEqual(app.parseHexToHSV("#ffffff"), [0, 0, 1]);
  assert.deepStrictEqual(app.parseHexToHSV("#ff0000"), [0, 1, 1]);
  assert.deepStrictEqual(app.parseHexToHSV("#00ff00"), [0.333, 1, 1]);
  assert.deepStrictEqual(app.parseHexToHSV("#0000ff"), [0.667, 1, 1]);
});

// The bug this replaced: HSL saturation is 1.0 for any pale colour, so every
// pastel the colour picker offered arrived at the bulb fully saturated.
test("a pastel keeps its saturation instead of arriving as pure red", () => {
  const app = new RoomLights();
  assert.deepStrictEqual(app.parseHexToHSV("#ffc0c0"), [0, 0.247, 1]);
});

test("a muted colour keeps its saturation", () => {
  const app = new RoomLights();
  assert.deepStrictEqual(app.parseHexToHSV("#804040"), [0, 0.5, 0.502]);
});

test("a malformed colour is refused instead of writing NaN to a bulb", () => {
  const app = new RoomLights();
  for (const bad of [null, undefined, "", "#fff", "red", "#gggggg", "#ff00ff00", 16711680]) {
    assert.throws(() => app.parseHexToHSV(bad), /not a colour/i, "accepted " + String(bad));
  }
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

  const ids = async (zoneId) => (await app.roomLights({ id: zoneId })).map((d) => d.id).sort();
  assert.deepStrictEqual(await ids("house"), [1, 2, 3], "grandchild lights must roll up to the top zone");
  assert.deepStrictEqual(await ids("floor"), [2, 3]);
  assert.deepStrictEqual(await ids("room"), [3]);
});

test("rebuilding does not duplicate zones or devices", async () => {
  const app = fakeApp({
    zones: { a: { id: "a", name: "Kitchen", parent: null } },
    devices: { 1: light(1, "a") },
  });
  await app.buildRoomLightsZones();
  await app.buildRoomLightsZones();
  assert.strictEqual(app.zoneFilter.length, 1);
  assert.strictEqual((await app.roomLights({ id: "a" })).length, 1);
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
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4], ["light_temperature", 0.7]]);

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
  assert.deepStrictEqual(
    calls,
    [["onoff", true], ["dim", 0.6]],
    "must not be switched off just for lacking light_hue"
  );
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
    // Keep the settings manager from fakeApp: onInit builds the zone map, which
    // prunes snapshots, and the real homey always has settings.
    settings: app.homey.settings,
    flow: {
      getActionCard: (id) => {
        registered.push(id);
        return card;
      },
      getConditionCard: (id) => {
        registered.push("condition:" + id);
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
    "condition:anyroomlightson",
    "dimroomlights",
    "toggleroomlights",
    "saveroomlights",
    "restoreroomlights",
    "setroomlightsauto",
    "stopdaylighttracking",
  ]);
});

// The rebuild is the only house-wide read that happens without a card running,
// so both what triggers it and when it fires have to be pinned down.
async function watchApp() {
  const timers = [];
  const handlers = {};
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: { id: 1, zone: "a", class: "light", name: "spot", capabilities: ["onoff"] } },
  });
  app.homey.setTimeout = (fn, ms) => {
    const timer = { fn, ms };
    timers.push(timer);
    return timer;
  };
  app.homey.clearTimeout = () => {};
  app.homeyApi.devices.connect = async () => {};
  app.homeyApi.zones.connect = async () => {};
  app.homeyApi.devices.on = (event, handler) => {
    handlers[event] = handler;
  };
  app.homeyApi.zones.on = (event, handler) => {
    handlers[event] = handler;
  };
  await app.buildRoomLightsZones();
  await app.watchForChanges();
  return { app, timers, handlers };
}

test("a capability change on a known device does not trigger a rebuild", async () => {
  const { timers, handlers } = await watchApp();
  // What a dimming light or a power meter emits, several times a second.
  handlers["device.update"]({ id: 1, zone: "a", class: "light", name: "spot" });
  handlers["device.update"]({ id: 1, zone: "a", class: "light", name: "spot" });
  assert.deepStrictEqual(timers, [], "a fading light must not schedule a house-wide read");
});

test("moving, renaming or reclassing a device does trigger a rebuild", async () => {
  const moved = { id: 1, zone: "b", class: "light", name: "spot" };
  const renamed = { id: 1, zone: "a", class: "light", name: "ceiling" };
  const reclassed = { id: 1, zone: "a", class: "socket", name: "spot" };
  const added = { id: 2, zone: "a", class: "light", name: "strip" };
  for (const device of [moved, renamed, reclassed, added]) {
    const { timers, handlers } = await watchApp();
    handlers["device.update"](device);
    assert.strictEqual(timers.length, 1, JSON.stringify(device) + " must schedule a rebuild");
  }
});

test("an unrecognisable event payload rebuilds rather than risk going stale", async () => {
  // homey-api forwards the raw server payload when the device is not in its
  // own cache, so a partial one must never be read as "nothing changed".
  const partials = [undefined, null, {}, { id: 1 }, { id: 1, class: "light" }, { id: 1, zone: "a" }];
  for (const payload of partials) {
    const { timers, handlers } = await watchApp();
    handlers["device.update"](payload);
    assert.strictEqual(timers.length, 1, JSON.stringify(payload) + " must schedule a rebuild");
  }
});

test("creating or deleting a device or zone always rebuilds", async () => {
  for (const event of ["device.create", "device.delete"]) {
    const { timers, handlers } = await watchApp();
    handlers[event]({ id: 9 });
    assert.strictEqual(timers.length, 1, event + " must schedule a rebuild");
  }
  for (const event of ["zone.create", "zone.delete", "zone.update"]) {
    const { timers, handlers } = await watchApp();
    handlers[event]({ id: "z" });
    assert.strictEqual(timers.length, 1, event + " must schedule a rebuild");
  }
});

test("the first event waits the full debounce and opens a deadline", async () => {
  const { app, timers } = await watchApp();
  app.scheduleRebuild();
  assert.strictEqual(timers.at(-1).ms, 5000);
  assert.ok(app.rebuildDeadline > Date.now());
});

test("a stream of events cannot defer the rebuild forever", async () => {
  const { app, timers } = await watchApp();
  app.scheduleRebuild();
  const deadline = app.rebuildDeadline;
  app.scheduleRebuild();
  app.scheduleRebuild();
  assert.strictEqual(app.rebuildDeadline, deadline, "later events must not push the deadline back");

  // Once the deadline is closer than the debounce, the wait shrinks to meet it.
  app.rebuildDeadline = Date.now() + 800;
  app.scheduleRebuild();
  assert.ok(timers.at(-1).ms <= 800 && timers.at(-1).ms > 0, "must not schedule past the deadline");

  app.rebuildDeadline = Date.now() - 1;
  app.scheduleRebuild();
  assert.strictEqual(timers.at(-1).ms, 0, "an expired deadline rebuilds now");
});

test("the rebuild clears the deadline so the next burst gets a fresh one", async () => {
  const { app, timers } = await watchApp();
  app.scheduleRebuild();
  await timers.at(-1).fn();
  assert.strictEqual(app.rebuildDeadline, null);
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
  assert.deepStrictEqual(calls, [
    ["onoff", true],
    ["dim", 0.6],
    ["light_hue", 0.333],
    ["light_saturation", 1],
  ]);
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
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" }, "all", "all")), [1, 2]);
});

test("excluded is dropped even with no role argument at all", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" })), [1, 2]);
});

test("role main returns only lights with no stored role", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" }, "main", "all")), [1]);
});

test("role ambient returns only ambient lights", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" }, "ambient", "all")), [2]);
});

test("state on skips lights whose onoff is false", async () => {
  const app = await roleApp();
  app.myHome["a"].devices["light"][0].capabilitiesObj = { onoff: { value: false } };
  app.myHome["a"].devices["light"][1].capabilitiesObj = { onoff: { value: true } };
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" }, "all", "on")), [2]);
});

test("a light with unknown onoff state is treated as on", async () => {
  const app = await roleApp();
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" }, "all", "on")), [1, 2]);
});

test("a stale device id in lightRoles is ignored", async () => {
  const app = fakeApp({ zones: roleZones, devices: roleDevices(), roles: { 999: "excluded" } });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(idsOf(await app.roomLights({ id: "a" }, "all", "all")), [1, 2, 3]);
});

// anyLightsOn backs the condition card and the toggle. It must respect the
// role filter and the excluded role, and read live state, not the snapshot.
test("anyLightsOn is true only when a light of that role is on", async () => {
  const app = await roleApp();
  // Live state: main spot (1) off, ambient strip (2) on, excluded (3) on.
  app.homeyApi.devices.getDevices = async () => ({
    1: { id: 1, zone: "a", class: "light", capabilities: ["onoff"], capabilitiesObj: { onoff: { value: false } } },
    2: { id: 2, zone: "a", class: "light", capabilities: ["onoff"], capabilitiesObj: { onoff: { value: true } } },
    3: { id: 3, zone: "a", class: "light", capabilities: ["onoff"], capabilitiesObj: { onoff: { value: true } } },
  });
  assert.strictEqual(await app.anyLightsOn({ id: "a" }, "ambient"), true);
  assert.strictEqual(await app.anyLightsOn({ id: "a" }, "main"), false);
  assert.strictEqual(await app.anyLightsOn({ id: "a" }, "all"), true);
});

test("anyLightsOn ignores excluded lights even when they are on", async () => {
  const app = await roleApp();
  app.homeyApi.devices.getDevices = async () => ({
    1: { id: 1, zone: "a", class: "light", capabilities: ["onoff"], capabilitiesObj: { onoff: { value: false } } },
    2: { id: 2, zone: "a", class: "light", capabilities: ["onoff"], capabilitiesObj: { onoff: { value: false } } },
    3: { id: 3, zone: "a", class: "light", capabilities: ["onoff"], capabilitiesObj: { onoff: { value: true } } },
  });
  assert.strictEqual(await app.anyLightsOn({ id: "a" }, "all"), false);
});

function recordingApp(capabilities, roles, offBelow) {
  const calls = [];
  const bulb = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities,
    // homey-api takes the fade as a third `opts` argument. Record it only when
    // there is one, so the plain writes stay two-element.
    setCapabilityValue: async (cap, value, opts) =>
      calls.push(opts === undefined ? [cap, value] : [cap, value, opts]),
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb },
    roles,
    offBelow,
  });
  return { app, calls, bulb };
}

test("onoff true is written before the brightness", async () => {
  // Writing dim alone leaves a light that was off in a device-dependent state:
  // some bulbs come on, some stay dark. Setting a brightness means "on".
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, 0.5);
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4]]);
});

test("brightness 0 turns off and never writes onoff true", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0, 0.5);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

// A circadian formula reaches "dark" as a small float, not as an exact 0, so
// an equality check let 1-3% through and the room glowed instead of going out.
test("a brightness below the threshold turns off instead of glowing", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.0345, 0.5);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("a brightness above the threshold is still applied normally", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.06, null);
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.06]]);
});

test("the threshold is inclusive, so a brightness exactly on it means off", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"], null, 0.1);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.1, null);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

// The inclusive comparison is what makes 0 a working "disable": there is no
// separate flag, and the app behaves exactly as it did before the threshold.
test("a threshold of 0 turns lights off only at exactly zero", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"], null, 0);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.01, null);
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.01]]);
});

// A corrupted setting must never be the reason the app stops turning lights
// off, so it falls back to the default rather than to 0.
test("an unusable stored threshold falls back to the default", async () => {
  for (const broken of [null, undefined, "0.05", NaN, Infinity, -0.1, 1.5]) {
    const { app } = recordingApp(["onoff", "dim"], null, broken);
    assert.strictEqual(app.offBelow(), 0.05, `${String(broken)} should not be trusted`);
  }
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

// A dead bulb is the normal state of a Zigbee/Z-Wave room, not an exception.
// The card must still reach every other light and must not fail the Flow.
function flakyApp(deadIds) {
  const calls = [];
  const bulb = (id) => ({
    id,
    zone: "a",
    class: "light",
    name: "spot " + id,
    capabilities: ["onoff", "dim"],
    setCapabilityValue: async (cap, value) => {
      if (deadIds.includes(id)) throw new Error("device " + id + " unreachable");
      calls.push([id, cap, value]);
    },
  });
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb(1), 2: bulb(2) },
  });
  const errors = [];
  app.error = (...args) => errors.push(args);
  return { app, calls, errors };
}

test("one unreachable bulb does not stop the others or fail the card", async () => {
  const { app, calls, errors } = flakyApp([1]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, null);
  assert.deepStrictEqual(calls, [[2, "onoff", true], [2, "dim", 0.4]]);
  assert.strictEqual(errors.length, 1, "the unreachable light must be logged, not swallowed");
});

test("the card fails only when every light is unreachable", async () => {
  const { app, calls } = flakyApp([1, 2]);
  await app.buildRoomLightsZones();
  await assert.rejects(() => app.setLightsBrightness({ id: "a" }, 0.4, null), /unreachable/);
  assert.deepStrictEqual(calls, []);
});

test("turning off tolerates one unreachable bulb", async () => {
  const { app, calls } = flakyApp([1]);
  await app.buildRoomLightsZones();
  await app.turnOffRoomLights({ id: "a" }, "all");
  assert.deepStrictEqual(calls, [[2, "onoff", false]]);
});

test("a room with no lights at all is not an error", async () => {
  const { app } = flakyApp([]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "nowhere" }, 0.4, null);
});

test("a duration turns the dim write into a fade", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, 0.5, { duration: 3000 });
  // onoff stays instant — fading onoff is device-dependent; the dim carries
  // the duration. It must be nested under opts: homey-api reads the fade from
  // opts.duration and silently drops a duration passed beside the value.
  assert.deepStrictEqual(calls, [
    ["onoff", true],
    ["dim", 0.4, { duration: 3000 }],
  ]);
});

test("brightness 0 with a duration fades to off", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0, 0.5, { duration: 3000 });
  assert.deepStrictEqual(calls, [["onoff", false, { duration: 3000 }]]);
});

test("a fade carries the temperature with it instead of snapping", async () => {
  const { app, calls } = recordingApp(["onoff", "dim", "light_temperature"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, 0.7, { duration: 3000 });
  assert.deepStrictEqual(calls, [
    ["onoff", true],
    ["dim", 0.4, { duration: 3000 }],
    ["light_temperature", 0.7, { duration: 3000 }],
  ]);
});

test("a fade carries the colour with it instead of snapping", async () => {
  const { app, calls } = recordingApp(["onoff", "dim", "light_hue", "light_saturation"]);
  await app.buildRoomLightsZones();
  await app.setRoomLightsColors({ id: "a" }, 0.6, "#00ff00", { duration: 2000 });
  assert.deepStrictEqual(calls, [
    ["onoff", true],
    ["dim", 0.6, { duration: 2000 }],
    ["light_hue", 0.333, { duration: 2000 }],
    ["light_saturation", 1, { duration: 2000 }],
  ]);
});

test("no duration keeps the plain positional writes", async () => {
  const { app, calls } = recordingApp(["onoff", "dim"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, 0.5, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4]]);
});

test("a null temperature is simply not written", async () => {
  const { app, calls } = recordingApp(["onoff", "dim", "light_temperature"]);
  await app.buildRoomLightsZones();
  await app.setLightsBrightness({ id: "a" }, 0.4, null, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4]]);
});

// One fresh read backs the whole relative-dim run: current onoff and dim come
// from the same getDevices() call, never from the myHome snapshot. The fresh
// objects spread the recording bulb because buildRoomLightsZones() reads them
// too — a stub without setCapabilityValue would make every write throw.
function dimApp(capabilitiesObj, offBelow) {
  const calls = [];
  const bulb = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities: ["onoff", "dim"],
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb },
    offBelow,
  });
  app.homeyApi.devices.getDevices = async () => ({ 1: { ...bulb, capabilitiesObj } });
  return { app, calls };
}

test("dim up raises the brightness and clamps at 1", async () => {
  const { app, calls } = dimApp({ onoff: { value: true }, dim: { value: 0.9 } });
  await app.buildRoomLightsZones();
  await app.dimRoomLights({ id: "a" }, "all", "up", 0.2);
  assert.deepStrictEqual(calls, [["dim", 1]]);
});

test("dim down to zero turns the light off instead of dim 0", async () => {
  const { app, calls } = dimApp({ onoff: { value: true }, dim: { value: 0.1 } });
  await app.buildRoomLightsZones();
  await app.dimRoomLights({ id: "a" }, "all", "down", 0.2);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

// Without the threshold here, holding "down" on a wall button stalls at a glow
// instead of arriving at off.
test("dimming down into the threshold turns the light off", async () => {
  const { app, calls } = dimApp({ onoff: { value: true }, dim: { value: 0.08 } });
  await app.buildRoomLightsZones();
  await app.dimRoomLights({ id: "a" }, "all", "down", 0.05);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("relative dim leaves lights that are off untouched", async () => {
  const { app, calls } = dimApp({ onoff: { value: false }, dim: { value: 0.5 } });
  await app.buildRoomLightsZones();
  await app.dimRoomLights({ id: "a" }, "all", "up", 0.2);
  assert.deepStrictEqual(calls, []);
});

test("relative dim skips a light whose dim value is unreadable", async () => {
  const { app, calls } = dimApp({ onoff: { value: true } });
  await app.buildRoomLightsZones();
  await app.dimRoomLights({ id: "a" }, "all", "up", 0.2);
  assert.deepStrictEqual(calls, []);
});

function toggleApp(onoffValue) {
  const calls = [];
  const bulb = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities: ["onoff", "dim", "light_temperature"],
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb },
  });
  app.homeyApi.devices.getDevices = async () => ({
    1: { ...bulb, capabilitiesObj: { onoff: { value: onoffValue } } },
  });
  return { app, calls };
}

test("toggle turns everything off when any light is on", async () => {
  const { app, calls } = toggleApp(true);
  await app.buildRoomLightsZones();
  await app.toggleRoomLights({ id: "a" }, "all", 0.6);
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("toggle turns the lights on at the given brightness, without touching temperature", async () => {
  const { app, calls } = toggleApp(false);
  await app.buildRoomLightsZones();
  await app.toggleRoomLights({ id: "a" }, "all", 0.6);
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.6]]);
});

// Reading devices is a full house dump over the local API. These tests pin the
// number of reads, because the cost is invisible from the outside.
function countingApp(onoffValue) {
  let reads = 0;
  const calls = [];
  const bulb = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities: ["onoff", "dim"],
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb },
  });
  const state = { 1: { ...bulb, capabilitiesObj: { onoff: { value: onoffValue } } } };
  app.homeyApi.devices.getDevices = async () => {
    reads += 1;
    return state;
  };
  return { app, calls, reads: () => reads };
}

test("a burst of cards shares one device read", async () => {
  const { app, reads } = countingApp(true);
  await app.buildRoomLightsZones();
  const before = reads();
  await app.anyLightsOn({ id: "a" }, "all");
  await app.anyLightsOn({ id: "a" }, "all");
  await app.anyLightsOn({ id: "a" }, "all");
  assert.strictEqual(reads() - before, 1, "a held wall button must not dump the house once per repeat");
});

test("concurrent reads are deduped onto a single request", async () => {
  const { app, reads } = countingApp(true);
  await app.buildRoomLightsZones();
  const before = reads();
  await Promise.all([app.anyLightsOn({ id: "a" }, "all"), app.anyLightsOn({ id: "a" }, "all")]);
  assert.strictEqual(reads() - before, 1);
});

test("our own write drops the cache so the next read is fresh", async () => {
  const { app, reads } = countingApp(true);
  await app.buildRoomLightsZones();
  const before = reads();
  await app.anyLightsOn({ id: "a" }, "all");
  await app.turnOffRoomLights({ id: "a" }, "all");
  await app.anyLightsOn({ id: "a" }, "all");
  assert.strictEqual(reads() - before, 2, "a card must never be answered from state it just invalidated");
});

// While the realtime subscription is down — which this app tolerates — a device
// read is a real round-trip, so a write can complete while one is in flight.
// That read carries pre-write state and must not survive the write.
function racyApp() {
  const truth = { on: true, hold: null };
  const bulb = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities: ["onoff", "dim"],
    setCapabilityValue: async (cap, value) => {
      if (cap === "onoff") truth.on = value;
    },
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: bulb },
  });
  app.homeyApi.devices.getDevices = () => {
    // Snapshot what is true at call time; deliver it whenever the test allows.
    const snapshot = { 1: { ...bulb, capabilitiesObj: { onoff: { value: truth.on } } } };
    return truth.hold == null ? Promise.resolve(snapshot) : truth.hold.then(() => snapshot);
  };
  return { app, truth };
}

test("a read started before our write is never served to a card that ran after it", async () => {
  const { app, truth } = racyApp();
  await app.buildRoomLightsZones();

  let land;
  truth.hold = new Promise((resolve) => {
    land = resolve;
  });
  const early = app.anyLightsOn({ id: "a" }, "all"); // captures on: true, then waits
  truth.hold = null;

  await app.turnOffRoomLights({ id: "a" }, "all"); // the room is off now
  land();
  assert.strictEqual(await early, true, "the early read legitimately saw the pre-write state");

  assert.strictEqual(
    await app.anyLightsOn({ id: "a" }, "all"),
    false,
    "a read that predates the write must not be reused, nor land in the cache, after it"
  );
});

test("a rejected read is retried rather than joined forever", async () => {
  const { app } = racyApp();
  await app.buildRoomLightsZones();

  let fail = true;
  app.homeyApi.devices.getDevices = async () => {
    if (fail) throw new Error("no route to host");
    return { 1: { id: 1, capabilitiesObj: { onoff: { value: true } } } };
  };
  await assert.rejects(() => app.anyLightsOn({ id: "a" }, "all"), /no route/);

  fail = false;
  assert.strictEqual(await app.anyLightsOn({ id: "a" }, "all"), true, "must retry, not replay the rejection");
});

test("a rebuild drops the cache", async () => {
  const { app, reads } = countingApp(true);
  await app.buildRoomLightsZones();
  await app.anyLightsOn({ id: "a" }, "all");
  const before = reads();
  await app.buildRoomLightsZones();
  await app.anyLightsOn({ id: "a" }, "all");
  assert.strictEqual(reads() - before, 2, "the rebuild read, then a fresh read for the card");
});

function snapshotApp() {
  const calls = [];
  const caps = ["onoff", "dim", "light_hue", "light_saturation"];
  const record = (id) => async (cap, value) => calls.push([id, cap, value]);
  const spot = { id: 1, zone: "a", class: "light", name: "spot", capabilities: caps, setCapabilityValue: record(1) };
  const strip = { id: 2, zone: "a", class: "light", name: "strip", capabilities: caps, setCapabilityValue: record(2) };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: spot, 2: strip },
  });
  // Live state at save time: spot on and warm, strip off.
  app.homeyApi.devices.getDevices = async () => ({
    1: {
      ...spot,
      capabilitiesObj: { onoff: { value: true }, dim: { value: 0.4 }, light_hue: { value: 0.1 }, light_saturation: { value: 1 } },
    },
    2: {
      ...strip,
      capabilitiesObj: { onoff: { value: false }, dim: { value: 0.8 } },
    },
  });
  return { app, calls };
}

test("restore replays the saved state of every light", async () => {
  const { app, calls } = snapshotApp();
  await app.buildRoomLightsZones();
  await app.saveRoomLights({ id: "a" });
  await app.restoreRoomLights({ id: "a" });
  assert.deepStrictEqual(calls.sort(), [
    [1, "dim", 0.4],
    [1, "light_hue", 0.1],
    [1, "light_saturation", 1],
    [1, "onoff", true],
    [2, "onoff", false],
  ].sort());
});

test("restore without a snapshot fails the card instead of doing nothing", async () => {
  const { app, calls } = snapshotApp();
  await app.buildRoomLightsZones();
  await assert.rejects(() => app.restoreRoomLights({ id: "a" }), /save card/);
  assert.deepStrictEqual(calls, []);
});

test("a deleted room takes its snapshot with it", async () => {
  const { app } = snapshotApp();
  await app.buildRoomLightsZones();
  await app.saveRoomLights({ id: "a" });
  app.homey.settings.set("lightSnapshots", {
    ...app.homey.settings.get("lightSnapshots"),
    gone: { 7: { onoff: true } },
  });

  await app.buildRoomLightsZones();
  assert.deepStrictEqual(Object.keys(app.homey.settings.get("lightSnapshots")), ["a"]);
});

test("a failed zone read never wipes the snapshots", async () => {
  const { app } = snapshotApp();
  await app.buildRoomLightsZones();
  await app.saveRoomLights({ id: "a" });

  // Homey answers with no zones at all. That is a broken read, not an empty
  // house, and it must not be treated as "every room was deleted".
  app.homeyApi.zones.getZones = async () => ({});
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(Object.keys(app.homey.settings.get("lightSnapshots")), ["a"]);
});

test("a light removed after the save is skipped on restore", async () => {
  const { app, calls } = snapshotApp();
  await app.buildRoomLightsZones();
  await app.saveRoomLights({ id: "a" });
  // The strip disappears from the zone before the restore.
  app.myHome["a"].devices["light"] = app.myHome["a"].devices["light"].filter((d) => d.id !== 2);
  await app.restoreRoomLights({ id: "a" });
  assert.ok(calls.every((c) => c[0] === 1), "only the surviving light may be written to");
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

test("the state filter reads fresh device state, not the cached snapshot", async () => {
  const snapshot = {
    id: 1,
    zone: "a",
    class: "light",
    name: "spot",
    capabilities: ["onoff"],
    capabilitiesObj: { onoff: { value: true } },
  };
  const app = fakeApp({
    zones: { a: { id: "a", name: "Salon", parent: null } },
    devices: { 1: snapshot },
    roles: {},
  });
  await app.buildRoomLightsZones();

  // Homey now reports the light as off while the object cached in myHome still
  // says on — exactly the stale-cache case that would make the filter wrong.
  app.homeyApi.devices.getDevices = async () => ({
    1: {
      id: 1,
      zone: "a",
      class: "light",
      capabilities: ["onoff"],
      capabilitiesObj: { onoff: { value: false } },
    },
  });

  assert.deepStrictEqual(await app.roomLights({ id: "a" }, "all", "on"), []);
  assert.strictEqual((await app.roomLights({ id: "a" }, "all", "all")).length, 1);
});

// The automatic card carries no values of its own: it reads the Logic
// variables the room is mapped to in the settings, then takes the ordinary
// set-lights path.
const salonVariables = () => ({
  b: { id: "b", name: "Salon - Brightness", type: "number", value: 0.4 },
  t: { id: "t", name: "Salon - Temp", type: "number", value: 0.7 },
  s: { id: "s", name: "Salon - Scene", type: "string", value: "Auto" },
});
const salonMapping = { salon: { brightness: "b", temperature: "t" } };

function autoApp(variables, defaults) {
  const calls = [];
  const bulb = {
    id: 1,
    zone: "salon",
    class: "light",
    name: "spot",
    capabilities: ["onoff", "dim", "light_temperature"],
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const app = fakeApp({
    zones: { salon: { id: "salon", name: "Salon", parent: null } },
    devices: { 1: bulb },
    variables,
    defaults,
  });
  return { app, calls };
}

const salon = { id: "salon", name: "Salon" };

test("the automatic card applies the mapped brightness and temperature", async () => {
  const { app, calls } = autoApp(salonVariables(), salonMapping);
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salon, { role: "all", state: "all" });
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4], ["light_temperature", 0.7]]);
});

test("a room with no temperature mapped keeps the tint it had", async () => {
  const { app, calls } = autoApp(salonVariables(), { salon: { brightness: "b" } });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salon, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4]]);
});

test("a mapped brightness of 0 still means off", async () => {
  const variables = salonVariables();
  variables.b.value = 0;
  const { app, calls } = autoApp(variables, salonMapping);
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salon, {});
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

// Doing nothing here would look exactly like a broken card, so it fails and
// says which room to go and fix.
test("an unmapped room fails the card by name", async () => {
  const { app, calls } = autoApp(salonVariables(), {});
  await app.buildRoomLightsZones();
  await assert.rejects(() => app.setRoomLightsAuto(salon, {}), /brightness variable mapped for Salon/);
  assert.deepStrictEqual(calls, []);
});

test("a deleted or retyped brightness variable fails the card", async () => {
  // A Logic variable can be deleted or turned into text at any time, and the
  // mapping only holds its id.
  const gone = salonVariables();
  delete gone.b;
  const text = salonVariables();
  text.b = { id: "b", name: "Salon - Brightness", type: "string", value: "bright" };
  for (const variables of [gone, text]) {
    const { app, calls } = autoApp(variables, salonMapping);
    await app.buildRoomLightsZones();
    await assert.rejects(() => app.setRoomLightsAuto(salon, {}), /brightness variable mapped/);
    assert.deepStrictEqual(calls, []);
  }
});

test("a temperature that went missing leaves the brightness working", async () => {
  const variables = salonVariables();
  delete variables.t;
  const { app, calls } = autoApp(variables, salonMapping);
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salon, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.4]]);
});

test("a value outside 0-1 is clamped instead of reaching the bulb", async () => {
  const variables = salonVariables();
  variables.b.value = 1.4;
  variables.t.value = -0.2;
  const { app, calls } = autoApp(variables, salonMapping);
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salon, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 1], ["light_temperature", 0]]);
});

test("a burst of automatic cards shares one variable read", async () => {
  const { app } = autoApp(salonVariables(), salonMapping);
  let reads = 0;
  const variables = salonVariables();
  app.homeyApi.logic.getVariables = async () => {
    reads += 1;
    return variables;
  };
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salon, {});
  await app.setRoomLightsAuto(salon, {});
  await Promise.all([app.setRoomLightsAuto(salon, {}), app.setRoomLightsAuto(salon, {})]);
  assert.strictEqual(reads, 1, "a held wall button must not read the variables once per repeat");
});

test("a rejected variable read is retried rather than joined forever", async () => {
  const { app } = autoApp(salonVariables(), salonMapping);
  await app.buildRoomLightsZones();
  let fail = true;
  app.homeyApi.logic.getVariables = async () => {
    if (fail) throw new Error("no route to host");
    return salonVariables();
  };
  await assert.rejects(() => app.setRoomLightsAuto(salon, {}), /no route/);
  fail = false;
  await app.setRoomLightsAuto(salon, {});
});

test("the settings page is offered the picker rooms and only number variables", async () => {
  const { app } = autoApp(salonVariables(), salonMapping);
  await app.buildRoomLightsZones();
  const page = await app.getRoomDefaultsPage();
  assert.deepStrictEqual(page.rooms, [{ id: "salon", name: "Salon" }]);
  assert.deepStrictEqual(page.variables, [
    { id: "b", name: "Salon - Brightness" },
    { id: "t", name: "Salon - Temp" },
  ]);
  assert.deepStrictEqual(page.mappings, salonMapping);
});

test("setRoomDefaults keeps only known rooms and number variables", async () => {
  const { app } = autoApp(salonVariables(), {});
  await app.buildRoomLightsZones();
  const saved = await app.setRoomDefaults({
    mappings: {
      salon: { brightness: "b", temperature: "s" }, // scene is text, not a temperature
      nowhere: { brightness: "b" },
    },
  });
  assert.deepStrictEqual(saved.mappings, { salon: { brightness: "b" } });
  assert.deepStrictEqual(app.roomDefaults(), { salon: { brightness: "b" } });
});

test("a room mapped to a temperature but no brightness is not stored", async () => {
  const { app } = autoApp(salonVariables(), {});
  await app.buildRoomLightsZones();
  const saved = await app.setRoomDefaults({ mappings: { salon: { temperature: "t" } } });
  assert.deepStrictEqual(saved.mappings, {});
});

test("the threshold rides along on the same save as the mappings", async () => {
  const { app } = autoApp(salonVariables(), {});
  await app.buildRoomLightsZones();
  await app.setRoomDefaults({ mappings: {}, offBelow: 0.2 });
  assert.strictEqual(app.offBelow(), 0.2);

  const saved = await app.setRoomDefaults({ mappings: {}, offBelow: "loads" });
  assert.strictEqual(app.offBelow(), 0.2, "a bad save must leave the good value alone");
  assert.strictEqual(saved.offBelow, 0.2, "the page is told what was actually kept");
});

test("the settings page is told the current threshold", async () => {
  const { app } = autoApp(salonVariables(), salonMapping);
  await app.buildRoomLightsZones();
  assert.strictEqual((await app.getRoomDefaultsPage()).offBelow, 0.05);
});

test("a deleted room takes its mapping with it, a failed zone read does not", async () => {
  const { app } = autoApp(salonVariables(), { ...salonMapping, gone: { brightness: "b" } });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(Object.keys(app.roomDefaults()), ["salon"]);

  app.homeyApi.zones.getZones = async () => ({});
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(Object.keys(app.roomDefaults()), ["salon"], "a broken read is not an empty house");
});

test("lights in a hidden zone are still manageable from the settings page", async () => {
  // "_" hides a zone from the room picker, not from role management. If the
  // settings page cannot see these lights it cannot send them back, and the
  // whole-map PUT would wipe their roles on any unrelated edit.
  const app = fakeApp({
    zones: {
      home: { id: "home", name: "Home", parent: null },
      hidden: { id: "hidden", name: "_Salon", parent: "home" },
    },
    devices: {
      1: { id: 1, zone: "hidden", class: "light", name: "Buffet Strip", capabilities: ["onoff"] },
    },
    roles: { 1: "excluded" },
  });
  await app.buildRoomLightsZones();

  const zones = app.getLightsByZone();
  const names = zones.map((z) => z.name).sort();
  assert.ok(names.includes("_Salon"), "a hidden zone with lights must still be listed");

  const hidden = zones.find((z) => z.name === "_Salon");
  assert.deepStrictEqual(hidden.lights, [{ id: 1, name: "Buffet Strip", role: "excluded" }]);

  // The hidden zone stays out of the room picker.
  assert.deepStrictEqual(app.zoneFilter.map((z) => z.name), ["Home"]);
});

// ---------------------------------------------------------------------- daylight

const daylight = require("../lib/daylight.js");

// One decade either side of 10 lx, so the geometric mean is a round number and
// every expectation below can be read off by hand.
const anchors = { source: "lux", dark: 1, bright: 100, swing: 0.2 };

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: got ${actual}, wanted ${expected}`);

test("the dark anchor runs the room at the circadian value plus the swing", () => {
  near(daylight.daylightBrightness(0.5, 1, anchors), 0.7, 1e-9, "at the dark anchor");
});

test("the bright anchor runs the room at the circadian value minus the swing", () => {
  near(daylight.daylightBrightness(0.5, 100, anchors), 0.3, 1e-9, "at the bright anchor");
});

// The whole point of anchoring on the geometric mean: a room in ordinary light
// gets exactly the brightness it would have had before daylight existed.
test("the geometric mean of the anchors passes the circadian value through untouched", () => {
  assert.strictEqual(daylight.daylightBrightness(0.5, 10, anchors), 0.5);
});

// A linear interpolation would put its midpoint at 50.5 lx, spending almost the
// whole range on the top decade and leaving a dim room indistinguishable from a
// dark one.
test("interpolation is logarithmic, not linear", () => {
  const atArithmeticMean = daylight.daylightBrightness(0.5, 50.5, anchors);
  assert.ok(atArithmeticMean < 0.37, `the arithmetic mean must not be the midpoint: ${atArithmeticMean}`);
});

// This clamp is what bounds daylight's authority, and the bound is what holds
// the closed-loop gain below one.
test("readings beyond either anchor clamp instead of extrapolating", () => {
  near(daylight.daylightBrightness(0.5, 0.001, anchors), 0.7, 1e-9, "far below the dark anchor");
  near(daylight.daylightBrightness(0.5, 500000, anchors), 0.3, 1e-9, "far above the bright anchor");
});

test("a zero reading never produces a non-finite brightness", () => {
  const result = daylight.daylightBrightness(0.5, 0, anchors);
  assert.ok(Number.isFinite(result), `log10(0) leaked through as ${result}`);
});

test("the result still clamps to 0-1 against an extreme circadian value", () => {
  assert.strictEqual(daylight.daylightBrightness(0.95, 1, anchors), 1);
  assert.strictEqual(daylight.daylightBrightness(0.05, 100, anchors), 0);
});

test("no usable reading leaves the circadian value untouched", () => {
  for (const missing of [null, undefined, NaN, Infinity, "12"]) {
    assert.strictEqual(daylight.daylightBrightness(0.42, missing, anchors), 0.42, String(missing));
  }
  assert.strictEqual(daylight.daylightBrightness(0.42, 10, null), 0.42, "no config at all");
});

test("unusable anchors disable daylight for the room rather than dividing by zero", () => {
  const broken = [
    { ...anchors, dark: 100, bright: 100 },
    { ...anchors, dark: 100, bright: 1 },
    { ...anchors, dark: 0 },
    { ...anchors, dark: -5 },
    { ...anchors, dark: 0.05 },
    // One ULP apart: `bright > dark` is true, but their logarithms are the same
    // double, so the span is exactly zero and the mapping would return NaN.
    { ...anchors, dark: 100, bright: 100.00000000000001 },
    { ...anchors, bright: NaN },
    { ...anchors, swing: 1.5 },
    { ...anchors, swing: -0.1 },
    { ...anchors, source: "" },
    { ...anchors, dark: "1" },
    null,
    undefined,
    "nonsense",
    42,
  ];
  for (const entry of broken) {
    assert.strictEqual(daylight.validDaylight(entry), null, JSON.stringify(entry));
  }
  assert.deepStrictEqual(daylight.validDaylight(anchors), anchors);
});

// Ground truth from the house's own weather device: Gembloux on 2026-08-15
// reports sunrise 06:29 and sunset 21:02 local, and local is CEST (UTC+2).
const GEMBLOUX = { latitude: 50.56, longitude: 4.69 };
const modelled = (date, cloudiness) =>
  daylight.modelledLux(GEMBLOUX.latitude, GEMBLOUX.longitude, date, cloudiness);

// The minute, UTC, at which the sun crosses the conventional sunrise altitude.
function horizonCrossing(fromMinute, toMinute) {
  let wasBelow = null;
  for (let minute = fromMinute; minute <= toMinute; minute += 1) {
    const at = new Date(Date.UTC(2026, 7, 15, 0, minute));
    const sine = daylight.sinSolarElevation(GEMBLOUX.latitude, GEMBLOUX.longitude, at);
    const isBelow = (Math.asin(sine) * 180) / Math.PI < daylight.HORIZON_DEGREES;
    if (wasBelow != null && isBelow !== wasBelow) {
      return minute;
    }
    wasBelow = isBelow;
  }
  return null;
}

test("the solar model lands on the sunrise and sunset Homey reports for this house", () => {
  near(horizonCrossing(0, 720), 4 * 60 + 29, 15, "sunrise, minutes UTC");
  near(horizonCrossing(721, 1439), 19 * 60 + 2, 15, "sunset, minutes UTC");
});

test("solar elevation is unreadable rather than NaN for unusable inputs", () => {
  assert.strictEqual(daylight.sinSolarElevation(null, 4.69, new Date()), null);
  assert.strictEqual(daylight.sinSolarElevation(50.56, undefined, new Date()), null);
  assert.strictEqual(daylight.sinSolarElevation(50.56, 4.69, "now"), null);
  assert.strictEqual(daylight.sinSolarElevation(50.56, 4.69, new Date(NaN)), null);
  assert.strictEqual(daylight.modelledLux(null, null, new Date(), 50), null);
});

test("modelled lux is zero below the horizon and never negative", () => {
  const night = new Date(Date.UTC(2026, 7, 15, 1, 0));
  assert.strictEqual(modelled(night, null), 0);
  assert.strictEqual(modelled(night, 0), 0);
  assert.strictEqual(modelled(night, 100), 0);
});

test("full overcast leaves about a quarter of the clear-sky illuminance", () => {
  const noon = new Date(Date.UTC(2026, 7, 15, 11, 40));
  const clear = modelled(noon, 0);
  assert.ok(clear > 70000, `a clear August noon should be bright: ${clear}`);
  near(modelled(noon, 100) / clear, 0.25, 0.001, "overcast attenuation");
});

// Dropping the cloudiness term must leave a clear sky. Collapsing to zero would
// read as "pitch dark outside" and drive every modelled room to full swing up.
test("a missing cloudiness reading falls back to a clear sky, not to darkness", () => {
  const noon = new Date(Date.UTC(2026, 7, 15, 11, 40));
  assert.strictEqual(modelled(noon, null), modelled(noon, 0));
  assert.strictEqual(modelled(noon, "overcast"), modelled(noon, 0));
});

const sensorAnchors = { source: "lux", dark: 1, bright: 100, swing: 0.2 };
const modelAnchors = { source: "modelled", dark: 200, bright: 20000, swing: 0.2 };

function daylightApp(config) {
  const opts = config || {};
  const calls = [];
  const ambientCalls = [];
  const instances = { made: 0, destroyed: 0, listener: null };
  const bulb = {
    id: "bulb",
    zone: "salon",
    class: "light",
    name: "spot",
    capabilities: ["onoff", "dim"],
    capabilitiesObj: { onoff: { value: true }, dim: { value: 0.4 } },
    setCapabilityValue: async (cap, value) => calls.push([cap, value]),
  };
  const sensor = {
    id: "lux",
    zone: "salon",
    class: "sensor",
    name: "Occupancy Salon",
    capabilities: ["measure_luminance"],
    capabilitiesObj: { measure_luminance: { value: opts.lux === undefined ? 10 : opts.lux } },
    makeCapabilityInstance: (capabilityId, listener) => {
      instances.made += 1;
      instances.listener = listener;
      return {
        destroy: () => {
          instances.destroyed += 1;
        },
      };
    },
  };
  const sky = {
    id: "sky",
    zone: "salon",
    class: "sensor",
    name: "Gembloux Weather",
    capabilities: ["measure_cloudiness"],
    capabilitiesObj: {
      measure_cloudiness: {
        value: opts.cloudiness === undefined ? 97 : opts.cloudiness,
        lastUpdated: opts.cloudUpdated === undefined ? new Date() : opts.cloudUpdated,
      },
    },
  };
  const strip = {
    id: "strip",
    zone: "salon",
    class: "light",
    name: "strip",
    capabilities: ["onoff", "dim"],
    capabilitiesObj: { onoff: { value: true }, dim: { value: 0.4 } },
    setCapabilityValue: async (cap, value) => ambientCalls.push([cap, value]),
  };
  const devices = { bulb, lux: sensor, sky };
  if (opts.secondLight) {
    devices.strip = strip;
  }
  const app = fakeApp({
    zones: { salon: { id: "salon", name: "Salon", parent: null } },
    devices,
    roles: opts.roles,
    variables: {
      b: {
        id: "b",
        name: "Salon - Brightness",
        type: "number",
        value: opts.circadian === undefined ? 0.5 : opts.circadian,
      },
    },
    defaults: { salon: { brightness: "b" } },
    daylight: opts.daylight === undefined ? { salon: { ...sensorAnchors } } : opts.daylight,
    weatherDevice: opts.weatherDevice,
    geolocation: opts.geolocation,
  });

  const timers = [];
  app.homey.setInterval = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  app.homey.clearInterval = (id) => {
    timers[id - 1] = null;
  };
  return { app, calls, ambientCalls, instances, timers, sensor, bulb };
}

const salonRoom = { id: "salon", name: "Salon" };

test("a room with a lux source moves its mapped brightness with the light it already has", async () => {
  const { app, calls } = daylightApp({ lux: 1 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0], ["onoff", true]);
  near(calls[1][1], 0.7, 1e-9, "a dark room gets the full swing up");
});

test("a room with no daylight source takes the mapped brightness untouched", async () => {
  const { app, calls } = daylightApp({ daylight: {} });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.5]]);
});

// Daylight produces the brightness; the off threshold still decides what a low
// one means. There is no second rule for turning a room off.
test("daylight bright enough to fall through the off threshold turns the room off", async () => {
  const { app, calls } = daylightApp({ lux: 100, circadian: 0.2 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.deepStrictEqual(calls, [["onoff", false]]);
});

test("the automatic card subscribes to the room's lux sensor exactly once", async () => {
  const { app, instances } = daylightApp({});
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  await app.setRoomLightsAuto(salonRoom, {});
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(instances.made, 1, "a held wall button must not stack a listener per press");
  assert.strictEqual(instances.destroyed, 0);
});

test("a new sensor reading drives a review", async () => {
  const { app, calls, instances, sensor } = daylightApp({ lux: 10 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  calls.length = 0;

  sensor.capabilitiesObj.measure_luminance.value = 90;
  await instances.listener(90);
  assert.strictEqual(calls.length, 2, "the subscription must actually re-evaluate the room");
  near(calls[1][1], 0.309, 0.002, "a bright room is dimmed toward the bottom of the swing");
});

test("a change inside the deadband writes nothing", async () => {
  const { app, calls, sensor } = daylightApp({ lux: 10 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  calls.length = 0;

  // 10 to 12 lx moves the target by about 0.016 — a correction nobody can see,
  // and one that would otherwise cost a write to every light every five minutes.
  sensor.capabilitiesObj.measure_luminance.value = 12;
  await app.reviewDaylight("salon");
  assert.deepStrictEqual(calls, []);

  sensor.capabilitiesObj.measure_luminance.value = 90;
  await app.reviewDaylight("salon");
  assert.strictEqual(calls.length, 2, "a real change is still applied");
});

// This is also how daylight stops itself once it has dimmed a room through the
// off threshold: the room goes dark, and the next reading disarms rather than
// waking it up again at dusk.
test("a room whose lights are all off stops being tracked", async () => {
  const { app, bulb, instances } = daylightApp({ lux: 10 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  bulb.capabilitiesObj.onoff.value = false;
  await app.reviewDaylight("salon");
  assert.strictEqual(app.daylightTracking.size, 0, "nothing is on, so there is nothing to correct");
  assert.strictEqual(instances.destroyed, 1);
});

test("the stop card releases the subscription", async () => {
  const { app, instances } = daylightApp({});
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  app.stopDaylightTracking({ id: "salon" });
  assert.strictEqual(instances.destroyed, 1);
  assert.strictEqual(app.daylightTracking.size, 0);
  app.stopDaylightTracking(null);
  app.stopDaylightTracking({});
});

test("a stop card that lands mid-review cancels the write it was about to make", async () => {
  const { app, calls, sensor } = daylightApp({ lux: 10 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  calls.length = 0;
  sensor.capabilitiesObj.measure_luminance.value = 90;

  const readVariables = app.logicVariables.bind(app);
  app.logicVariables = async () => {
    app.stopDaylightTracking({ id: "salon" });
    return readVariables();
  };
  await app.reviewDaylight("salon");
  assert.deepStrictEqual(calls, [], "a room that stopped tracking must not still be written to");
});

// A capability instance is bound to the Device object it was made from, and a
// rebuild replaces every one of them.
test("a rebuild releases every subscription", async () => {
  const { app, instances } = daylightApp({});
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  await app.buildRoomLightsZones();
  assert.strictEqual(instances.destroyed, 1);
  assert.strictEqual(app.daylightTracking.size, 0);
});

test("saving the settings releases every subscription, so new anchors take effect", async () => {
  const { app, instances } = daylightApp({});
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  await app.setRoomDefaults({ mappings: { salon: { brightness: "b" } } });
  assert.strictEqual(instances.destroyed, 1);
  assert.strictEqual(app.daylightTracking.size, 0);
});

test("a lux sensor that has been unpaired leaves the room on plain circadian brightness", async () => {
  const { app, calls } = daylightApp({ daylight: { salon: { ...sensorAnchors, source: "ghost" } } });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.5]]);
  assert.strictEqual(app.daylightTracking.size, 0, "tracking nothing would only look like it works");
});

test("a modelled room re-evaluates on a timer instead of a subscription", async () => {
  const { app, instances, timers } = daylightApp({ daylight: { salon: { ...modelAnchors } } });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(instances.made, 0, "the model has no device to subscribe to");
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 5 * 60 * 1000);
});

test("a modelled room without geolocation falls back to the mapped brightness", async () => {
  const { app, calls } = daylightApp({
    daylight: { salon: { ...modelAnchors } },
    geolocation: null,
  });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.5]]);
});

test("cloudiness is used while it is fresh and dropped once it is stale", async () => {
  const fresh = daylightApp({ weatherDevice: "sky" });
  await fresh.app.buildRoomLightsZones();
  assert.strictEqual(await fresh.app.cloudiness(), 97);

  const stale = daylightApp({
    weatherDevice: "sky",
    cloudUpdated: new Date(Date.now() - 4 * 60 * 60 * 1000),
  });
  await stale.app.buildRoomLightsZones();
  assert.strictEqual(await stale.app.cloudiness(), null, "a frozen forecast must not steer the lights");
});

// A reading carrying no timestamp at all is taken at face value: absent is not
// the same as stale.
test("cloudiness with no timestamp is still used", async () => {
  const { app } = daylightApp({ weatherDevice: "sky", cloudUpdated: null });
  await app.buildRoomLightsZones();
  assert.strictEqual(await app.cloudiness(), 97);
});

test("a weather device that is gone, or never measured cloud, drops the term", async () => {
  for (const id of ["missing", "lux", null]) {
    const { app } = daylightApp({ weatherDevice: id });
    await app.buildRoomLightsZones();
    assert.strictEqual(await app.cloudiness(), null, String(id));
  }
});

test("setRoomDefaults keeps daylight only for known rooms with a source that still measures", async () => {
  const { app } = daylightApp({ daylight: {} });
  await app.buildRoomLightsZones();
  const saved = await app.setRoomDefaults({
    mappings: {},
    daylight: {
      salon: { ...sensorAnchors },
      nowhere: { ...sensorAnchors },
    },
  });
  assert.deepStrictEqual(Object.keys(saved.daylight), ["salon"]);
  assert.deepStrictEqual(saved.daylight.salon, sensorAnchors);
});

// "bulb" is a real device that has never measured light. A weather device
// replaced in place is how this house lost a capability under a stable name.
test("a source that does not measure what it was picked for is refused", async () => {
  const { app } = daylightApp({ daylight: {} });
  await app.buildRoomLightsZones();
  const saved = await app.setRoomDefaults({
    mappings: {},
    daylight: { salon: { ...sensorAnchors, source: "bulb" } },
    weather: "bulb",
  });
  assert.deepStrictEqual(saved.daylight, {});
  assert.strictEqual(saved.weather, null);
});

test("the modelled source needs no device to be accepted", async () => {
  const { app } = daylightApp({ daylight: {} });
  await app.buildRoomLightsZones();
  const saved = await app.setRoomDefaults({ mappings: {}, daylight: { salon: { ...modelAnchors } } });
  assert.deepStrictEqual(Object.keys(saved.daylight), ["salon"]);
});

test("a weather device that measures cloud is kept", async () => {
  const { app } = daylightApp({ daylight: {} });
  await app.buildRoomLightsZones();
  assert.strictEqual((await app.setRoomDefaults({ mappings: {}, weather: "sky" })).weather, "sky");
});

test("a deleted room takes its daylight settings with it", async () => {
  const { app } = daylightApp({
    daylight: { salon: { ...sensorAnchors }, gone: { ...sensorAnchors } },
  });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(Object.keys(app.daylightSettings()), ["salon"]);
});

test("the settings page is offered every source with its current reading", async () => {
  const { app } = daylightApp({ lux: 13.22, weatherDevice: "sky" });
  await app.buildRoomLightsZones();
  const page = await app.getRoomDefaultsPage();
  assert.deepStrictEqual(page.luxSources, [{ id: "lux", name: "Occupancy Salon", value: 13.22 }]);
  assert.deepStrictEqual(page.weatherSources, [{ id: "sky", name: "Gembloux Weather", value: 97 }]);
  assert.strictEqual(page.weather, "sky");
  assert.deepStrictEqual(page.daylight, { salon: sensorAnchors });
  assert.ok(typeof page.modelled === "number", "a Homey with coordinates can model daylight");
});

test("the settings page reports no modelled reading at all when Homey has no location", async () => {
  const { app } = daylightApp({ geolocation: null });
  await app.buildRoomLightsZones();
  assert.strictEqual((await app.getRoomDefaultsPage()).modelled, null);
});

// Anchors above every illuminance the sky can produce, so the answer does not
// depend on what time the suite happens to run. What it pins down is that the
// modelled branch is consulted at all and yields a usable number: were it to
// return nothing, the room would fall back to a bare 0.5.
test("a modelled room's brightness really does come from the model", async () => {
  const { app, calls } = daylightApp({
    daylight: { salon: { source: "modelled", dark: 1e9, bright: 1e10, swing: 0.2 } },
    weatherDevice: "sky",
  });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(calls.length, 2);
  near(calls[1][1], 0.7, 1e-9, "every real sky is below a 10^9 lux dark anchor");
});

// The deadband must be measured against what was last *written*, not against
// the last value computed. Carrying the skipped target forward would let a room
// drift a deadband per tick and never write again — daylight tracking would
// simply stop working on any day the light moves slowly, which is most of them.
test("small steps that add up still eventually move the lights", async () => {
  const { app, calls, sensor } = daylightApp({ lux: 10 });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, {});
  calls.length = 0;

  for (const reading of [12, 14]) {
    sensor.capabilitiesObj.measure_luminance.value = reading;
    await app.reviewDaylight("salon");
    assert.deepStrictEqual(calls, [], `${reading} lx is still inside the deadband`);
  }

  sensor.capabilitiesObj.measure_luminance.value = 17;
  await app.reviewDaylight("salon");
  assert.strictEqual(calls.length, 2, "10 to 17 lx is not, and must be applied");
});

test("a review keeps the role and state filter the card was run with", async () => {
  const { app, calls, ambientCalls, sensor } = daylightApp({
    lux: 10,
    secondLight: true,
    roles: { strip: "ambient" },
  });
  await app.buildRoomLightsZones();
  await app.setRoomLightsAuto(salonRoom, { role: "main" });
  calls.length = 0;
  ambientCalls.length = 0;

  sensor.capabilitiesObj.measure_luminance.value = 90;
  await app.reviewDaylight("salon");
  assert.strictEqual(calls.length, 2, "the lights the card included are still corrected");
  assert.deepStrictEqual(ambientCalls, [], "a light the card excluded must not be swept in later");
});

// The read that arms is a second round-trip: the write in between invalidates
// the cache. It can therefore fail on its own, after the lights are already
// where they were asked to go.
test("a failed device read while arming neither fails the card nor strands a dead tracker", async () => {
  const { app, calls, instances } = daylightApp({});
  await app.buildRoomLightsZones();

  const readDevices = app.homeyApi.devices.getDevices;
  let reads = 0;
  app.homeyApi.devices.getDevices = async () => {
    reads += 1;
    if (reads === 2) throw new Error("hub round-trip failed");
    return readDevices();
  };
  await app.setRoomLightsAuto(salonRoom, {});
  assert.deepStrictEqual(calls, [["onoff", true], ["dim", 0.5]], "the lights still went where asked");
  assert.strictEqual(app.daylightTracking.size, 0, "an entry with no listener would block every later arm");

  app.homeyApi.devices.getDevices = readDevices;
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(instances.made, 1, "and the next run must still be able to arm");
});

test("a stop card during the arming read destroys the subscription instead of orphaning it", async () => {
  const { app, instances } = daylightApp({});
  await app.buildRoomLightsZones();

  const readDevices = app.homeyApi.devices.getDevices;
  let reads = 0;
  app.homeyApi.devices.getDevices = async () => {
    reads += 1;
    // Lands while armDaylight is awaiting, so it cannot see the instance that
    // is about to exist.
    if (reads === 2) app.stopDaylightTracking({ id: "salon" });
    return readDevices();
  };
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(instances.made, 1);
  assert.strictEqual(instances.destroyed, 1, "nothing else could ever have released it");
  assert.strictEqual(app.daylightTracking.size, 0);
});

test("a rebuild during the arming read leaves nothing listening", async () => {
  const { app, instances } = daylightApp({});
  await app.buildRoomLightsZones();

  const readDevices = app.homeyApi.devices.getDevices;
  let reads = 0;
  app.homeyApi.devices.getDevices = async () => {
    reads += 1;
    if (reads === 2) app.disarmAllDaylight();
    return readDevices();
  };
  await app.setRoomLightsAuto(salonRoom, {});
  assert.strictEqual(instances.destroyed, 1);
  assert.strictEqual(app.daylightTracking.size, 0);
});

// The equation of time is worth a quarter of an hour, and a model that dropped
// it entirely would still pass a single sunrise check. These two dates sit near
// its opposite extremes; the latitude is the equator so the peak is sharp.
test("solar noon lands where the equation of time puts it", () => {
  const solarNoon = (month, day) => {
    let best = null;
    let highest = -2;
    for (let minute = 600; minute <= 840; minute += 1) {
      const sine = daylight.sinSolarElevation(0, 0, new Date(Date.UTC(2026, month, day, 0, minute)));
      if (sine > highest) {
        highest = sine;
        best = minute;
      }
    }
    return best;
  };
  near(solarNoon(1, 11), 12 * 60 + 14, 4, "11 February, the sun about 14 min behind the clock");
  near(solarNoon(10, 3), 11 * 60 + 44, 4, "3 November, about 16 min ahead of it");
});

// Declination amplitude and its harmonics: a model that flattened the seasons
// would also pass a single August check.
test("the solstices reach the elevations the Earth's tilt implies", () => {
  const highestElevation = (month, day) => {
    let highest = -1;
    for (let minute = 0; minute <= 1439; minute += 1) {
      const at = new Date(Date.UTC(2026, month, day, 0, minute));
      const sine = daylight.sinSolarElevation(GEMBLOUX.latitude, GEMBLOUX.longitude, at);
      if (sine > highest) highest = sine;
    }
    return (Math.asin(highest) * 180) / Math.PI;
  };
  near(highestElevation(5, 21), 90 - 50.56 + 23.44, 1, "June solstice at Gembloux");
  near(highestElevation(11, 21), 90 - 50.56 - 23.44, 1, "December solstice at Gembloux");
});
