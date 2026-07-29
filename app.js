"use strict";

const Homey = require("homey");
const { HomeyAPI } = require("homey-api");

// Rebuilds are debounced so a burst of events (pairing several devices, a
// dimming light emitting device.update) collapses into a single rebuild.
const REBUILD_DEBOUNCE_MS = 5000;

// A light's role is stored only when it is not the default, so an unconfigured
// app behaves exactly as it did before roles existed.
const DEFAULT_ROLE = "main";
const ROLE_EXCLUDED = "excluded";

class RoomLights extends Homey.App {
  zoneFilter = [];
  myHome = {};

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.homeyApi = await HomeyAPI.createAppAPI({
      homey: this.homey,
    });

    // Setup RoomLights variables. Without this map the app cannot do anything,
    // so let a failure here fail onInit.
    await this.buildRoomLightsZones();

    // Deprecated cards: kept registered forever because Advanced Flows use
    // them. Their arguments must not change. They do share the fixed behaviour
    // of the new cards — the excluded filter, and onoff written before dim.
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
          duration: args.duration,
        });
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("setroomlightscolorsrole").registerRunListener(async (args) => {
        await this.setRoomLightsColors(args.room, args.brightness, args.color, {
          role: this.argId(args.role),
          state: this.argId(args.state),
          duration: args.duration,
        });
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("turnoffroomlights").registerRunListener(async (args) => {
        await this.turnOffRoomLights(args.room, this.argId(args.role));
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getConditionCard("anyroomlightson").registerRunListener(async (args) => {
        return this.anyLightsOn(args.room, this.argId(args.role));
      })
    );

    this.registerRoomAutocomplete(
      this.homey.flow.getActionCard("dimroomlights").registerRunListener(async (args) => {
        await this.dimRoomLights(args.room, this.argId(args.role), this.argId(args.direction), args.step);
      })
    );

    // Best-effort: the cards above work without live updates, they just need an
    // app restart to notice new zones or devices. Never let this break onInit.
    this.watchForChanges().catch((err) => {
      this.error("Could not subscribe to zone/device changes", err);
    });

    this.log("Room lights has been initialized");
  }

  /**
   * The zone/device map is a snapshot, so rebuild it whenever Homey's zones or
   * devices change. Without this, anything added after start-up stays invisible
   * until the app restarts.
   */
  async watchForChanges() {
    const scheduleRebuild = () => {
      this.homey.clearTimeout(this.rebuildTimeout);
      this.rebuildTimeout = this.homey.setTimeout(() => {
        this.buildRoomLightsZones().catch((err) => this.error(err));
      }, REBUILD_DEBOUNCE_MS);
    };

    await this.homeyApi.devices.connect();
    await this.homeyApi.zones.connect();

    for (const event of ["device.create", "device.delete", "device.update"]) {
      this.homeyApi.devices.on(event, scheduleRebuild);
    }
    for (const event of ["zone.create", "zone.delete", "zone.update"]) {
      this.homeyApi.zones.on(event, scheduleRebuild);
    }
  }

  async buildRoomLightsZones() {
    const homeyZones = Object.values(await this.homeyApi.zones.getZones());
    const devices = Object.values(await this.homeyApi.devices.getDevices());

    // Zones starting with "_" are hidden from the room picker.
    this.zoneFilter = homeyZones
      .filter((zone) => !zone.name.startsWith("_"))
      .map((zone) => ({ id: zone.id, name: zone.name }));

    const myHome = {};
    for (const zone of homeyZones) {
      myHome[zone.id] = {
        id: zone.id,
        name: zone.name,
        parentId: zone.parent,
        devices: {},
      };
    }

    // Add every device to its own zone and to each of its ancestors, so asking
    // for "Ground floor" also reaches the lights in the rooms below it.
    for (const device of devices) {
      for (let zoneId = device.zone; zoneId != null; zoneId = myHome[zoneId].parentId) {
        const zone = myHome[zoneId];
        if (zone == null) break;
        if (zone.devices[device.class] == null) {
          zone.devices[device.class] = [];
        }
        zone.devices[device.class].push(device);
      }
    }

    this.myHome = myHome;
  }

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

  // Homey fades a capability write when a duration (ms) is given; only the
  // object form of setCapabilityValue carries it. Without a duration, keep the
  // positional form the rest of the app uses.
  async write(device, capabilityId, value, duration) {
    if (duration == null) {
      await device.setCapabilityValue(capabilityId, value);
      return;
    }
    await device.setCapabilityValue({ capabilityId, value, duration });
  }

  // The device objects in myHome are a snapshot. homey-api does not promise to
  // write realtime capability changes back into them — that is what
  // makeCapabilityInstance() exists for — so a cached onoff would silently make
  // the "only lights already on" filter wrong. Re-read the devices when, and
  // only when, a card actually asks to filter on current state.
  async lightStates() {
    const devices = Object.values(await this.homeyApi.devices.getDevices());
    const states = {};
    for (const device of devices) {
      states[device.id] = this.isOn(device);
    }
    return states;
  }

  async roomLights(room, role, state) {
    const zone = this.myHome[room.id];
    if (zone == null || zone.devices["light"] == null) {
      return [];
    }

    const roles = this.lightRoles();
    const wantedRole = role == null ? "all" : role;
    const onlyOn = state === "on";
    const states = onlyOn ? await this.lightStates() : null;
    const lights = [];

    for (const device of zone.devices["light"]) {
      const deviceRole = roles[device.id] || DEFAULT_ROLE;
      if (deviceRole === ROLE_EXCLUDED) {
        continue;
      }
      if (wantedRole !== "all" && deviceRole !== wantedRole) {
        continue;
      }
      if (onlyOn && states[device.id] !== true) {
        continue;
      }
      lights.push(device);
    }

    return lights;
  }

  // Backs the condition card and the toggle. Note the isOn() convention leaks
  // through here: a light whose onoff state is unknown counts as on.
  async anyLightsOn(room, role) {
    return (await this.roomLights(room, role, "on")).length > 0;
  }

  // Relative dim only touches lights that are already on: dimming "up" must
  // not wake a lamp nobody switched on. Unlike isOn(), an unreadable state
  // means skip — a relative change needs a base value to be meaningful.
  async dimRoomLights(room, role, direction, step) {
    const fresh = await this.homeyApi.devices.getDevices();
    const delta = direction === "down" ? -step : step;
    await Promise.all(
      (await this.roomLights(room, role)).map(async (device) => {
        const caps = fresh[device.id] && fresh[device.id].capabilitiesObj;
        if (caps == null || caps.onoff == null || caps.onoff.value !== true) {
          return;
        }
        if (caps.dim == null || typeof caps.dim.value !== "number") {
          return;
        }
        const dim = Math.min(1, Math.max(0, caps.dim.value + delta));
        if (dim === 0) {
          await device.setCapabilityValue("onoff", false);
          return;
        }
        await device.setCapabilityValue("dim", dim);
      })
    );
  }

  parseHexToHSL(hex) {
    const r = parseInt(hex.substring(1, 3), 16) / 255;
    const g = parseInt(hex.substring(3, 5), 16) / 255;
    const b = parseInt(hex.substring(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) {
      return [0, 0, +l.toFixed(3)];
    }

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;

    return [+h.toFixed(3), +s.toFixed(3), +l.toFixed(3)];
  }

  getLightsByZone() {
    const roles = this.lightRoles();
    const zones = [];

    // Every zone, including the "_"-prefixed ones hidden from the room picker.
    // Those lights are still reached by cards targeting an ancestor zone, and
    // the settings page replaces the whole role map — so a light it cannot see
    // is a light whose role the next unrelated save would silently wipe.
    for (const zone of Object.values(this.myHome)) {
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

  async setLightsBrightness(room, brightness, temperature, options) {
    const opts = options || {};
    await Promise.all(
      (await this.roomLights(room, opts.role, opts.state)).map(async (device) => {
        if (brightness === 0) {
          await this.write(device, "onoff", false, opts.duration);
          return;
        }
        await device.setCapabilityValue("onoff", true);
        await this.write(device, "dim", brightness, opts.duration);
        if (temperature != null && device.capabilities.includes("light_temperature")) {
          await device.setCapabilityValue("light_temperature", temperature);
        }
      })
    );
  }

  async setLightsColors(room, brightness, color, saturation, options) {
    const opts = options || {};
    await Promise.all(
      (await this.roomLights(room, opts.role, opts.state)).map(async (device) => {
        if (brightness === 0) {
          await this.write(device, "onoff", false, opts.duration);
          return;
        }
        await device.setCapabilityValue("onoff", true);
        await this.write(device, "dim", brightness, opts.duration);
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
      (await this.roomLights(room, role)).map((device) => {
        return device.setCapabilityValue("onoff", false);
      })
    );
  }
}

module.exports = RoomLights;
