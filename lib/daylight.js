"use strict";

// The pure half of daylight-linked brightness: solar geometry, the modelled
// outdoor illuminance built on it, the lux-to-brightness mapping, and the
// validation that keeps a hand-edited setting from reaching a bulb.
//
// Nothing here touches Homey. That is the point: the arithmetic that decides
// how bright a room gets is the part most worth testing, and keeping it free of
// the hub means the tests need no stub at all.

// Anchors whose logarithms land on the same double would divide by zero, and
// `bright > dark` does not catch it: 100 and 100.00000000000001 differ by a
// whole ULP while log10 of each is the same number. A span this small is not a
// curve anyone meant to configure, and it is the one remaining way a NaN could
// reach a bulb.
const MIN_LOG_SPAN = 1e-6;

// Sensors do report zero, and log10(0) is not a brightness. Readings are held
// at this floor, and so are the anchors — otherwise a dark anchor below the
// floor would make a reading of zero land above it, which reads as "brighter
// than the darkest case" and is exactly backwards.
const LUX_FLOOR = 0.1;

// Horizontal illuminance under a clear sky with the sun overhead. Everything
// below scales it by sin(elevation), which is the projection of a beam onto
// the ground.
const CLEAR_SKY_LUX = 120000;

// Full overcast leaves roughly a quarter of the clear-sky figure. A room's
// anchors absorb the error if this is off for a particular sky, which is why
// it stays one number instead of a fitted curve.
const CLOUD_ATTENUATION = 0.75;

// Sunrise is conventionally the moment the sun's upper limb clears the horizon
// through a refracting atmosphere, not the moment its centre reaches zero.
const HORIZON_DEGREES = -0.833;

const DEGREES = Math.PI / 180;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

// A usable number, or null. Anything else — a string from a hand-edited
// setting, a NaN out of a broken sensor, an Infinity out of a bad division —
// must not become a brightness.
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * NOAA's low-precision solar position algorithm.
 *
 * Accurate to a fraction of a degree for any year this app will see, which is
 * orders of magnitude finer than a lighting curve can express, and it needs no
 * ephemeris table or dependency.
 *
 * Returns the *sine* of the solar elevation, because that is what the
 * illuminance model consumes; negative means the sun is below the horizon.
 * Returns null rather than NaN when the inputs are unusable.
 */
function sinSolarElevation(latitude, longitude, date) {
  const lat = finite(latitude);
  const lon = finite(longitude);
  if (lat == null || lon == null || !(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86400000) + 1;
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;

  // Fractional year, in radians.
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcMinutes / 60 - 12) / 24);

  // The equation of time, in minutes: how far true solar noon drifts from mean
  // solar noon across the year. Up to about a quarter of an hour, so it is not
  // optional at this latitude.
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // Solar declination, in radians.
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // True solar time in minutes, then the hour angle in degrees. The wrap keeps
  // a longitude that pushes true solar time past either end of the day from
  // producing an hour angle outside ±180.
  const trueSolarTime = utcMinutes + equationOfTime + 4 * lon;
  const hourAngle = (((trueSolarTime / 4 - 180) % 360) + 540) % 360 - 180;

  return (
    Math.sin(lat * DEGREES) * Math.sin(declination) +
    Math.cos(lat * DEGREES) * Math.cos(declination) * Math.cos(hourAngle * DEGREES)
  );
}

/**
 * Modelled outdoor illuminance, in lux.
 *
 * This is the open-loop source: it cannot see the room's own lamps, so a room
 * driven from it has no feedback path and cannot hunt.
 *
 * `cloudiness` is a 0-100 percentage, or null when no weather device is mapped
 * or its reading cannot be trusted. Null drops the term and leaves a clean
 * clear-sky curve rather than collapsing the estimate to zero — a missing
 * weather device must not read as "pitch dark outside".
 */
function modelledLux(latitude, longitude, date, cloudiness) {
  const sinElevation = sinSolarElevation(latitude, longitude, date);
  if (sinElevation == null) {
    return null;
  }
  if (sinElevation <= 0) {
    return 0;
  }
  const clearSky = CLEAR_SKY_LUX * sinElevation;
  const cloud = finite(cloudiness);
  if (cloud == null) {
    return clearSky;
  }
  return clearSky * (1 - CLOUD_ATTENUATION * clamp01(cloud / 100));
}

/**
 * The mapping, and the whole of the daylight feature in three lines of
 * arithmetic.
 *
 * Interpolation is on log10(lux) rather than lux, which matches both the
 * Zigbee illuminance encoding (10000·log10(lux)+1) and human brightness
 * perception. A linear interpolation would spend almost its entire range on
 * the top decade and leave a dim room indistinguishable from a dark one.
 *
 * At the dark anchor the room runs at `circadian + swing`, at the bright
 * anchor at `circadian − swing`, and at the geometric mean of the two the
 * circadian value passes through untouched. Beyond either anchor the result
 * clamps rather than extrapolating, which is what bounds daylight's authority
 * and holds the closed-loop gain below one.
 */
function daylightBrightness(circadian, lux, config) {
  const base = finite(circadian);
  if (base == null) {
    return null;
  }
  const reading = finite(lux);
  // No usable reading is not an error: the room simply takes the circadian
  // value it would have had before daylight existed.
  if (reading == null || config == null) {
    return clamp01(base);
  }
  const dark = Math.log10(Math.max(config.dark, LUX_FLOOR));
  const bright = Math.log10(Math.max(config.bright, LUX_FLOOR));
  const here = Math.log10(Math.max(reading, LUX_FLOOR));
  const t = clamp01((here - dark) / (bright - dark));
  return clamp01(base + config.swing * (1 - 2 * t));
}

/**
 * A room's daylight settings, normalised, or null.
 *
 * Null means "this room has no daylight", which is the same thing an
 * unconfigured room means, so a corrupted entry degrades to today's behaviour
 * instead of to a broken one. `source` is either a device id or the literal
 * "modelled"; the two share a field because everything downstream of the
 * reading is identical.
 */
function validDaylight(entry) {
  if (entry == null || typeof entry !== "object") {
    return null;
  }
  const source = typeof entry.source === "string" && entry.source.length > 0 ? entry.source : null;
  const dark = finite(entry.dark);
  const bright = finite(entry.bright);
  const swing = finite(entry.swing);
  if (source == null || dark == null || bright == null || swing == null) {
    return null;
  }
  // Anchors that are equal or inverted would divide by zero or run the curve
  // backwards; one below the floor would sit under every possible reading; and
  // two that are merely indistinguishable in log space divide by zero as well.
  if (dark < LUX_FLOOR || bright <= dark) {
    return null;
  }
  if (Math.log10(bright) - Math.log10(dark) < MIN_LOG_SPAN) {
    return null;
  }
  if (swing < 0 || swing > 1) {
    return null;
  }
  return { source, dark, bright, swing };
}

module.exports = {
  CLEAR_SKY_LUX,
  CLOUD_ATTENUATION,
  HORIZON_DEGREES,
  LUX_FLOOR,
  MODELLED_SOURCE: "modelled",
  daylightBrightness,
  modelledLux,
  sinSolarElevation,
  validDaylight,
};
