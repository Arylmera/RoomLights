"use strict";

const Homey = require("homey");
const { HomeyAPI } = require("homey-api");
const {
  MODELLED_SOURCE,
  daylightBrightness,
  modelledLux,
  validDaylight,
} = require("./lib/daylight");

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

// Logic variables are read the same way, but need no invalidation: the app only
// ever reads them, so nothing it does can make a read stale. They move on a
// schedule (a circadian Flow), never per keypress, so this only exists to keep
// a held wall button from turning every card repeat into a round-trip.
const VARIABLE_CACHE_MS = 1000;

// A light's role is stored only when it is not the default, so an unconfigured
// app behaves exactly as it did before roles existed.
const DEFAULT_ROLE = "main";
const ROLE_EXCLUDED = "excluded";

// Brightness at or below this means off, not "on at a hair above nothing".
// Treating only an exact 0 as off is a strict equality against a number that
// usually comes out of a circadian formula, and such a formula reaches "dark"
// as a small float far more often than as a clean zero — a room asked for
// 0.0345 was coming on at 3% and glowing. Overridable in the app settings,
// where 0 restores the old exact-zero behaviour.
const DEFAULT_OFF_BELOW = 0.05;

// How far the daylight-adjusted brightness has to move before it is worth
// writing. Without it, a room on a twitchy sensor would command every light it
// owns every five minutes for a change nobody can see — Zigbee traffic rather
// than lighting. With it, the loop settles on a fixed point instead of
// creeping around one.
const DAYLIGHT_DEADBAND = 0.03;

// A modelled room has no sensor to wake it, so it re-evaluates on a timer. Five
// minutes is the cadence a Hue sensor reports at, so both kinds of room move at
// the same speed and neither can outrun the other.
const MODELLED_INTERVAL_MS = 5 * 60 * 1000;

// A cloudiness reading older than this is not describing the sky now. The
// weather device this was written against sat frozen for three weeks while
// still answering with an entirely plausible number, so nothing but the
// timestamp can tell the difference.
const WEATHER_STALE_MS = 3 * 60 * 60 * 1000;

const LUX_CAPABILITY = "measure_luminance";
const CLOUD_CAPABILITY = "measure_cloudiness";

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

  // Logic variables, see logicVariables().
  variableCache = null;
  variableCacheAt = 0;
  variableFetch = null;

  // id -> topologyKey() as of the last rebuild, see topologyChanged().
  deviceIndex = new Map();
  rebuildDeadline = null;

  // room id -> what a room currently tracking daylight needs to keep going, see
  // armDaylight(). Held in memory only: a restart clears it, and the next
  // automatic card re-arms whatever a Flow still wants.
  daylightTracking = new Map();

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
    action("setroomlightsauto", (a) => this.setRoomLightsAuto(a.room, this.filters(a)));
    action("stopdaylighttracking", (a) => this.stopDaylightTracking(a.room));
  }

  // Every listener this app owns outlives a single card, so a shutdown that
  // left them running would keep a torn-down app writing to bulbs.
  async onUninit() {
    this.disarmAllDaylight();
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
    // A rebuild replaces every Device object in the map, and a capability
    // instance is bound to the object it was made from. Keeping the old ones
    // would leak a listener per rebuild against a device nobody holds any more,
    // so tracking stops here and a Flow re-arms it on the next automatic card.
    this.disarmAllDaylight();

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
    this.pruneByRoom("lightSnapshots");
    this.pruneByRoom("roomDefaults");
    this.pruneByRoom("daylight");
  }

  // Rooms get deleted; anything keyed by room would otherwise sit in app
  // settings forever. Never prune against an empty map — a read that came back
  // with no zones at all is a failure, not a house with no rooms.
  pruneByRoom(key) {
    const all = this.homey.settings.get(key);
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
    this.homey.settings.set(key, all);
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

  // A usable fraction of full brightness, or null. Shared by the reader and the
  // writer so the two can never disagree about what a valid threshold is.
  validOffBelow(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return null;
    }
    return value;
  }

  // A corrupted setting must never be the reason the app stops turning lights
  // off, so anything unusable falls back to the default rather than to 0.
  offBelow() {
    const stored = this.validOffBelow(this.homey.settings.get("offBelow"));
    return stored == null ? DEFAULT_OFF_BELOW : stored;
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

  // Shared body of every "set the lights" card, and the only place the off
  // threshold is applied on this path — a guard per card would be a larger diff
  // that still left the next card to be written broken. Brightness at or below
  // the threshold means off; any brightness above it means on at that level,
  // with onoff written first because writing dim alone leaves a light that was
  // off in a device-dependent state. `tint` writes whatever colour aspect the
  // calling card carries, if any.
  async applyBrightness(room, brightness, options, tint) {
    const opts = options || {};
    const lights = await this.roomLights(room, opts.role, opts.state);
    const offBelow = this.offBelow();
    await this.eachLight(lights, async (device) => {
      if (brightness <= offBelow) {
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
    // The same threshold as the set-cards: without it, holding "down" stalls at
    // a glow instead of arriving at off.
    const offBelow = this.offBelow();
    await this.eachLight(lights, async (device) => {
      const caps = fresh[device.id] && fresh[device.id].capabilitiesObj;
      if (caps == null || caps.onoff == null || caps.onoff.value !== true) {
        return;
      }
      if (caps.dim == null || typeof caps.dim.value !== "number") {
        return;
      }
      const dim = Math.min(1, Math.max(0, caps.dim.value + delta));
      if (dim <= offBelow) {
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

  // ------------------------------------------------------------ room defaults

  // room id -> { brightness, temperature } Logic variable ids. Variables are
  // referenced by id, not by name: renaming "Salon - Temp" in Homey must not
  // quietly unhook the room.
  roomDefaults() {
    return this.homey.settings.get("roomDefaults") || {};
  }

  // See VARIABLE_CACHE_MS. Concurrent callers share one request.
  async logicVariables() {
    if (this.variableCache != null && Date.now() - this.variableCacheAt < VARIABLE_CACHE_MS) {
      return this.variableCache;
    }
    if (this.variableFetch == null) {
      this.variableFetch = this.homeyApi.logic.getVariables().then(
        (variables) => {
          this.variableCache = variables;
          this.variableCacheAt = Date.now();
          this.variableFetch = null;
          return variables;
        },
        (err) => {
          // Clear it, so the next caller retries instead of joining a promise
          // that already rejected.
          this.variableFetch = null;
          throw err;
        }
      );
    }
    return this.variableFetch;
  }

  // A capability value, or null when the variable is gone or holds something
  // that is not a number — a Logic variable can be deleted or retyped at any
  // time, and NaN must never reach a bulb.
  variableValue(variables, id) {
    const variable = id == null ? null : variables[id];
    if (variable == null || typeof variable.value !== "number" || !Number.isFinite(variable.value)) {
      return null;
    }
    return Math.min(1, Math.max(0, variable.value));
  }

  // Brightness is what makes the card mean anything, so a missing one fails
  // loudly: staying silent looks exactly like a broken card. A missing
  // temperature is a room that is simply not tinted, which the write path
  // already expresses as null.
  async roomDefaultValues(room) {
    const mapping = this.roomDefaults()[room.id] || {};
    const variables = await this.logicVariables();
    const brightness = this.variableValue(variables, mapping.brightness);
    if (brightness == null) {
      throw new Error(`No brightness variable mapped for ${room.name || room.id} — set one in the app settings.`);
    }
    return { brightness, temperature: this.variableValue(variables, mapping.temperature) };
  }

  async setRoomLightsAuto(room, options) {
    const target = await this.applyRoomAuto(room, options);
    await this.armDaylight(room, options, target);
  }

  // Shared by the automatic card and by every daylight re-evaluation, so the
  // two can never drift apart on what a room's automatic brightness means.
  async applyRoomAuto(room, options) {
    const { brightness, temperature } = await this.roomDefaultValues(room);
    const target = await this.daylightAdjusted(room, brightness);
    await this.setLightsBrightness(room, target, temperature, options);
    return target;
  }

  // ------------------------------------------------------------------ daylight

  // room id -> { source, dark, bright, swing }. Validated on the way out rather
  // than trusted, so a hand-edited or half-migrated entry reads as "this room
  // has no daylight" — today's behaviour — instead of as something to divide by.
  daylightSettings() {
    return this.homey.settings.get("daylight") || {};
  }

  roomDaylight(roomId) {
    return validDaylight(this.daylightSettings()[roomId]);
  }

  weatherDeviceId() {
    const stored = this.homey.settings.get("weatherDevice");
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  }

  // The house's own coordinates, which is all the solar model needs. A Homey
  // too old to have the manager, or one where the permission was refused, has
  // no modelled daylight at all — the settings page reports that as a missing
  // reading, and armDaylight() logs it once rather than every five minutes.
  geolocation() {
    const manager = this.homey.geolocation;
    if (manager == null) {
      return null;
    }
    try {
      const latitude = manager.getLatitude();
      const longitude = manager.getLongitude();
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        return null;
      }
      return { latitude, longitude };
    } catch (err) {
      return null;
    }
  }

  // A numeric capability value from a live read, with the age of the reading.
  // Null for every ordinary way a device id stored in settings months ago stops
  // meaning anything: the device is gone, it never had the capability, it lost
  // it in a driver update, or the value is not a number.
  async capabilityReading(deviceId, capabilityId) {
    if (deviceId == null) {
      return null;
    }
    const devices = await this.freshDevices();
    const device = devices[deviceId];
    const caps = device == null ? null : device.capabilitiesObj;
    const entry = caps == null ? null : caps[capabilityId];
    if (entry == null || typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      return null;
    }
    const stamp = entry.lastUpdated == null ? NaN : new Date(entry.lastUpdated).getTime();
    return { value: entry.value, updatedAt: Number.isFinite(stamp) ? stamp : null };
  }

  // The cloudiness term, or null to drop it. Null is the right answer to every
  // way this can go wrong, because dropping the term leaves a clean clear-sky
  // curve while trusting a dead one steers the lights from a forecast that
  // expired weeks ago — which is the failure this house actually had. A reading
  // carrying no timestamp at all is taken at face value: absent is not stale.
  async cloudiness() {
    const reading = await this.capabilityReading(this.weatherDeviceId(), CLOUD_CAPABILITY);
    if (reading == null) {
      return null;
    }
    if (reading.updatedAt != null && Date.now() - reading.updatedAt > WEATHER_STALE_MS) {
      return null;
    }
    return reading.value;
  }

  // Whatever the room's configured source says the daylight is, in lux.
  async daylightLux(config) {
    if (config.source === MODELLED_SOURCE) {
      const where = this.geolocation();
      if (where == null) {
        return null;
      }
      return modelledLux(where.latitude, where.longitude, new Date(), await this.cloudiness());
    }
    const reading = await this.capabilityReading(config.source, LUX_CAPABILITY);
    return reading == null ? null : reading.value;
  }

  // The circadian brightness, moved by daylight. A room with no daylight
  // configured — and a room whose reading cannot be had — gets the circadian
  // value untouched, which is what it got before this feature existed.
  async daylightAdjusted(room, circadian) {
    const config = this.roomDaylight(room.id);
    if (config == null) {
      return circadian;
    }
    return daylightBrightness(circadian, await this.daylightLux(config), config);
  }

  // Start correcting a room as its daylight moves. A sensor room rides the
  // sensor's own reports, which is the loop rate the hardware already imposes;
  // a modelled room has nothing to wake it, so it runs on a timer at the same
  // cadence.
  async armDaylight(room, options, lastWritten) {
    const config = this.roomDaylight(room.id);
    if (config == null) {
      // The room may have been tracking before its source was cleared.
      this.disarmDaylight(room.id);
      return;
    }

    const existing = this.daylightTracking.get(room.id);
    if (existing != null && existing.source === config.source) {
      // Re-running the card on a room already tracking the same source must not
      // stack a second listener on it. Only what the card carried is refreshed.
      existing.room = room;
      existing.options = options;
      existing.lastWritten = lastWritten;
      return;
    }
    this.disarmDaylight(room.id);

    const where = room.name || room.id;
    const tick = () =>
      this.reviewDaylight(room.id).catch((err) => this.error(`Daylight review failed for ${where}`, err));
    const entry = { room, options, lastWritten, source: config.source, instance: null, timer: null };
    this.daylightTracking.set(room.id, entry);

    if (config.source === MODELLED_SOURCE) {
      if (this.geolocation() == null) {
        this.error(`No geolocation for the modelled daylight of ${where}; check the app's permissions.`);
      }
      entry.timer = this.homey.setInterval(tick, MODELLED_INTERVAL_MS);
      return;
    }

    // A sensor that has been unpaired since it was mapped leaves the room on
    // plain circadian brightness. Tracking it would subscribe to nothing and
    // only make the settings page look like it is working.
    const devices = await this.freshDevices();
    const sensor = devices[config.source];
    try {
      entry.instance = sensor.makeCapabilityInstance(LUX_CAPABILITY, tick);
    } catch (err) {
      this.error(`Could not follow the lux sensor mapped to ${where}`, err);
      this.disarmDaylight(room.id);
    }
  }

  disarmDaylight(roomId) {
    const entry = this.daylightTracking.get(roomId);
    if (entry == null) {
      return;
    }
    // Dropped first, so a destroy that throws still leaves the room untracked
    // rather than stuck with a listener nothing can reach.
    this.daylightTracking.delete(roomId);
    if (entry.instance != null) {
      try {
        entry.instance.destroy();
      } catch (err) {
        this.error("Could not release a lux subscription", err);
      }
    }
    if (entry.timer != null) {
      this.homey.clearInterval(entry.timer);
    }
  }

  disarmAllDaylight() {
    for (const roomId of [...this.daylightTracking.keys()]) {
      this.disarmDaylight(roomId);
    }
  }

  // The card a mood Flow carries. homey-api exposes no moods manager and so no
  // mood event an app can subscribe to, which makes saying so explicitly the
  // only way a mood can stop this app correcting a room five minutes later.
  stopDaylightTracking(room) {
    if (room != null && room.id != null) {
      this.disarmDaylight(room.id);
    }
  }

  async reviewDaylight(roomId) {
    const entry = this.daylightTracking.get(roomId);
    if (entry == null) {
      return;
    }

    // A room with nothing on is a room to stop correcting. This is also how
    // daylight stops itself: once the target falls through the off threshold
    // the room goes dark, and the next reading disarms instead of waking it up
    // again at dusk. Turning a room back on is a Flow's decision, never this
    // app's — the same rule relative dimming already follows.
    if (!(await this.anyLightsOn(entry.room, null))) {
      this.disarmDaylight(roomId);
      return;
    }

    const { brightness, temperature } = await this.roomDefaultValues(entry.room);
    const target = await this.daylightAdjusted(entry.room, brightness);

    // Those awaits are real round-trips, and a stop card or a rebuild during
    // one must win.
    if (this.daylightTracking.get(roomId) !== entry) {
      return;
    }
    if (entry.lastWritten != null && Math.abs(target - entry.lastWritten) <= DAYLIGHT_DEADBAND) {
      return;
    }

    entry.lastWritten = target;
    await this.setLightsBrightness(entry.room, target, temperature, entry.options);
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

  // Everything the defaults section of the settings page needs, in one read.
  // Only the rooms the card can target are offered, and only number variables:
  // brightness and temperature are both 0-1 numbers.
  async getRoomDefaultsPage() {
    const variables = Object.values(await this.logicVariables())
      .filter((variable) => variable.type === "number")
      .map((variable) => ({ id: variable.id, name: variable.name }));
    return {
      rooms: this.zoneFilter,
      variables,
      mappings: this.roomDefaults(),
      offBelow: this.offBelow(),
      ...(await this.daylightPage()),
    };
  }

  // Everything the daylight section of the page needs, including each source's
  // current reading. Choosing a dark and a bright anchor blind is the one part
  // of this a person cannot do from the settings page alone, and the
  // alternative is a round trip through Insights for every room.
  async daylightPage() {
    const devices = Object.values(await this.freshDevices());
    const reading = (device, capabilityId) => {
      const entry = device.capabilitiesObj == null ? null : device.capabilitiesObj[capabilityId];
      return entry != null && typeof entry.value === "number" ? entry.value : null;
    };
    const listing = (capabilityId) =>
      devices
        .filter((device) => (device.capabilities || []).includes(capabilityId))
        .map((device) => ({ id: device.id, name: device.name, value: reading(device, capabilityId) }));

    const where = this.geolocation();
    return {
      daylight: this.daylightSettings(),
      luxSources: listing(LUX_CAPABILITY),
      weatherSources: listing(CLOUD_CAPABILITY),
      weather: this.weatherDeviceId(),
      // Null means the model cannot run at all — no geolocation — which the
      // page says out loud rather than showing a plausible zero.
      modelled:
        where == null
          ? null
          : modelledLux(where.latitude, where.longitude, new Date(), await this.cloudiness()),
    };
  }

  // The ids of every device currently exposing a capability. Used to refuse a
  // saved source that no longer measures what it was picked for — a weather
  // device replaced in place is how this house lost `measure_ultraviolet`.
  async devicesWith(capabilityId) {
    const devices = Object.values(await this.freshDevices());
    return new Set(
      devices
        .filter((device) => (device.capabilities || []).includes(capabilityId))
        .map((device) => String(device.id))
    );
  }

  // The page sends the whole map back, so anything it could not see would be
  // wiped by an unrelated edit. It sees every room in the picker and every
  // number variable, which is exactly what is kept here.
  //
  // The off threshold rides along on the same save. It belongs to the same
  // section of the page, and a scalar does not earn a route of its own.
  async setRoomDefaults(body) {
    const variables = await this.logicVariables();
    const isNumberVariable = (id) =>
      id != null && variables[id] != null && variables[id].type === "number";
    const rooms = new Set(this.zoneFilter.map((zone) => zone.id));

    const valid = {};
    const input = (body && body.mappings) || {};
    for (const roomId of Object.keys(input)) {
      if (!rooms.has(roomId)) {
        continue;
      }
      const entry = {};
      for (const kind of ["brightness", "temperature"]) {
        if (isNumberVariable(input[roomId][kind])) {
          entry[kind] = input[roomId][kind];
        }
      }
      // A room with no brightness variable has nothing worth storing: the card
      // fails on it either way.
      if (entry.brightness != null) {
        valid[roomId] = entry;
      }
    }

    this.homey.settings.set("roomDefaults", valid);

    // An unusable threshold is dropped rather than stored, so a bad save cannot
    // leave state that offBelow() then has to paper over.
    const threshold = this.validOffBelow(body && body.offBelow);
    if (threshold != null) {
      this.homey.settings.set("offBelow", threshold);
    }

    await this.setDaylight(body);
    return {
      mappings: valid,
      offBelow: this.offBelow(),
      daylight: this.daylightSettings(),
      weather: this.weatherDeviceId(),
    };
  }

  // Daylight rides on the same save, for the same reason the threshold does: it
  // belongs to the same section of the page, and the page sends the whole map
  // back either way.
  //
  // Every entry goes through the reader's own validator, so the page can never
  // store something the reader would then have to paper over, and a source is
  // refused unless a device that still measures it can be found.
  async setDaylight(body) {
    const rooms = new Set(this.zoneFilter.map((zone) => zone.id));
    const luxDevices = await this.devicesWith(LUX_CAPABILITY);
    const cloudDevices = await this.devicesWith(CLOUD_CAPABILITY);

    const daylight = {};
    const offered = (body && body.daylight) || {};
    for (const roomId of Object.keys(offered)) {
      const entry = rooms.has(roomId) ? validDaylight(offered[roomId]) : null;
      if (entry == null) {
        continue;
      }
      if (entry.source !== MODELLED_SOURCE && !luxDevices.has(String(entry.source))) {
        continue;
      }
      daylight[roomId] = entry;
    }
    this.homey.settings.set("daylight", daylight);

    const weather = body && body.weather;
    this.homey.settings.set(
      "weatherDevice",
      typeof weather === "string" && cloudDevices.has(weather) ? weather : null
    );

    // A room whose anchors or source just changed is still being corrected
    // against the old ones. Stopping every tracker is cheaper than working out
    // which changed, and a Flow re-arms whatever it still wants within minutes.
    this.disarmAllDaylight();
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
