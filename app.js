"use strict";

const Homey = require("homey");
const { HomeyAPI } = require("homey-api");

// Rebuilds are debounced so a burst of events (pairing several devices, moving
// a room around) collapses into a single rebuild...
const REBUILD_DEBOUNCE_MS = 5000;

// ...but a trailing debounce alone starves: one chatty device is enough to keep
// pushing the rebuild back forever. Never defer past this deadline.
const REBUILD_MAX_WAIT_MS = 30000;

// How long a device read stays usable. While the realtime subscription is up,
// homey-api answers getDevices() from its own live cache and this saves little.
// It earns its keep when that subscription is down — which this app tolerates
// on purpose — because every read is then a full house dump over the network,
// and a held wall button runs one card per repeat. Our own writes drop the
// cache immediately, so only a change made elsewhere within this window can be
// missed; tune it down if that ever matters more than the round-trips.
const DEVICE_CACHE_MS = 1000;

// A light's role is stored only when it is not the default, so an unconfigured
// app behaves exactly as it did before roles existed.
const DEFAULT_ROLE = "main";
const ROLE_EXCLUDED = "excluded";

// What a snapshot remembers besides onoff, and the order it is replayed in.
const SNAPSHOT_CAPABILITIES = ["dim", "light_temperature", "light_hue", "light_saturation"];

// Everything about a device that the zone map is built from.
const topologyKey = (device) => `${device.zone}|${device.class}|${device.name}`;

class RoomLights extends Homey.App {
  zoneFilter = [];
  myHome = {};

  // Live device state, see freshDevices(). deviceGen is bumped by anything that
  // makes a read obsolete, so a read started before it cannot be reused after.
  deviceCache = null;
  deviceCacheAt = 0;
  deviceFetch = null;
  deviceFetchGen = -1;
  deviceGen = 0;

  // id -> topologyKey() as of the last rebuild, see topologyChanged().
  deviceIndex = new Map();
  rebuildDeadline = null;

  // ---------------------------------------------------------------- lifecycle

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

    this.registerFlowCards();

    // Best-effort: the cards above work without live updates, they just need an
    // app restart to notice new zones or devices. Never let this break onInit.
    this.watchForChanges().catch((err) => {
      this.error("Could not subscribe to zone/device changes", err);
    });

    this.log("Room lights has been initialized");
  }

  // One line per card. The registration order is part of the app's contract:
  // Homey lists the cards in the order they are registered.
  registerFlowCards() {
    const action = (id, run) =>
      this.registerRoomAutocomplete(this.homey.flow.getActionCard(id).registerRunListener(run));
    const condition = (id, run) =>
      this.registerRoomAutocomplete(this.homey.flow.getConditionCard(id).registerRunListener(run));

    // Deprecated cards: kept registered forever because Advanced Flows use
    // them. Their arguments must not change. They do share the fixed behaviour
    // of the new cards — the excluded filter, and onoff written before dim.
    action("setroomlights", (a) => this.setLightsBrightness(a.room, a.brightness, a.temperature));
    action("setroomlightscolors", (a) => this.setRoomLightsColors(a.room, a.brightness, a.color));

    action("setroomlightsrole", (a) =>
      this.setLightsBrightness(a.room, a.brightness, a.temperature, this.filters(a))
    );
    action("setroomlightscolorsrole", (a) =>
      this.setRoomLightsColors(a.room, a.brightness, a.color, this.filters(a))
    );
    action("turnoffroomlights", (a) => this.turnOffRoomLights(a.room, this.argId(a.role)));
    condition("anyroomlightson", (a) => this.anyLightsOn(a.room, this.argId(a.role)));
    action("dimroomlights", (a) =>
      this.dimRoomLights(a.room, this.argId(a.role), this.argId(a.direction), a.step)
    );
    action("toggleroomlights", (a) => this.toggleRoomLights(a.room, this.argId(a.role), a.brightness));
    action("saveroomlights", (a) => this.saveRoomLights(a.room));
    action("restoreroomlights", (a) => this.restoreRoomLights(a.room));
  }

  /**
   * The zone/device map is a snapshot, so rebuild it whenever Homey's zones or
   * devices change. Without this, anything added after start-up stays invisible
   * until the app restarts.
   */
  async watchForChanges() {
    await this.homeyApi.devices.connect();
    await this.homeyApi.zones.connect();

    for (const event of ["device.create", "device.delete"]) {
      this.homeyApi.devices.on(event, () => this.scheduleRebuild());
    }
    // device.update fires for anything about a device, most of which — became
    // unavailable, settings edited, energy figures — leaves the map identical.
    // Only a move, a rename or a class change can change it, so the rest is
    // ignored rather than costing a house-wide read each time. (Capability
    // values arrive on a separate per-device event, so a fading light should
    // not reach here at all; this holds either way.)
    this.homeyApi.devices.on("device.update", (device) => {
      if (this.topologyChanged(device)) {
        this.scheduleRebuild();
      }
    });
    for (const event of ["zone.create", "zone.delete", "zone.update"]) {
      this.homeyApi.zones.on(event, () => this.scheduleRebuild());
    }
  }

  // The map depends on a device's id, zone, class and name — nothing else.
  //
  // The comparison is against the strings taken at the last rebuild, never
  // against a retained device object: homey-api mutates its cached Device in
  // place *before* it emits, so an old reference would always compare equal.
  topologyChanged(device) {
    // Only a payload that positively shows an unchanged device may be skipped.
    // homey-api forwards the raw server payload when the device is not in its
    // cache, and a partial one must never read as "nothing changed".
    if (device == null || device.id == null || device.zone == null || device.class == null) {
      return true;
    }
    return this.deviceIndex.get(String(device.id)) !== topologyKey(device);
  }

  scheduleRebuild() {
    const now = Date.now();
    if (this.rebuildDeadline == null) {
      this.rebuildDeadline = now + REBUILD_MAX_WAIT_MS;
    }
    // Wait out the burst, but never past the deadline the first event set.
    const wait = Math.max(0, Math.min(REBUILD_DEBOUNCE_MS, this.rebuildDeadline - now));
    this.homey.clearTimeout(this.rebuildTimeout);
    this.rebuildTimeout = this.homey.setTimeout(() => {
      this.rebuildDeadline = null;
      this.buildRoomLightsZones().catch((err) => this.error(err));
    }, wait);
  }

  // ----------------------------------------------------------------- topology

  async buildRoomLightsZones() {
    // A rebuild reads everything anyway, and the topology it produces must not
    // be answered about with state older than itself.
    this.invalidateDevices();
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
    const deviceIndex = new Map();
    for (const device of devices) {
      deviceIndex.set(String(device.id), topologyKey(device));
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
    this.deviceIndex = deviceIndex;
    this.pruneSnapshots();
  }

  // Rooms get deleted; their snapshots would otherwise sit in app settings
  // forever. Never prune against an empty map — a read that came back with no
  // zones at all is a failure, not a house with no rooms.
  pruneSnapshots() {
    const all = this.homey.settings.get("lightSnapshots");
    if (all == null || Object.keys(this.myHome).length === 0) {
      return;
    }
    const stale = Object.keys(all).filter((roomId) => this.myHome[roomId] == null);
    if (stale.length === 0) {
      return;
    }
    for (const roomId of stale) {
      delete all[roomId];
    }
    this.homey.settings.set("lightSnapshots", all);
  }

  // ------------------------------------------------------------ card arguments

  // ponytail: dropdown args arrive as the value's id; tolerate the whole object
  // too, so a Homey version that passes it does not break the card.
  argId(value) {
    if (value == null) {
      return null;
    }
    return typeof value === "string" ? value : value.id;
  }

  // The filter arguments every role-aware card shares.
  filters(args) {
    return {
      role: this.argId(args.role),
      state: this.argId(args.state),
      duration: args.duration,
    };
  }

  registerRoomAutocomplete(card) {
    return card.registerArgumentAutocompleteListener("room", async (query) => {
      const needle = query.toLowerCase();
      return this.zoneFilter.filter((zone) => zone.name.toLowerCase().includes(needle));
    });
  }

  // -------------------------------------------------------------- choosing lights

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

  // Treat the device objects in myHome as a snapshot. homey-api only patches
  // capability values into its cache while the realtime subscription is up —
  // that is what makeCapabilityInstance() exists for — so a cached onoff would
  // silently make the "only lights already on" filter wrong the moment it is
  // not. Anything needing current state reads through here, and only when it
  // actually needs it.
  //
  // Concurrent callers share one request, and a result is reused for
  // DEVICE_CACHE_MS.
  //
  // A read that was already in flight when we wrote carries pre-write state, so
  // it may neither be joined by a later caller nor land in the cache. Dropping
  // the cache alone is not enough: while disconnected a read is a real
  // round-trip, so a write can easily complete inside one, and the pending
  // promise would then re-seed the cache with what was true before it.
  // deviceGen marks the boundary; a fetch is only usable within its own
  // generation.
  async freshDevices() {
    if (this.deviceCache != null && Date.now() - this.deviceCacheAt < DEVICE_CACHE_MS) {
      return this.deviceCache;
    }
    const generation = this.deviceGen;
    if (this.deviceFetch == null || this.deviceFetchGen !== generation) {
      this.deviceFetchGen = generation;
      this.deviceFetch = this.homeyApi.devices.getDevices().then(
        (devices) => {
          if (this.deviceGen === generation) {
            this.deviceCache = devices;
            this.deviceCacheAt = Date.now();
            this.deviceFetch = null;
          }
          return devices;
        },
        (err) => {
          // Leave a newer generation's fetch alone; only clear our own, so the
          // next caller retries instead of joining a promise that already
          // rejected.
          if (this.deviceGen === generation) {
            this.deviceFetch = null;
          }
          throw err;
        }
      );
    }
    return this.deviceFetch;
  }

  invalidateDevices() {
    this.deviceCache = null;
    this.deviceGen += 1;
  }

  async roomLights(room, role, state) {
    const zone = this.myHome[room.id];
    if (zone == null || zone.devices.light == null) {
      return [];
    }

    const roles = this.lightRoles();
    const wantedRole = role == null ? "all" : role;
    const onlyOn = state === "on";
    const live = onlyOn ? await this.freshDevices() : null;

    return zone.devices.light.filter((device) => {
      const deviceRole = roles[device.id] || DEFAULT_ROLE;
      if (deviceRole === ROLE_EXCLUDED) {
        return false;
      }
      if (wantedRole !== "all" && deviceRole !== wantedRole) {
        return false;
      }
      if (!onlyOn) {
        return true;
      }
      // A light that disappeared since the last rebuild is not on.
      const current = live[device.id];
      return current != null && this.isOn(current);
    });
  }

  // Backs the condition card and the toggle. Note the isOn() convention leaks
  // through here: a light whose onoff state is unknown counts as on.
  async anyLightsOn(room, role) {
    return (await this.roomLights(room, role, "on")).length > 0;
  }

  // --------------------------------------------------------- writing to lights

  // Homey fades a capability write when a duration (ms) is given, and it has to
  // be nested under `opts` — homey-api destructures { capabilityId, value, opts }
  // and its API spec declares only value/opts/transactionId as body parameters,
  // so a duration passed as a sibling of `value` is silently dropped and the
  // light snaps instead of fading. See node-homey-api Device.js
  // #setCapabilityValue: `@param {number} [opts.opts.duration]`.
  async write(device, capabilityId, value, duration) {
    // Our own command makes every cached read of this house stale.
    this.invalidateDevices();
    await device.setCapabilityValue(capabilityId, value, duration == null ? undefined : { duration });
  }

  // One unreachable bulb is normal in a Zigbee/Z-Wave room and must not abort
  // the whole card: the other lights have already been told what to do. Log
  // each failure, and only fail the Flow when nothing at all could be reached.
  async eachLight(lights, run) {
    const results = await Promise.allSettled(lights.map(run));
    const failed = results.filter((result) => result.status === "rejected");
    for (const failure of failed) {
      this.error("Could not command a light", failure.reason);
    }
    if (failed.length > 0 && failed.length === results.length) {
      throw failed[0].reason;
    }
  }

  // Shared body of every "set the lights" card. Brightness 0 means off; any
  // other brightness means on at that level, with onoff written first because
  // writing dim alone leaves a light that was off in a device-dependent state.
  // `tint` writes whatever colour aspect the calling card carries, if any.
  async applyBrightness(room, brightness, options, tint) {
    const opts = options || {};
    const lights = await this.roomLights(room, opts.role, opts.state);
    await this.eachLight(lights, async (device) => {
      if (brightness === 0) {
        await this.write(device, "onoff", false, opts.duration);
        return;
      }
      await this.write(device, "onoff", true);
      await this.write(device, "dim", brightness, opts.duration);
      await tint(device, opts.duration);
    });
  }

  async setLightsBrightness(room, brightness, temperature, options) {
    await this.applyBrightness(room, brightness, options, async (device, duration) => {
      if (temperature != null && device.capabilities.includes("light_temperature")) {
        await this.write(device, "light_temperature", temperature, duration);
      }
    });
  }

  async setLightsColors(room, brightness, hue, saturation, options) {
    await this.applyBrightness(room, brightness, options, async (device, duration) => {
      // Lights without a hue capability just take the brightness.
      if (device.capabilities.includes("light_hue")) {
        await this.write(device, "light_hue", hue, duration);
        await this.write(device, "light_saturation", saturation, duration);
      }
    });
  }

  async setRoomLightsColors(room, brightness, color, options) {
    const [hue, saturation] = this.parseHexToHSV(color);
    await this.setLightsColors(room, brightness, hue, saturation, options);
  }

  async turnOffRoomLights(room, role) {
    const lights = await this.roomLights(room, role);
    await this.eachLight(lights, (device) => this.write(device, "onoff", false));
  }

  // Relative dim only touches lights that are already on: dimming "up" must
  // not wake a lamp nobody switched on. Unlike isOn(), an unreadable state
  // means skip — a relative change needs a base value to be meaningful.
  async dimRoomLights(room, role, direction, step) {
    const fresh = await this.freshDevices();
    const delta = direction === "down" ? -step : step;
    const lights = await this.roomLights(room, role);
    await this.eachLight(lights, async (device) => {
      const caps = fresh[device.id] && fresh[device.id].capabilitiesObj;
      if (caps == null || caps.onoff == null || caps.onoff.value !== true) {
        return;
      }
      if (caps.dim == null || typeof caps.dim.value !== "number") {
        return;
      }
      const dim = Math.min(1, Math.max(0, caps.dim.value + delta));
      if (dim === 0) {
        await this.write(device, "onoff", false);
        return;
      }
      await this.write(device, "dim", dim);
    });
  }

  async toggleRoomLights(room, role, brightness) {
    if (await this.anyLightsOn(room, role)) {
      await this.turnOffRoomLights(room, role);
      return;
    }
    // No temperature: the lights come on at the given brightness and keep
    // whatever colour or temperature they last had.
    await this.setLightsBrightness(room, brightness, null, { role });
  }

  // ---------------------------------------------------------------- snapshots

  // A snapshot covers the whole room minus excluded lights — save/restore is
  // "movie mode, then back to what it was", not a role tool. Snapshots live in
  // app settings so they survive an app restart.
  async saveRoomLights(room) {
    const fresh = await this.freshDevices();
    const snapshot = {};
    for (const device of await this.roomLights(room)) {
      const caps = fresh[device.id] && fresh[device.id].capabilitiesObj;
      if (caps == null) {
        continue;
      }
      const entry = { onoff: caps.onoff == null ? true : caps.onoff.value === true };
      for (const cap of SNAPSHOT_CAPABILITIES) {
        if (caps[cap] != null && typeof caps[cap].value === "number") {
          entry[cap] = caps[cap].value;
        }
      }
      snapshot[device.id] = entry;
    }
    const all = this.homey.settings.get("lightSnapshots") || {};
    all[room.id] = snapshot;
    this.homey.settings.set("lightSnapshots", all);
  }

  async restoreRoomLights(room) {
    const all = this.homey.settings.get("lightSnapshots") || {};
    const snapshot = all[room.id];
    if (snapshot == null) {
      // Silently doing nothing here just looks like the card is broken.
      throw new Error("No lights saved for this room yet — run the save card first.");
    }
    const lights = await this.roomLights(room);
    await this.eachLight(lights, async (device) => {
      const saved = snapshot[device.id];
      if (saved == null) {
        return;
      }
      if (saved.onoff !== true) {
        await this.write(device, "onoff", false);
        return;
      }
      await this.write(device, "onoff", true);
      for (const cap of SNAPSHOT_CAPABILITIES) {
        if (saved[cap] != null && device.capabilities.includes(cap)) {
          await this.write(device, cap, saved[cap]);
        }
      }
    });
  }

  // ------------------------------------------------------------------- colour

  // Homey's light_hue / light_saturation / dim triple is HSV — dim is the value
  // channel — so the saturation has to be the HSV one. The HSL formula this
  // used to apply over-saturates everything pale: #ffc0c0 has an HSL saturation
  // of 1.0, so a pastel pink arrived at the bulb as pure red. Hue is identical
  // in both models; only saturation (and the unused third channel) change.
  parseHexToHSV(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      throw new Error(`Not a colour: ${hex}`);
    }
    const r = parseInt(hex.substring(1, 3), 16) / 255;
    const g = parseInt(hex.substring(3, 5), 16) / 255;
    const b = parseInt(hex.substring(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (max === min) {
      // Grey has no hue and no saturation, only a value.
      return [0, 0, +max.toFixed(3)];
    }

    const d = max - min;
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

    return [+h.toFixed(3), +(d / max).toFixed(3), +max.toFixed(3)];
  }

  // ------------------------------------------------------- settings page API

  getLightsByZone() {
    const roles = this.lightRoles();
    const zones = [];

    // Every zone, including the "_"-prefixed ones hidden from the room picker.
    // Those lights are still reached by cards targeting an ancestor zone, and
    // the settings page replaces the whole role map — so a light it cannot see
    // is a light whose role the next unrelated save would silently wipe.
    for (const zone of Object.values(this.myHome)) {
      if (zone.devices.light == null) {
        continue;
      }
      // Only the lights that actually live in this zone. The rollup puts child
      // devices in ancestor zones too, which would list a light many times.
      const lights = zone.devices.light
        .filter((device) => device.zone === zone.id)
        .map((device) => ({
          id: device.id,
          name: device.name,
          role: roles[device.id] || DEFAULT_ROLE,
        }));
      if (lights.length === 0) {
        continue;
      }
      zones.push({ id: zone.id, name: zone.name, lights: lights });
    }

    return zones;
  }

  setLightRoles(roles) {
    const known = new Set();
    for (const zone of Object.values(this.myHome)) {
      for (const device of zone.devices.light || []) {
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
}

module.exports = RoomLights;
