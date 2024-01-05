"use strict";

const Homey = require("homey");
const { HomeyAPI } = require("homey-api");

class RoomLights extends Homey.App {
  devices = [];
  zones = [];
  filterZone = [];
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.homeyApi = await HomeyAPI.createAppAPI({
      homey: this.homey,
    });

    this.devices = Object.values(await this.homeyApi.devices.getDevices());
    this.zones = Object.values(await this.homeyApi.zones.getZones());

    console.log(this.devices);
    console.log(this.zones);

    for (const zone of this.zones.values()) {
      if (!zone.name.startsWith("_")) {
        let filterZone = {};
        filterZone.id = zone.id;
        filterZone.name = zone.name;
        filterZone.desciption = zone.name;
        this.filterZone.push(filterZone);
      }
    }

    this.homey.flow
      .getActionCard("setroomlights")
      .registerRunListener(async (args) => {
        const { room, brightness, temperature } = args;
        await this.setLightsBrightness(room, brightness, temperature);
      })
      .registerArgumentAutocompleteListener("room", async (query, args) => {
        return this.filterZone.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase()) || zone.name.toLowerCase() == query.toLowerCase();
        });
      });

    this.homey.flow
      .getActionCard("setroomlightscolors")
      .registerRunListener(async (args) => {
        const { room, brightness, color } = args;
        await this.setRoomLightsColors(room, brightness, color);
      })
      .registerArgumentAutocompleteListener("room", async (query, args) => {
        return this.filterZone.filter((zone) => {
          return zone.name.toLowerCase().includes(query.toLowerCase()) || zone.name.toLowerCase() == query.toLowerCase();
        });
      });

    this.log("Room lights has been initialized");
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

  isLight(device) {
    return device.class === "light" && device.capabilities.includes("dim");
  }

  async setLightsBrightness(zone, brightness, temperature) {
    this.devices.forEach(async (device) => {
      if (this.isLight(device) && device.zone === zone.id) {
        if (brightness !== 0) {
          device.setCapabilityValue("dim", brightness);
          await device.setCapabilityValue("light_temperature", temperature);
        } else {
          await device.setCapabilityValue("onoff", false);
        }
      }
    });
  }

  async setLightsColors(zone, brightness, color, saturation) {
    this.devices.forEach(async (device) => {
      if (this.isLight(device) && device.zone === zone.id) {
        if (device.capabilities.includes("light_hue")) {
          await device.setCapabilityValue("light_hue", color);
          await device.setCapabilityValue("light_saturation", saturation);
        }
        if (brightness !== 0) {
          device.setCapabilityValue("dim", brightness);
        } else {
          await device.setCapabilityValue("onoff", false);
        }
      }
    });
  }

  async setRoomLightsColors(room, brightness, color) {
    let [h, s, l] = this.parseHexToHSL(color);
    this.setLightsColors(room, brightness, h, s);
  }
}

module.exports = RoomLights;
