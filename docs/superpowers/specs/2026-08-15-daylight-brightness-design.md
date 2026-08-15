# Daylight-linked brightness

*2026-08-15*

## The problem

The automatic card writes whatever the circadian Logic variable says, and that
variable knows only the time of day. A room at four in the afternoon gets the
same brightness in June sunshine as it does under November cloud. Several rooms
already carry an ambient light reading that nothing consumes.

Linking the two is the obvious idea. Doing it naively is how lighting systems
end up pumping.

## What the house actually has

Six rooms report `measure_luminance`, all of them Philips Hue motion sensors:

| Room | Device | Reading at design time |
|---|---|---|
| Bureau | Occupency bureau | 10 lx |
| Chambre | Occupancy Chambre | 10 lx |
| Salle de bain | Occupancy Salle de bain | 100 lx |
| Toilette | Occupancy Toilettes | 22 lx |
| Hall d'entrée | Occupancy Hall d'entrée | 26 lx |
| Hall de nuit | Occupancy Hall de nuit | 15 lx |

Salon, Salle à manger and Cuisine have none — their presence sensors report
`alarm_motion` only.

Twenty-four hours of Insights from the Bureau sensor sets the scale. It floors
at exactly `1.0` overnight and peaks at `29.7` at 16:40 UTC on 2026-08-14.
That is a span of roughly one and a half decades, at absolute values an order
of magnitude below the 300–500 lx that commercial daylight harvesting holds at
a workplane. These are ceiling sensors reading reflected light.

Two consequences drive the whole design.

**Absolute setpoints are useless here.** No target expressed in lux would mean
anything across six sensors reading between 1 and 100 in the same house. Every
number has to be relative to anchors tuned per room.

**The scale is logarithmic.** Zigbee encodes illuminance as
`10000·log10(lux) + 1`, so the sensor's own resolution is logarithmic — and so,
conveniently, is human brightness perception. Interpolation happens on
`log10(lux)`, never on lux.

Hue reporting is hard-capped at five minutes, faster only while motion is
active. That is the loop rate, and it is not negotiable.

## The trap

All six sensors sit inside the room they would control. In daylight-harvesting
terms that is a *closed loop*, and it is the configuration the literature warns
about: lamps brighten, the sensor reads more light, the controller dims, the
sensor reads less, the lamps brighten. At a five-minute sample rate a hunting
cycle would be twenty minutes of visible pumping.

The fix is not a better controller. It is to bound the authority daylight has
over brightness so that the loop gain stays below one, and to refuse to write
at all for small corrections. A bounded, dead-banded loop converges to a fixed
point; it cannot oscillate. This costs three lines of arithmetic and no
calibration, where a lamp-contribution model would need a dark-room measurement
per room that nobody will ever redo after moving a lamp.

## The mapping

Three numbers per room — a dark anchor, a bright anchor, and a swing:

```
t      = clamp01( (log10(lux) − log10(dark)) / (log10(bright) − log10(dark)) )
target = clamp01( circadian + swing·(1 − 2t) )
```

At the dark anchor the room runs at `circadian + swing`; at the bright anchor,
`circadian − swing`; at the geometric mean of the two the circadian value
passes through untouched. Both anchors are read straight off Insights, which is
the point of choosing them as the parameters rather than a gain and an offset.

`lux` is clamped to a floor of `0.1` before the logarithm, because the sensors
do report zero and `log10(0)` is not a brightness. Anchors that are equal,
inverted or non-positive disable daylight for that room rather than producing a
division by zero — the same posture `validOffBelow` already takes.

Swing defaults to `0.20`. Against a span of at least one decade that keeps the
loop gain comfortably under one for any plausible room.

## Where daylight comes from

Each room names its own source, and the mapping above does not care which.

**A room sensor.** Any device exposing `measure_luminance`, not necessarily the
one in that room. Pointing three rooms at a single well-placed sensor is the
open-loop architecture the literature prefers, and it falls out for free by not
restricting the picker.

**Modelled daylight.** Computed rather than measured:

```
lux = 120000 · max(0, sin(solarElevation(lat, lon, now)))
          · (1 − 0.75 · cloudiness/100)
```

Solar elevation comes from the NOAA approximation — fractional year, equation
of time, declination, hour angle — about fifteen lines and no dependency.
Latitude and longitude come from `this.homey.geolocation`, which needs the
`homey:manager:geolocation` permission added to `app.json`.

Cloudiness comes from a weather device named in settings, not hard-coded. It is
dropped, leaving a clean elevation-only curve, when no device is mapped or when
the mapped capability's `lastUpdated` is stale.

That last clause is not hypothetical. The house's `Gembloux Weather` device is
currently frozen: its `forecast_time` reads `07/23/2026`, its sunrise and sunset
of `05:55` / `21:39` are late-July values for a mid-August date, and its
`measure_ultraviolet` Insights log has been flat zero across the whole morning
while the device state claims `3.2`. A modelled source that trusted it blindly
would be worse than no daylight at all.

Modelled rooms are open-loop by construction. They cannot see the lamps, so
they need neither the swing bound nor the deadband for stability — those apply
anyway, for consistency and to keep small corrections off the Zigbee mesh.

## Tracking lifecycle

`setroomlightsauto` on a room with a lux source arms tracking, remembering the
role and state filters the card ran with so that re-evaluation touches exactly
the lights the original card did.

While armed, the room re-evaluates on new daylight: a sensor room through the
device's capability instance, which fires at the sensor's own cadence; a
modelled room on a five-minute timer, matching. Each evaluation re-reads the
circadian variable, so a room tracking daylight still follows the time of day.

A write happens only when the new target differs from the last written value by
more than `0.03`. Below that the room is left alone.

Tracking stops when every non-excluded light in the room is off, or when the
new stop card runs. It is in-memory only: an app restart clears it, and the
next automatic card re-arms. Persisting it would mean reconstructing which
filters were in force across a restart, for a state that a Flow re-establishes
within minutes anyway.

**Moods disarm through a Flow card, not an event.** `homey-api` v3 ships no
moods manager — there is no `ManagerMoods` and no mood event to subscribe to.
The stop card dropped into a mood Flow is the only mechanism available, which
also matches the existing note that moods bypass this app's light roles.

Manual dims are deliberately not a disarm. A Tap Dial nudge is corrected back
within one sample. Treating a manual dim as a rebased setpoint is the known
alternative and is left out of scope below.

## Settings

A new daylight section on the existing settings page, carried on the existing
`/defaults` route in both directions — the same reasoning that put `offBelow`
there. `getRoomDefaultsPage()` already promises everything that section needs in
one read; it gains the lux-capable device list and the current daylight map, and
the write stays symmetric.

Per room: a lux source (none, a device, or modelled), a dark anchor, a bright
anchor, and a swing. Globally: the weather device supplying cloudiness.

Validation mirrors `setRoomDefaults`. Unknown rooms are dropped, a device id
that no longer exposes `measure_luminance` is dropped, and a room whose anchors
do not validate is stored without daylight rather than stored broken. Rooms are
pruned by the existing `pruneByRoom` call.

A room with no lux source behaves exactly as it does today. That is the same
opt-in posture as roles: an unconfigured app is unchanged.

## Flow cards

One new action, `stopdaylighttracking`, taking a room. Registered last, since
registration order is part of the app's contract.

No new set-card. Daylight rides on `setroomlightsauto`, because a second card
that differed only by consulting a sensor would double the surface for no gain
and leave two cards to keep in step.

`offBelow` still applies to the computed target, so a bright enough room falls
through to off by the existing path rather than a second rule.

## Tests

Extending `test/app.test.js`. The mapping and the solar-position function are
pure, which is most of why they are shaped this way:

- a reading at the dark anchor yields `circadian + swing`, at the bright anchor
  `circadian − swing`, and at the geometric mean the circadian value unchanged
- interpolation is logarithmic, not linear — a reading at the geometric mean
  lands at the midpoint, one at the arithmetic mean does not
- readings beyond either anchor clamp rather than extrapolate
- a computed target still clamps to 0–1 against an extreme circadian value
- equal, inverted, zero and negative anchors disable daylight for the room
- a zero reading does not produce a non-finite target
- solar elevation matches a known position for a fixed date, latitude and
  longitude
- modelled lux ignores cloudiness when the weather capability is stale
- a target within the deadband of the last written value writes nothing
- a room with no lux source takes the circadian value untouched
- `offBelow` still turns the room off when the daylight-adjusted target falls
  below it

## Out of scope

**Manual dim as a rebase.** Remembering the offset a person dialled in and
tracking daylight relative to it is the better behaviour and a strictly larger
change: it needs a way to tell the app's own writes from everyone else's, which
means recording each command and tolerating the echo. Worth doing if the
five-minute correction turns out to be annoying in practice.

**Lamp-contribution calibration.** Measuring what each room's own lamps add at
its sensor would let the loop recover true daylight instead of bounding the
error. It needs a dark-room calibration per room that silently expires the day a
lamp moves. The bounded-authority approach was chosen precisely to avoid it.

**Daylight-linked colour temperature.** Same sensor, same anchors, a different
output. Deliberately not bundled — brightness is the thing that was asked for,
and warming a room because a cloud passed is a separate judgement call.

**Rooms without a sensor.** Salon, Salle à manger and Cuisine can be pointed at
modelled daylight or at a borrowed sensor once someone tunes anchors for them.
Nothing here does it automatically.

## Noted, not changed

Capability instances have to be destroyed when a room disarms and when
`buildRoomLightsZones` rebuilds, or every rebuild leaks a listener against a
device object that no longer exists. `watchForChanges` currently subscribes once
at start-up and never unsubscribes, which is correct for its two managers but is
not a pattern this can copy.

The Bureau sensor floors at exactly `1.0`, never `0`. Whether that is the
sensor, the Hue bridge or the Homey driver is unknown, and it matters only
because it sets the lowest usable dark anchor for that room. Not worth chasing
until a room's anchors need to go below it.
