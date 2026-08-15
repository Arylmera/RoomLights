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

// How much of the dimmer a decade of error is worth. The loop contracts while
// GAIN * s < 2, where s is how many decades of measured light a full sweep of
// the dimmer produces. A room where the lamps dominate is worth about 1.5, so
// 0.4 stays contracting up to s = 5 — past anything a real room can do.
const HOLD_GAIN = 0.4;

// However wrong the estimate, one tick may not move the room further than this.
// A mis-tuned room then walks rather than jumps.
const HOLD_MAX_STEP = 0.15;

// Below this much error, leave the room alone. The house's sensors move several
// percent between reports with nothing changing, and chasing that is noise on
// the mesh, not lighting. 0.08 decades is about 20% in lux.
const HOLD_DEADBAND_DECADES = 0.08;

const MODE_FOLLOW = "follow";
const MODE_HOLD = "hold";

// The source a room names when it wants computed daylight rather than a device.
const MODELLED_SOURCE = "modelled";

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
 * One step of the hold loop: what to command next so the room converges on a
 * measured level.
 *
 * `commanded` is what this app last wrote, never what the bulb reports back —
 * otherwise a light someone dimmed by hand becomes the base of the next
 * correction and the loop fights them.
 *
 * The lamp's own contribution never appears here, which is the point:
 * convergence discovers it. Nothing is calibrated, so nothing goes stale when a
 * lamp is moved or a bulb replaced.
 *
 * Integration happens on the output — the next command is the previous one plus
 * a step — and the clamp to 0-1 is therefore also the anti-windup. There is no
 * accumulator to run away, and a target the lamps cannot reach saturates at
 * full brightness instead of winding up behind it.
 */
function setpointBrightness(commanded, measured, target) {
  const base = finite(commanded);
  if (base == null) {
    return null;
  }
  const reading = finite(measured);
  const want = finite(target);
  // No reading, or nothing to aim at, leaves the room exactly where it is.
  if (reading == null || want == null || want <= 0) {
    return clamp01(base);
  }
  const error =
    Math.log10(Math.max(want, LUX_FLOOR)) - Math.log10(Math.max(reading, LUX_FLOOR));
  if (Math.abs(error) < HOLD_DEADBAND_DECADES) {
    return clamp01(base);
  }
  const step = Math.max(-HOLD_MAX_STEP, Math.min(HOLD_MAX_STEP, HOLD_GAIN * error));
  return clamp01(base + step);
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
  if (source == null) {
    return null;
  }

  // An entry stored before hold existed carries no mode, and must keep
  // following: an upgrade may not change the control law under a room that was
  // already working. The settings page seeds a *new* room as hold instead.
  const mode = entry.mode === MODE_HOLD ? MODE_HOLD : MODE_FOLLOW;

  if (mode === MODE_HOLD) {
    // The model cannot see the room, so there is no feedback and nothing to
    // converge — the loop would simply ramp to full and sit there.
    if (source === MODELLED_SOURCE) {
      return null;
    }
    const fullLux = finite(entry.fullLux);
    if (fullLux == null || fullLux < LUX_FLOOR) {
      return null;
    }
    return { mode, source, fullLux };
  }

  const dark = finite(entry.dark);
  const bright = finite(entry.bright);
  const swing = finite(entry.swing);
  if (dark == null || bright == null || swing == null) {
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
  return { mode, source, dark, bright, swing };
}

module.exports = {
  CLEAR_SKY_LUX,
  CLOUD_ATTENUATION,
  HOLD_DEADBAND_DECADES,
  HOLD_GAIN,
  HOLD_MAX_STEP,
  HORIZON_DEGREES,
  LUX_FLOOR,
  MODELLED_SOURCE,
  MODE_FOLLOW,
  MODE_HOLD,
  daylightBrightness,
  modelledLux,
  setpointBrightness,
  sinSolarElevation,
  validDaylight,
};
