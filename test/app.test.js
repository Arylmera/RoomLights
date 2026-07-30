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

function recordingApp(capabilities, roles) {
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
function dimApp(capabilitiesObj) {
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
