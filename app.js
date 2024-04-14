"use strict";

const Homey = require("homey");
const { HomeyAPI } = require("homey-api");

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

    // Refegister cards
    this.homey.flow
      .getActionCard("setRoomlights")
      .registerRunListener(async (args) => {
        const { room, brightness, temperature } = args;
        await this.setLightsBrightness(room, brightness, temperature);
      })
      .registerArgumentAutocompleteListener("room", async (query, args) => {
        return this.zoneFilter.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase()) || zone.name.toLowerCase() == query.toLowerCase();
        });
      });

    this.homey.flow
      .getActionCard("setRoomAmbiance")
      .registerRunListener(async (args) => {
        const { room, brightness, temperature } = args;
        await this.setLightsAmbianceBrightness(room, brightness, temperature);
      })
      .registerArgumentAutocompleteListener("room", async (query, args) => {
        return this.zoneFilter.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase()) || zone.name.toLowerCase() == query.toLowerCase();
        });
      });

    this.homey.flow
      .getActionCard("setRoomlightscolors")
      .registerRunListener(async (args) => {
        const { room, brightness, color } = args;
        await this.setRoomLightsColors(room, brightness, color);
      })
      .registerArgumentAutocompleteListener("room", async (query, args) => {
        return this.zoneFilter.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase()) || zone.name.toLowerCase() == query.toLowerCase();
        });
      });

    this.log("Room lights has been initialized");
  }

  async buildRoomLightsZones() {
    const homeyZones = Object.values(await this.homeyApi.zones.getZones());
    const devices = Object.values(await this.homeyApi.devices.getDevices());

    for (const zone of homeyZones.values()) {
      if (!zone.name.startsWith("_")) {
        let zoneFilter = {};
        zoneFilter.id = zone.id;
        zoneFilter.name = zone.name;
        this.zoneFilter.push(zoneFilter);
      }
    }

    // Build by home
    for (const zone of homeyZones) {
      const room = {
        id: zone.id,
        name: zone.name,
        parentId: zone.parent,
        devices: {},
      };
      this.myHome[zone.id] = room;
    }
    for (const device of devices) {
      if (this.myHome[device.zone].devices[device.class] == null) {
        this.myHome[device.zone].devices[device.class] = [];
      }
      this.myHome[device.zone].devices[device.class].push(device);
    }
    // add all childs devices to parent
    for (const room of Object.keys(this.myHome)) {
      if (this.myHome[room].parentId != null) {
        for (const type in this.myHome[room].devices) {
          if (this.myHome[this.myHome[room].parentId].devices[type]) {
            this.myHome[this.myHome[room].parentId].devices[type].concat(this.myHome[room].devices[type]);
          } else {
            this.myHome[this.myHome[room].parentId].devices[type] = this.myHome[room].devices[type];
          }
        }
      }
    }
  }

  parseHexToHSL(hex) {
    let b = parseInt(hex.substring(5, 7), 16) / 255;
    let g = parseInt(hex.substring(3, 5), 16) / 255;
    let r = parseInt(hex.substring(1, 3), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = (max + min) / 2;
    let s = (max + min) / 2;
    const l = (max + min) / 2;

    if (max === min) {
      h = 0;
      s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
        default:
          break;
      }
      h /= 6;
    }
    return [+h.toFixed(3), +s.toFixed(3), +l.toFixed(3)];
  }

  async setLightsBrightness(room, brightness, temperature) {
    let impactedDevices = this.myHome[room.id].devices["light"];
    impactedDevices.forEach(async (device) => {
      if (brightness !== 0) {
        device.setCapabilityValue("dim", brightness);
        if (device.capabilities.includes("light_temperature")) {
          await device.setCapabilityValue("light_temperature", temperature);
        }
      } else {
        await device.setCapabilityValue("onoff", false);
      }
    });
  }

  async setLightsAmbianceBrightness(room, brightness, temperature) {
    let impactedDevices = this.myHome[room.id].devices["light"];
    impactedDevices.forEach(async (device) => {
      const ambianceLight = device.name.includes("-A");
      if (ambianceLight && brightness !== 0) {
        device.setCapabilityValue("dim", brightness);
        if (device.capabilities.includes("light_temperature")) {
          await device.setCapabilityValue("light_temperature", temperature);
        }
      } else {
        await device.setCapabilityValue("onoff", false);
      }
    });
  }

  async setLightsColors(room, brightness, color, saturation) {
    this.myHome[room.id].devices["light"].forEach(async (device) => {
      if (device.capabilities.includes("light_hue")) {
        await device.setCapabilityValue("light_hue", color);
        await device.setCapabilityValue("light_saturation", saturation);
      } else {
        await device.setCapabilityValue("onoff", false);
      }
      if (brightness !== 0) {
        device.setCapabilityValue("dim", brightness);
      } else {
        await device.setCapabilityValue("onoff", false);
      }
    });
  }

  async setRoomLightsColors(room, brightness, color) {
    let [h, s, l] = this.parseHexToHSL(color);
    this.setLightsColors(room, brightness, h, s);
  }
}

module.exports = RoomLights;
