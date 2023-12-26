/* eslint-disable @typescript-eslint/no-explicit-any */
'use strict';

import Homey from 'homey';

class RoomLights extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('RoomLights has been initialized');

    const setRoomLights = this.homey.flow.getActionCard('setroomlights');
    setRoomLights.registerRunListener(async (args) => {
      const { room, brightness, temperature } = args;
      this.log(`${room}, ${brightness}, ${temperature}`);
      await this.setRoomLights(room, brightness, temperature);
    });
  }

  async setRoomLights(room: string, brightness: number, temperature: number) {
    // recuperate zones
    const devices = Object.values(await Homey.devices.getDevices());
    const zones = Object.values(await Homey.zones.getZones());
    // setup asked zone and light from selected zone
    let selectedZoneId: string = '';
    zones.forEach((zone: any) => {
      if (zone.name === room) {
        selectedZoneId = zone.id;
      }
    });
    if (selectedZoneId === '') {
      const roomNames: string[] = [];
      zones.forEach((zone: any) => {
        roomNames.push(zone.name);
      });
      throw new Error(`Please send the name of the room as the first argument : ${roomNames}`);
    }

        // recuperate devices of wanted zone
    const zoneDevices: any = [];
    devices.forEach((device: any) => {
      if (device.zone == selectedZoneId && device.class == "light") {
        zoneDevices.push(device);
      }
    });
    for (const device of zoneDevices) {
      await device.setCapabilityValue("light_temperature", temperature);
    
      if (brightness != 0) {
        device.setCapabilityValue("dim", brightness);
      } else {
        device.setCapabilityValue("onoff", false);
      }
 
    }
  }

}

module.exports = RoomLights;
