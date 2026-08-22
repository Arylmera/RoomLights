"use strict";

// Colour temperature for bulbs that have no colour temperature.
//
// A `light_temperature` write reaches a white-tunable bulb and nothing else,
// so a colour-only bulb in a room kept its last hue while every other lamp
// walked the circadian curve. This turns the same 0-1 temperature into the
// hue and saturation that approximate it, so those bulbs follow the room.
//
// Nothing here touches Homey, for the same reason as lib/daylight.js: the
// arithmetic is the part worth testing and it needs no stub to test.

// Homey's `light_temperature` is 0 at the cold end and 1 at the warm end. The
// Kelvin it maps onto is the calibration knob, and it is deliberately warmer
// than the 6500-2200 K a white-tunable bulb actually spans.
//
// The reason is that the two bulbs do not share a white point. A colour bulb
// at zero saturation emits its three primaries flat out, which is a cold
// display white; a white-tunable bulb's "white" is already a warm phosphor.
// Converting the target temperature faithfully therefore lands visibly paler
// than the lamp next to it — measured right, perceived wrong. Compressing the
// range puts the same 0-1 input further down the locus and restores the match.
//
// These are the numbers to move if the lamp still reads off: lower both for
// more colour, raise both for less.
const COOL_K = 5000;
const WARM_K = 2000;

// Tanner Helland's blackbody approximation, a curve fit to the Planckian
// locus over roughly 1000-40000 K. A colorimetric conversion would need a
// white point, a working space and a gamma the bulb never tells us, and the
// eye judging the result cannot see the difference between the two.
function kelvinToRgb(kelvin) {
  const k = kelvin / 100;
  const red =
    k <= 66 ? 255 : 329.698727446 * Math.pow(k - 60, -0.1332047592);
  const green =
    k <= 66
      ? 99.4708025861 * Math.log(k) - 161.1195681661
      : 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  let blue;
  if (k >= 66) {
    blue = 255;
  } else if (k <= 19) {
    blue = 0;
  } else {
    blue = 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  }
  return [clamp255(red), clamp255(green), clamp255(blue)];
}

function clamp255(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, value));
}

/**
 * The hue and saturation a colour bulb should take to sit at a given
 * `light_temperature`. Value is not returned: `dim` already carries the
 * brightness, and folding it in here would fight the off threshold.
 *
 * @param {number} temperature 0 (cold) to 1 (warm), as Homey defines it.
 * @returns {[number, number]} hue and saturation, both 0-1.
 */
function temperatureToHueSaturation(temperature) {
  // A temperature outside 0-1 is a bug upstream, but clamping costs a line
  // and the alternative is a NaN hue on a bulb.
  const t = Math.min(1, Math.max(0, Number(temperature)));
  const kelvin = COOL_K - t * (COOL_K - WARM_K);
  const [red, green, blue] = kelvinToRgb(kelvin);

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  // Pure white: any hue is as right as any other, and 0 keeps it stable.
  if (span === 0 || max === 0) return [0, 0];

  let hue;
  if (max === red) {
    hue = ((green - blue) / span) % 6;
  } else if (max === green) {
    hue = (blue - red) / span + 2;
  } else {
    hue = (red - green) / span + 4;
  }
  hue /= 6;
  if (hue < 0) hue += 1;

  return [hue, span / max];
}

module.exports = {
  COOL_K,
  WARM_K,
  kelvinToRgb,
  temperatureToHueSaturation,
};
