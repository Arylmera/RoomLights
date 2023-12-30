/* eslint-disable @typescript-eslint/no-explicit-any */
'use strict';

import Homey from 'homey';

const { HomeyAPI } = require('homey-api');


class RoomLights extends Homey.App {

  devices = [];
  zones = [];

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {

    let homeyApi = await HomeyAPI.createAppAPI({
      homey: this.homey,
    });

    this.devices = Object.values(await homeyApi.devices.getDevices());
    this.zones = Object.values(await homeyApi.zones.getZones());

    const setRoomLights = this.homey.flow.getActionCard('setroomlights');
    setRoomLights.registerRunListener(async (args) => {
      const { room, brightness, temperature } = args;
      this.log(`${room}, ${brightness}, ${temperature}`);
      await this.setRoomLights(room, brightness, temperature);
    });

    this.log('RoomLights has been initialized');
  }

  async setRoomLights(room: string, brightness: number, temperature: number) {

       // setup asked zone and light from selected zone
    let selectedZoneId: string = '';
    this.zones.forEach((zone: any) => {
      if (zone.name === room) {
        selectedZoneId = zone.id;
      }
    });
    if (selectedZoneId === '') {
      const roomNames: string[] = [];
      this.zones.forEach((zone: any) => {
        roomNames.push(zone.name);
      });
      throw new Error(`Please send the name of the room as the first argument : ${roomNames}`);
    }

    // recuperate devices of wanted zone
    const zoneDevices: any = [];
    this.devices.forEach((device: any) => {
      if (device.zone == selectedZoneId && device.class == "light" && device.capabilities.includes("dim")) {
        zoneDevices.push(device);
      }
    });
    for (const device of zoneDevices) {
      await device.setCapabilityValue("light_temperature", temperature);
      if (brightness != 0) {
        device.setCapabilityValue("dim", brightness);
      } else {
        await device.setCapabilityValue("onoff", false);
      }
 
    }

  }

}

module.exports = RoomLights;
