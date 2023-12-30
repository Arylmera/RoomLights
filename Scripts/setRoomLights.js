//const arguments = JSON.parse(args[0]);

const arguments = {
  room: "Salon",
  brightness: 0.4,
  temperature: 0.9,
  color: 1,
  saturation: 1,
};

const selectedZoneName = arguments.room;
const brightness = arguments.brightness;
const temp = arguments.temperature;
const color = arguments.color;
const saturation = arguments.saturation;

if (brightness && (brightness < 0 || brightness > 1)) {
  throw new Error("Please send the brightness a parameter between 0 and 1 or don't send it");
}
if (temp && (temp < 0 || temp > 1)) {
  throw new Error("Please send the temp a parameter between 0 and 1 or don't send it");
}
if (color && (color < 0 || color > 1)) {
  throw new Error("Please send the color a parameter between 0 and 1 or don't send it");
}
if (saturation && (saturation < 0 || saturation > 1)) {
  throw new Error("Please send the saturation a parameter between 0 and 1 or don't send it");
}

// recuperate devices and zones
const devices = Object.values(await Homey.devices.getDevices());
const zones = Object.values(await Homey.zones.getZones());

// setup asked zone and light from selected zone
let selectedZoneId = undefined;
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
  if (device.zone == selectedZoneId && device.capabilities.includes("dim")) {
    if (color != undefined && device.capabilities.includes("light_hue")) {
      await device.setCapabilityValue("light_hue", color);
      await device.setCapabilityValue("light_saturation", saturation == undefined ? 1 : saturation);
    } else if (temp != undefined && device.capabilities.includes("light_temperature")) {
      await device.setCapabilityValue("light_temperature", temp);
    }

    if (brightness != undefined) {
      if (brightness != 0) {
        device.setCapabilityValue("dim", brightness);
      } else {
        await device.setCapabilityValue("onoff", false);
      }
    }
  }
}
