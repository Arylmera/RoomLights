const arguments = JSON.parse(args[0]);

const selectedZoneName = arguments.room;
const brightness = arguments.brightness;
const temp = arguments.temperature;

if (brightness < 0 || brightness > 1) {
	throw new Error("Please send the brightness as the second parameter between 0 and 1 or don't send it");
}
if (temp < 0 || temp > 1) {
	throw new Error("Please send the temp as the third parameter between 0 and 1 or don't send it");
}

// recuperate devices and zones
const devices = Object.values(await Homey.devices.getDevices());
const zones = Object.values(await Homey.zones.getZones());

// setup asked zone and light from selected zone
let selectedZoneId = undefined;
let zoneDevices = [];

for (const zone of Object.values(zones)) {
	if (zone.name == selectedZoneName) {
		selectedZoneId = zone.id;
		break;
	}
}
if (selectedZoneId == undefined) {
	let roomNames = [];
	for (const zone of Object.values(zones)) {
		log(zone.name);
		roomNames.push(zone.name);
	}
	throw new Error("Please send the name of the room as the first argument : " + roomNames);
}

for (const device of devices) {
	if (device.zone == selectedZoneId && device.class == "light") {
		zoneDevices.push(device);
	}
}

// setup lights of the zone
for (const device of zoneDevices) {
	if (temp != undefined) {
		await device.setCapabilityValue("light_temperature", temp);
	}

	if (brightness != undefined) {
		if (brightness != 0) {
			device.setCapabilityValue("dim", brightness);
		} else {
			device.setCapabilityValue("onoff", false);
		}
	}
}
