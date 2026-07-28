# Light Roles and State Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every light a role (main / ambient / excluded) editable from an app settings page, and let Flow cards target lights by role and by on/off state.

**Architecture:** Roles live in `homey.settings` under `lightRoles`, keyed by device id, storing only non-default values. `app.js` gains a single filtering entry point, `roomLights(room, role, state)`, that every card routes through. A new `api.js` exposes two routes to a vanilla-JS settings page. The two existing Flow cards are deprecated rather than modified, because 8 Advanced Flows use them.

**Tech Stack:** Node.js, Homey Apps SDK v3, `homey-api` v3, `node:test` for tests, plain HTML/JS for the settings page.

## Global Constraints

- `app.js` and `api.js` MUST stay parseable on **Node 12**: no `?.`, no `??`, no `??=`. A test enforces this. `settings/index.html` runs in a browser and is exempt.
- **Never edit `app.json`** — it is generated. Edit `.homeycompose/app.json` and `.homeycompose/flow/actions/*.json`.
- The deprecated cards `setroomlights` and `setroomlightscolors` keep their arguments and their `dim`-without-`onoff` behaviour. They gain **only** `excluded` filtering, which is a no-op until a light is marked excluded.
- Only `"ambient"` and `"excluded"` are persisted. `"main"` is the absence of an entry.
- Style: 2-space indent, double quotes, `"use strict"`.
- Run `npm test` after every task. Run `homey app validate --level publish` after any `.homeycompose` change.

---

### Task 1: Role storage and the filtering entry point

**Files:**
- Modify: `app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `this.myHome`, `this.zoneFilter` from `buildRoomLightsZones()`.
- Produces:
  - `lightRoles(): { [deviceId]: "ambient" | "excluded" }`
  - `isOn(device): boolean`
  - `roomLights(room, role, state): Device[]` — `role` is `"all" | "main" | "ambient"` (default `"all"`), `state` is `"all" | "on"` (default `"all"`)

- [ ] **Step 1: Add a settings stub to the test helper**

Replace the `fakeApp` helper in `test/app.test.js`:

```js
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
```

- [ ] **Step 2: Write the failing tests**

Append to `test/app.test.js`:

```js
const roleZones = { a: { id: "a", name: "Salon", parent: null } };
const roleDevices = {
  1: { id: 1, zone: "a", class: "light", name: "spot", capabilities: ["onoff", "dim"] },
  2: { id: 2, zone: "a", class: "light", name: "strip", capabilities: ["onoff", "dim"] },
  3: { id: 3, zone: "a", class: "light", name: "circadian", capabilities: ["onoff", "dim"] },
};
const roleMap = { 2: "ambient", 3: "excluded" };

async function roleApp() {
  const app = fakeApp({ zones: roleZones, devices: roleDevices, roles: roleMap });
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
  const app = fakeApp({ zones: roleZones, devices: roleDevices, roles: { 999: "excluded" } });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(idsOf(app.roomLights({ id: "a" }, "all", "all")), [1, 2, 3]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `roomLights` currently takes only `room` and returns all three lights.

- [ ] **Step 4: Implement**

In `app.js`, add these constants below `REBUILD_DEBOUNCE_MS`:

```js
const DEFAULT_ROLE = "main";
const ROLE_EXCLUDED = "excluded";
```

Replace the whole `roomLights(room)` method with:

```js
  lightRoles() {
    return this.homey.settings.get("lightRoles") || {};
  }

  isOn(device) {
    const capabilities = device.capabilitiesObj;
    if (capabilities == null || capabilities.onoff == null) {
      // Unknown state: treat as on, so a light is never skipped silently.
      return true;
    }
    return capabilities.onoff.value === true;
  }

  roomLights(room, role, state) {
    const zone = this.myHome[room.id];
    if (zone == null || zone.devices["light"] == null) {
      return [];
    }

    const roles = this.lightRoles();
    const wantedRole = role == null ? "all" : role;
    const onlyOn = state === "on";
    const lights = [];

    for (const device of zone.devices["light"]) {
      const deviceRole = roles[device.id] || DEFAULT_ROLE;
      if (deviceRole === ROLE_EXCLUDED) {
        continue;
      }
      if (wantedRole !== "all" && deviceRole !== wantedRole) {
        continue;
      }
      if (onlyOn && !this.isOn(device)) {
        continue;
      }
      lights.push(device);
    }

    return lights;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add app.js test/app.test.js
git commit -m "feat: filter room lights by role and on/off state"
```

---

### Task 2: Turn-on behaviour and the turn-off helper

**Files:**
- Modify: `app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `roomLights(room, role, state)` from Task 1.
- Produces:
  - `setLightsBrightness(room, brightness, temperature, options)` where `options` is `{ role, state, turnOn }`, all optional
  - `setLightsColors(room, brightness, hue, saturation, options)` — same `options`
  - `setRoomLightsColors(room, brightness, color, options)`
  - `turnOffRoomLights(room, role)`

- [ ] **Step 1: Write the failing tests**

Append to `test/app.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `setLightsBrightness` takes no `options`, `turnOffRoomLights` is undefined.

- [ ] **Step 3: Implement**

In `app.js`, replace `setLightsBrightness`, `setLightsColors` and `setRoomLightsColors` with:

```js
  async setLightsBrightness(room, brightness, temperature, options) {
    const opts = options || {};
    await Promise.all(
      this.roomLights(room, opts.role, opts.state).map(async (device) => {
        if (brightness === 0) {
          await device.setCapabilityValue("onoff", false);
          return;
        }
        if (opts.turnOn) {
          await device.setCapabilityValue("onoff", true);
        }
        await device.setCapabilityValue("dim", brightness);
        if (device.capabilities.includes("light_temperature")) {
          await device.setCapabilityValue("light_temperature", temperature);
        }
      })
    );
  }

  async setLightsColors(room, brightness, color, saturation, options) {
    const opts = options || {};
    await Promise.all(
      this.roomLights(room, opts.role, opts.state).map(async (device) => {
        if (brightness === 0) {
          await device.setCapabilityValue("onoff", false);
          return;
        }
        if (opts.turnOn) {
          await device.setCapabilityValue("onoff", true);
        }
        await device.setCapabilityValue("dim", brightness);
        // Lights without a hue capability just take the brightness.
        if (device.capabilities.includes("light_hue")) {
          await device.setCapabilityValue("light_hue", color);
          await device.setCapabilityValue("light_saturation", saturation);
        }
      })
    );
  }

  async setRoomLightsColors(room, brightness, color, options) {
    const [h, s] = this.parseHexToHSL(color);
    await this.setLightsColors(room, brightness, h, s, options);
  }

  async turnOffRoomLights(room, role) {
    await Promise.all(
      this.roomLights(room, role).map((device) => {
        return device.setCapabilityValue("onoff", false);
      })
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app.js test/app.test.js
git commit -m "feat: add turn-off helper and explicit turn-on for set cards"
```

---

### Task 3: Deprecate the old cards, add the three new ones

**Files:**
- Modify: `.homeycompose/flow/actions/setroomlights.json`
- Modify: `.homeycompose/flow/actions/setroomlightscolors.json`
- Create: `.homeycompose/flow/actions/setroomlightsrole.json`
- Create: `.homeycompose/flow/actions/setroomlightscolorsrole.json`
- Create: `.homeycompose/flow/actions/turnoffroomlights.json`
- Modify: `app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `argId(value)` module-level helper; `registerRoomAutocomplete(card)` method returning the card for chaining.

- [ ] **Step 1: Mark both existing cards deprecated**

Add `"deprecated": true` as the first key of `.homeycompose/flow/actions/setroomlights.json` and `.homeycompose/flow/actions/setroomlightscolors.json`. For example the first lines of `setroomlights.json` become:

```json
{
	"deprecated": true,
	"title": {
		"en": "SetRoomLights"
	},
```

- [ ] **Step 2: Create the role-aware brightness card**

Create `.homeycompose/flow/actions/setroomlightsrole.json`:

```json
{
	"title": {
		"en": "Set room lights"
	},
	"hint": {
		"en": "Set brightness and temperature for the lights of a room, filtered by role and by whether they are already on."
	},
	"titleFormatted": {
		"en": "Set [[role]] lights of [[room]] ([[state]]) to brightness [[brightness]] and temperature [[temperature]]"
	},
	"args": [
		{
			"type": "autocomplete",
			"name": "room",
			"title": {
				"en": "Room"
			},
			"placeholder": {
				"en": "Bedroom"
			}
		},
		{
			"type": "dropdown",
			"name": "role",
			"title": {
				"en": "Lights"
			},
			"values": [
				{ "id": "all", "title": { "en": "All" } },
				{ "id": "main", "title": { "en": "Main only" } },
				{ "id": "ambient", "title": { "en": "Ambient only" } }
			]
		},
		{
			"type": "dropdown",
			"name": "state",
			"title": {
				"en": "Apply to"
			},
			"values": [
				{ "id": "all", "title": { "en": "All lights" } },
				{ "id": "on", "title": { "en": "Only lights already on" } }
			]
		},
		{
			"type": "range",
			"name": "brightness",
			"title": "brightness",
			"min": 0,
			"max": 1,
			"step": 0.01,
			"label": "%",
			"labelDecimals": 0,
			"labelMultiplier": 100
		},
		{
			"type": "range",
			"name": "temperature",
			"title": "temperature",
			"min": 0,
			"max": 1,
			"step": 0.01,
			"label": "%",
			"labelDecimals": 0,
			"labelMultiplier": 100
		}
	]
}
```

- [ ] **Step 3: Create the role-aware colour card**

Create `.homeycompose/flow/actions/setroomlightscolorsrole.json`:

```json
{
	"title": {
		"en": "Set room lights colour"
	},
	"hint": {
		"en": "Set brightness and colour for the lights of a room, filtered by role and by whether they are already on."
	},
	"titleFormatted": {
		"en": "Set [[role]] lights of [[room]] ([[state]]) to brightness [[brightness]] and colour [[color]]"
	},
	"args": [
		{
			"type": "autocomplete",
			"name": "room",
			"title": {
				"en": "Room"
			},
			"placeholder": {
				"en": "Bedroom"
			}
		},
		{
			"type": "dropdown",
			"name": "role",
			"title": {
				"en": "Lights"
			},
			"values": [
				{ "id": "all", "title": { "en": "All" } },
				{ "id": "main", "title": { "en": "Main only" } },
				{ "id": "ambient", "title": { "en": "Ambient only" } }
			]
		},
		{
			"type": "dropdown",
			"name": "state",
			"title": {
				"en": "Apply to"
			},
			"values": [
				{ "id": "all", "title": { "en": "All lights" } },
				{ "id": "on", "title": { "en": "Only lights already on" } }
			]
		},
		{
			"type": "range",
			"name": "brightness",
			"title": "brightness",
			"min": 0,
			"max": 1,
			"step": 0.01,
			"label": "%",
			"labelDecimals": 0,
			"labelMultiplier": 100
		},
		{
			"type": "color",
			"name": "color"
		}
	]
}
```

- [ ] **Step 4: Create the turn-off card**

Create `.homeycompose/flow/actions/turnoffroomlights.json`:

```json
{
	"title": {
		"en": "Turn off room lights"
	},
	"hint": {
		"en": "Turn off the lights of a room. Lights marked excluded in the app settings are never touched."
	},
	"titleFormatted": {
		"en": "Turn off [[role]] lights of [[room]]"
	},
	"args": [
		{
			"type": "autocomplete",
			"name": "room",
			"title": {
				"en": "Room"
			},
			"placeholder": {
				"en": "Bedroom"
			}
		},
		{
			"type": "dropdown",
			"name": "role",
			"title": {
				"en": "Lights"
			},
			"values": [
				{ "id": "all", "title": { "en": "All" } },
				{ "id": "main", "title": { "en": "Main only" } },
				{ "id": "ambient", "title": { "en": "Ambient only" } }
			]
		}
	]
}
```

- [ ] **Step 5: Write the failing test for argId**

Append to `test/app.test.js`:

```js
test("argId accepts both a dropdown id string and a value object", () => {
  const app = new RoomLights();
  assert.strictEqual(app.argId("ambient"), "ambient");
  assert.strictEqual(app.argId({ id: "ambient" }), "ambient");
  assert.strictEqual(app.argId(null), null);
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `app.argId is not a function`.

- [ ] **Step 7: Implement the helpers and register the cards**

In `app.js`, add these two methods above `roomLights`:

```js
  // ponytail: dropdown args arrive as the value's id; tolerate the whole object
  // too, so a Homey version that passes it does not break the card.
  argId(value) {
    if (value == null) {
      return null;
    }
    return typeof value === "string" ? value : value.id;
  }

  registerRoomAutocomplete(card) {
    return card.registerArgumentAutocompleteListener("room", async (query) => {
      return this.zoneFilter.filter((zone) => {
        return zone.name.toLowerCase().includes(query.toLowerCase());
      });
    });
  }
```

Replace the whole card-registration block in `onInit` with:

```js
    // Deprecated cards. Their arguments and their dim-without-onoff behaviour
    // must not change — Advanced Flows depend on them. They only gain the
    // excluded filter, which is a no-op until a light is marked excluded.
    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("setroomlights").registerRunListener(async (args) => {
        await this.setLightsBrightness(args.room, args.brightness, args.temperature);
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("setroomlightscolors").registerRunListener(async (args) => {
        await this.setRoomLightsColors(args.room, args.brightness, args.color);
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("setroomlightsrole").registerRunListener(async (args) => {
        await this.setLightsBrightness(args.room, args.brightness, args.temperature, {
          role: this.argId(args.role),
          state: this.argId(args.state),
          turnOn: true,
        });
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("setroomlightscolorsrole").registerRunListener(async (args) => {
        await this.setRoomLightsColors(args.room, args.brightness, args.color, {
          role: this.argId(args.role),
          state: this.argId(args.state),
          turnOn: true,
        });
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("turnoffroomlights").registerRunListener(async (args) => {
        await this.turnOffRoomLights(args.room, this.argId(args.role));
      })
    );
```

- [ ] **Step 8: Update the onInit registration test**

In `test/app.test.js`, change the expected card list in the test named
`"a failed event subscription still leaves the Flow cards registered"`:

```js
  assert.deepStrictEqual(registered, [
    "setroomlights",
    "setroomlightscolors",
    "setroomlightsrole",
    "setroomlightscolorsrole",
    "turnoffroomlights",
  ]);
```

- [ ] **Step 9: Run the tests and validate the manifest**

```bash
npm test
```

Expected: PASS.

```bash
homey app validate --level publish
```

Expected: `App validated successfully against level publish`. If the validator rejects `title` inside dropdown `values`, replace it with `label` in all three new card files and re-run.

- [ ] **Step 10: Commit**

```bash
git add .homeycompose app.js test/app.test.js
git commit -m "feat: add role-aware and turn-off Flow cards, deprecate the originals"
```

---

### Task 4: App API for the settings page

**Files:**
- Create: `api.js`
- Modify: `.homeycompose/app.json`
- Modify: `app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `lightRoles()`, `myHome`, `zoneFilter`.
- Produces:
  - `getLightsByZone(): [{ id, name, lights: [{ id, name, role }] }]` — each light appears **once**, under the zone it actually belongs to, not under ancestor zones
  - `setLightRoles(roles): { [deviceId]: "ambient" | "excluded" }` — validated and persisted

- [ ] **Step 1: Write the failing tests**

Append to `test/app.test.js`:

```js
const apiZones = {
  house: { id: "house", name: "Home", parent: null },
  salon: { id: "salon", name: "Salon", parent: "house" },
};
const apiDevices = {
  1: { id: 1, zone: "salon", class: "light", name: "Salon spot 1", capabilities: ["onoff"] },
  2: { id: 2, zone: "house", class: "light", name: "Circadian Zone", capabilities: ["onoff"] },
};

test("getLightsByZone lists each light once, under its own zone", async () => {
  const app = fakeApp({ zones: apiZones, devices: apiDevices, roles: { 2: "excluded" } });
  await app.buildRoomLightsZones();
  const result = app.getLightsByZone();
  const byName = {};
  for (const zone of result) {
    byName[zone.name] = zone.lights.map((l) => l.name + ":" + l.role).sort();
  }
  assert.deepStrictEqual(byName, {
    Home: ["Circadian Zone:excluded"],
    Salon: ["Salon spot 1:main"],
  });
});

test("setLightRoles keeps only valid roles for known lights", async () => {
  const app = fakeApp({ zones: apiZones, devices: apiDevices, roles: {} });
  await app.buildRoomLightsZones();
  const saved = app.setLightRoles({ 1: "ambient", 2: "nonsense", 999: "excluded" });
  assert.deepStrictEqual(saved, { 1: "ambient" });
  assert.deepStrictEqual(app.lightRoles(), { 1: "ambient" });
});

test("setLightRoles drops main because it is the default", async () => {
  const app = fakeApp({ zones: apiZones, devices: apiDevices, roles: { 1: "ambient" } });
  await app.buildRoomLightsZones();
  assert.deepStrictEqual(app.setLightRoles({ 1: "main" }), {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `app.getLightsByZone is not a function`.

- [ ] **Step 3: Implement the two app methods**

In `app.js`, add below `roomLights`:

```js
  getLightsByZone() {
    const roles = this.lightRoles();
    const zones = [];

    for (const zone of this.zoneFilter) {
      const home = this.myHome[zone.id];
      if (home == null || home.devices["light"] == null) {
        continue;
      }
      // Only the lights that actually live in this zone. The rollup puts child
      // devices in ancestor zones too, which would list a light many times.
      const lights = home.devices["light"]
        .filter((device) => device.zone === zone.id)
        .map((device) => {
          return {
            id: device.id,
            name: device.name,
            role: roles[device.id] || DEFAULT_ROLE,
          };
        });
      if (lights.length === 0) {
        continue;
      }
      zones.push({ id: zone.id, name: zone.name, lights: lights });
    }

    return zones;
  }

  setLightRoles(roles) {
    const known = new Set();
    for (const zoneId of Object.keys(this.myHome)) {
      const lights = this.myHome[zoneId].devices["light"];
      if (lights == null) {
        continue;
      }
      for (const device of lights) {
        known.add(String(device.id));
      }
    }

    const valid = {};
    const input = roles || {};
    for (const id of Object.keys(input)) {
      // "main" is the default and is never stored.
      if (input[id] !== "ambient" && input[id] !== ROLE_EXCLUDED) {
        continue;
      }
      if (!known.has(String(id))) {
        continue;
      }
      valid[id] = input[id];
    }

    this.homey.settings.set("lightRoles", valid);
    return valid;
  }
```

- [ ] **Step 4: Create `api.js`**

```js
"use strict";

module.exports = {
  async getLights({ homey }) {
    return homey.app.getLightsByZone();
  },

  async setRoles({ homey, body }) {
    return homey.app.setLightRoles(body);
  },
};
```

- [ ] **Step 5: Declare the routes**

In `.homeycompose/app.json`, add an `"api"` block after `"permissions"`:

```json
	"api": {
		"getLights": {
			"method": "GET",
			"path": "/lights"
		},
		"setRoles": {
			"method": "PUT",
			"path": "/roles"
		}
	},
```

- [ ] **Step 6: Run the tests and validate**

```bash
npm test
```

Expected: PASS.

```bash
homey app validate --level publish
```

Expected: `App validated successfully against level publish`.

- [ ] **Step 7: Commit**

```bash
git add app.js api.js .homeycompose/app.json test/app.test.js
git commit -m "feat: expose lights and roles over the app API"
```

---

### Task 5: Settings page

**Files:**
- Create: `settings/index.html`

**Interfaces:**
- Consumes: `GET /lights` and `PUT /roles` from Task 4.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create the page**

Create `settings/index.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <script type="text/javascript" src="/homey.js" data-origin="settings"></script>
    <style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 16px; }
      h2 { font-size: 16px; margin: 24px 0 8px; }
      .zone { border-top: 1px solid #ddd; padding-top: 8px; }
      .role { margin: 0 0 12px 0; }
      .role h3 { font-size: 13px; color: #666; margin: 8px 0 4px; text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
      td.trash { width: 32px; text-align: right; }
      button.trash { border: 0; background: none; cursor: pointer; font-size: 16px; }
      select { width: 100%; padding: 6px; margin-bottom: 4px; }
      .empty { color: #999; font-style: italic; padding: 6px 0; }
    </style>
  </head>
  <body>
    <h1 id="title">Light roles</h1>
    <p id="intro"></p>
    <div id="zones"></div>

    <script type="text/javascript">
      var ROLES = [
        { id: "ambient", label: "Ambient" },
        { id: "excluded", label: "Excluded (never touched)" },
      ];
      var zones = [];
      var roles = {};

      function onHomeyReady(Homey) {
        Homey.api("GET", "/lights", null, function (err, result) {
          if (err) return Homey.alert(err);
          zones = result;
          roles = {};
          zones.forEach(function (zone) {
            zone.lights.forEach(function (light) {
              if (light.role !== "main") roles[light.id] = light.role;
            });
          });
          render(Homey);
          Homey.ready();
        });
      }

      function save(Homey) {
        Homey.api("PUT", "/roles", roles, function (err) {
          if (err) return Homey.alert(err);
        });
      }

      function render(Homey) {
        var container = document.getElementById("zones");
        container.innerHTML = "";

        zones.forEach(function (zone) {
          var section = document.createElement("div");
          section.className = "zone";
          var heading = document.createElement("h2");
          heading.textContent = zone.name;
          section.appendChild(heading);

          ROLES.forEach(function (role) {
            section.appendChild(renderRole(Homey, zone, role));
          });

          container.appendChild(section);
        });
      }

      function renderRole(Homey, zone, role) {
        var block = document.createElement("div");
        block.className = "role";

        var heading = document.createElement("h3");
        heading.textContent = role.label;
        block.appendChild(heading);

        var assigned = zone.lights.filter(function (light) {
          return roles[light.id] === role.id;
        });

        if (assigned.length === 0) {
          var empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "None";
          block.appendChild(empty);
        } else {
          var table = document.createElement("table");
          assigned.forEach(function (light) {
            var row = table.insertRow();
            row.insertCell().textContent = light.name;
            var cell = row.insertCell();
            cell.className = "trash";
            var button = document.createElement("button");
            button.className = "trash";
            button.textContent = "🗑";
            button.onclick = function () {
              delete roles[light.id];
              save(Homey);
              render(Homey);
            };
            cell.appendChild(button);
          });
          block.appendChild(table);
        }

        var available = zone.lights.filter(function (light) {
          return roles[light.id] == null;
        });
        var select = document.createElement("select");
        var placeholder = document.createElement("option");
        placeholder.textContent = "Add a light…";
        placeholder.value = "";
        select.appendChild(placeholder);
        available.forEach(function (light) {
          var option = document.createElement("option");
          option.value = light.id;
          option.textContent = light.name;
          select.appendChild(option);
        });
        select.disabled = available.length === 0;
        select.onchange = function () {
          if (!select.value) return;
          roles[select.value] = role.id;
          save(Homey);
          render(Homey);
        };
        block.appendChild(select);

        return block;
      }
    </script>
  </body>
</html>
```

- [ ] **Step 2: Validate and install**

```bash
homey app validate --level publish
```

Expected: `App validated successfully against level publish`.

```bash
homey app install
```

Expected: `Homey App inc.lemer.roomLights successfully installed`.

- [ ] **Step 3: Check the page by hand**

Open the RoomLights app settings in the Homey app. Confirm: every room with lights appears, the dropdown lists that room's unassigned lights, choosing one moves it into the table, the trash icon returns it to the dropdown, and reopening the page shows the same assignments.

- [ ] **Step 4: Commit**

```bash
git add settings/index.html
git commit -m "feat: add settings page for assigning light roles"
```

---

### Task 6: Verify the live-state assumption on real hardware

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-roomlights-roles-design.md` (record the result)

**Interfaces:**
- Consumes: an installed build from Task 5.
- Produces: a decision — keep `isOn()` reading `capabilitiesObj`, or change it to read the capability live.

- [ ] **Step 1: Read the live onoff values through the CLI**

```bash
homey api devices get-devices --json
```

Pipe the output through PowerShell to compare a known-on and a known-off light:

```bash
$d=(homey api devices get-devices --json | ConvertFrom-Json).PSObject.Properties.Value | Where-Object { $_.class -eq 'light' }; $d | ForEach-Object { [PSCustomObject]@{ Name=$_.name; On=$_.capabilitiesObj.onoff.value } } | Format-Table -AutoSize
```

- [ ] **Step 2: Toggle one light and re-read**

Turn a single light on or off from the Homey app, re-run the command from Step 1, and confirm the `On` column changed for that light.

- [ ] **Step 3: Record the outcome**

If the value tracked the change, add a line to the spec's "To verify during implementation" section stating that `capabilitiesObj.onoff.value` was confirmed live on 2026-07-28 and the section is resolved.

If the value was stale, change `isOn()` to read the capability at execution time instead, add a test covering it, and record that in the spec.

- [ ] **Step 4: Commit**

```bash
git add docs app.js test/app.test.js
git commit -m "docs: record the live onoff verification result"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Update the README**

In the Flow cards section, mark `setroomlights` and `setroomlightscolors` as deprecated with a one-line note that they remain functional for existing Flows. Document the three new cards with their argument tables, matching the format already used. Add a "Light roles" section explaining main / ambient / excluded, that roles are set on the app settings page, that `excluded` overrides every filter, and that `main` is the default so an unconfigured app behaves exactly as before. In the repository layout block, add `api.js` and `settings/index.html`.

- [ ] **Step 2: Update CONTRIBUTING**

In "Things worth knowing", note that a new Flow card needs a JSON file in `.homeycompose/flow/actions/`, a `getActionCard` registration in `app.js`, and that the filename must match the card id. Add that API routes live in `api.js` and are declared in the `"api"` block of `.homeycompose/app.json`.

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: document light roles and the new Flow cards"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Roles (main/ambient/excluded) | 1 |
| Storage in `lightRoles`, only non-defaults | 1, 4 |
| Settings page | 5 |
| App API `GET /lights`, `PUT /roles` | 4 |
| Deprecate existing cards | 3 |
| Three new cards with role and state | 3 |
| Filter order: excluded, then role, then state | 1 |
| `onoff: true` on set-cards | 2 |
| Turn-off card without a state argument | 2, 3 |
| Edge cases: no lights, stale ids, `Vitrine` | 1, 4 |
| Testing | every task |
| Node 12 constraint | Global Constraints, enforced by existing test |
| Verify live `onoff` | 6 |
| Later: removing deprecated cards | out of scope for this plan, documented in the spec |

**Type consistency:** `roomLights(room, role, state)` is called with the same argument order in Tasks 1, 2 and 4. `options` is `{ role, state, turnOn }` in both set methods. `argId` is a method on the class in Task 3 and is called as `this.argId(...)` everywhere.
