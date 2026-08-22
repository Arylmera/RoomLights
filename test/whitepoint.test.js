"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { temperatureToHueSaturation } = require("../lib/whitepoint");

test("the cold end is near-white, the warm end is amber", () => {
  // Not neutral: the range is compressed warm on purpose, because a colour
  // bulb's unsaturated white reads colder than the white-tunable bulb it is
  // standing next to. Pale, but with the room's tint in it.
  const [coldHue, coldSaturation] = temperatureToHueSaturation(0);
  assert.ok(coldSaturation < 0.25, `cold saturation ${coldSaturation} is not pale`);
  assert.ok(coldSaturation > 0, `cold saturation ${coldSaturation} lost the tint`);
  assert.ok(coldHue >= 0 && coldHue <= 1);

  const [warmHue, warmSaturation] = temperatureToHueSaturation(1);
  assert.ok(warmSaturation > 0.8, `warm saturation ${warmSaturation} is too pale`);
  // Amber sits around 30 degrees, a twelfth of the way round the wheel.
  assert.ok(warmHue > 0.04 && warmHue < 0.12, `warm hue ${warmHue} is not amber`);
});

test("saturation rises with temperature and hue stays in the warm quadrant", () => {
  let previous = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const [hue, saturation] = temperatureToHueSaturation(t);
    assert.ok(saturation >= previous, `saturation fell at t=${t}`);
    assert.ok(hue >= 0 && hue < 0.2, `hue ${hue} left the warm quadrant at t=${t}`);
    previous = saturation;
  }
});

test("a temperature outside 0-1 is clamped, never NaN", () => {
  for (const bad of [-1, 2, "0.5", null, undefined, NaN]) {
    const [hue, saturation] = temperatureToHueSaturation(bad);
    assert.ok(Number.isFinite(hue) && Number.isFinite(saturation), `NaN from ${bad}`);
    assert.ok(hue >= 0 && hue <= 1 && saturation >= 0 && saturation <= 1);
  }
});
