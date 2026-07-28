"use strict";

const Homey = require("homey");
const { HomeyAPI } = require("homey-api");

// Rebuilds are debounced so a burst of events (pairing several devices, a
// dimming light emitting device.update) collapses into a single rebuild.
const REBUILD_DEBOUNCE_MS = 5000;

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

    // Setup RoomLights variables
    await this.buildRoomLightsZones();
    await this.watchForChanges();

    // Register cards
    this.homey.flow
      .getActionCard("setroomlights")
      .registerRunListener(async (args) => {
        const { room, brightness, temperature } = args;
        await this.setLightsBrightness(room, brightness, temperature);
      })
      .registerArgumentAutocompleteListener("room", async (query) => {
        return this.zoneFilter.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase());
        });
      });

    this.homey.flow
      .getActionCard("setroomlightscolors")
      .registerRunListener(async (args) => {
        const { room, brightness, color } = args;
        await this.setRoomLightsColors(room, brightness, color);
      })
      .registerArgumentAutocompleteListener("room", async (query) => {
        return this.zoneFilter.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase());
        });
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
        zone.devices[device.class] ??= [];
        zone.devices[device.class].push(device);
      }
    }

    this.myHome = myHome;
  }

  roomLights(room) {
    return this.myHome[room.id]?.devices["light"] ?? [];
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

  async setLightsBrightness(room, brightness, temperature) {
    await Promise.all(
      this.roomLights(room).map(async (device) => {
        if (brightness === 0) {
          await device.setCapabilityValue("onoff", false);
          return;
        }
        await device.setCapabilityValue("dim", brightness);
        if (device.capabilities.includes("light_temperature")) {
          await device.setCapabilityValue("light_temperature", temperature);
        }
      })
    );
  }

  async setLightsColors(room, brightness, color, saturation) {
    await Promise.all(
      this.roomLights(room).map(async (device) => {
        if (brightness === 0) {
          await device.setCapabilityValue("onoff", false);
          return;
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

  async setRoomLightsColors(room, brightness, color) {
    const [h, s] = this.parseHexToHSL(color);
    await this.setLightsColors(room, brightness, h, s);
  }
}

module.exports = RoomLights;
