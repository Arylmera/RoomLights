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
		const homeyApi = await HomeyAPI.createAppAPI({
			homey: this.homey,
		});

		this.devices = Object.values(await homeyApi.devices.getDevices());
		this.zones = Object.values(await homeyApi.zones.getZones());

		const setRoomLights = this.homey.flow.getActionCard('setroomlights');
		setRoomLights.registerRunListener(async (args) => {
			const { room, brightness, temperature } = args;
			await this.setLightsBrightness(room, brightness, temperature);
		});

		const setRoomLightsColors = this.homey.flow.getActionCard('setroomlightscolors');
		setRoomLightsColors.registerRunListener(async (args) => {
			const { room, brightness, color } = args;
			await this.setRoomLightsColors(room, brightness, color);
		});

		this.log('RoomLights has been initialized');
	}

	async getZoneId(room: string) {
		let selectedZoneId = '';
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
		return selectedZoneId;
	}

	async parseHexToHSL(hex: string) {
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

	async isLight(device: any) {
		return device.class === 'light' && device.capabilities.includes('dim');
	}

	async setLightsBrightness(zone: string, brightness: number, temperature: number) {
		const zoneId = await this.getZoneId(zone);
		this.devices.forEach(async (device: any) => {
			if ((await this.isLight(device)) && device.zone === zoneId) {
				if (brightness !== 0) {
					device.setCapabilityValue('dim', brightness);
					await device.setCapabilityValue('light_temperature', temperature);
				} else {
					await device.setCapabilityValue('onoff', false);
				}
			}
		});
	}

	async setLightsColors(zone: string, brightness: number, color: number, saturation: number) {
		const zoneId = await this.getZoneId(zone);
		this.devices.forEach(async (device: any) => {
			if ((await this.isLight(device)) && device.zone === zoneId) {
				if (device.capabilities.includes('light_hue')) {
					await device.setCapabilityValue('light_hue', color);
					await device.setCapabilityValue('light_saturation', saturation);
				}
				if (brightness !== 0) {
					device.setCapabilityValue('dim', brightness);
				} else {
					await device.setCapabilityValue('onoff', false);
				}
			}
		});
	}

	async setRoomLightsColors(room: string, brightness: number, color: string) {
		let [h, s, l] = await this.parseHexToHSL(color);
		this.setLightsColors(room, brightness, h, s);
	}
}

module.exports = RoomLights;
