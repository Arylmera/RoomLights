# Holding a room at a level

*2026-08-15 — an addendum to [daylight-linked brightness](2026-08-15-daylight-brightness-design.md)*

## The observation

Every lux sensor in this house sits inside the room it would light. The first
design treated that purely as a hazard — it is what makes the loop closed, and
closed loops hunt — and worked around it by never asking the sensor what the
room *should* read, only where today sits between two anchors.

That throws away the useful half. A sensor in the room measures exactly the
thing a person cares about: how bright the room actually is. Asking for a
number is also a far more natural thing to configure than a dark anchor, a
bright anchor and a swing.

One objection from the first round does not survive: that absolute lux targets
are meaningless because the house's sensors read anywhere from 1 to 155 lx. That
is an argument about comparing sensors to each other. A target is per-room,
exactly as the anchors are. Bureau holds 15 lx and Salle de bain holds 100, and
neither needs to know about the other.

## What level is the right level

Published guidance is consistent about what a home wants:

| Room | Recommended | Measured where |
|---|---|---|
| Kitchen worktop | 300–500 lx | on the worktop |
| Home office desk | 300–500 lx | on the desk |
| Living room | 150–300 lx | general, layered |
| Bathroom | 150 lx general, 400 lx at the mirror | at the task |
| Bedroom | 100–150 lx general, 300 lx for reading | at the task |
| Hall, stairs | 100–150 lx | on the floor |

**None of those numbers may be typed into this app.** Every one is a *workplane*
figure — illuminance on the desk, the worktop, the floor. The house's sensors
are Hue motion sensors on ceilings and walls, and they read light reflected back
off the room, which is a small fraction of it. Bureau reads 3–30 lx while its
desk is certainly in the hundreds.

The daylight-harvesting literature names this directly: a sensor at the ceiling
is closer to measuring luminance than illuminance, and using one as if it read
the workplane depends on assumptions that fail. Nothing in software can bridge
the two without a handheld meter.

So the standards are used the way they are actually good for — deciding whether
a room's *full brightness* is set sensibly in the first place — and the number
this app stores stays in the sensor's own units, obtained by measurement rather
than by looking a figure up. The settings page carries a **Measure** button per
room for exactly that: light the room the way it should look, click once, and
the reading becomes `fullLux`.

## The rule

A room in **hold** mode has one number: the lux its sensor reads when the room
is fully lit. The target follows the circadian variable from there:

```
target = fullLux · circadian
```

so the room still dims through the evening, and the Logic variable a circadian
Flow already drives stays in charge. Linear rather than perceptual, because the
variable is a lamp-brightness fraction and a dimmed LED's output is roughly
linear in it.

Each re-evaluation compares what the sensor reads against that target and moves
the lamps toward it:

```
error = log10(target) − log10(max(measured, LUX_FLOOR))
step  = clamp(GAIN · error, −MAX_STEP, +MAX_STEP)
next  = clamp01(commanded + step)
```

`commanded` is what this app last wrote, not what the bulb reports, so a light
someone dimmed by hand does not become the base of the next correction.

The lamp's own contribution never appears in that formula, and that is the whole
point: convergence discovers it. Nothing has to be calibrated, and nothing goes
stale when a lamp moves.

## Why it converges

The update is `dim' = dim + G·(log10 T − log10 L(dim))`. Writing `s` for
`d(log10 L)/d(dim)` — how many decades of measured light a full sweep of the
dimmer is worth — the loop contracts when `0 < G·s < 2`.

`s` is at most about 1.5 in a room where the lamps dominate, and smaller when
daylight does. With `GAIN = 0.4` the loop stays contracting up to `s = 5`, which
is past anything a real room can do. `MAX_STEP = 0.15` bounds a single tick
regardless, so even a mis-estimated room walks rather than jumps.

Integration happens on the output — `next` is the previous command plus a step,
and it is clamped to 0–1. That clamp *is* the anti-windup: there is no separate
accumulator to run away. A target the lamps cannot reach saturates at full
brightness and stays there, which is the honest answer to asking for more light
than the room has.

A deadband of `0.08` decades — about 20 % in lux — keeps the loop off the mesh
when the reading is only jittering. The house's sensors move several percent
between reports with nothing changing.

## Cold start

The card writes the circadian brightness, exactly as it does today, and
convergence starts from there. A room is therefore never dark while it settles;
it starts where it would have started anyway and is corrected from there.

Settling takes several reports. At a Hue sensor's five-minute cadence that is
fifteen to thirty minutes from a cold start, and this is the real cost of the
mode. **Follow** remains the right choice for a room that must be right
immediately.

## What is rejected

**Hold with the modelled source.** The model cannot see the room, so there is no
feedback and nothing to converge. `validDaylight` refuses the combination
rather than letting it silently ramp to full.

**Hold without a `fullLux`.** Same posture as a missing anchor: the room reads
as having no daylight and takes its circadian brightness.

## Settings

The daylight row gains a **mode** picker before the source. `Follow the
daylight` keeps the three anchor fields; `Hold a level` replaces them with one
`Full brightness (lux)` field. Only the fields belonging to the chosen mode are
shown, and only they are validated or stored.

**Hold is the default.** Picking a source for a room that has none seeds a hold
entry, because holding a level is the mode that matches what these sensors
actually measure and the one a person can configure from a single observation.

An entry stored *before* this change carries no `mode` at all, and is read as
`follow`. A stored room must never have its control law changed underneath it
by an upgrade; only a room being configured afresh gets the new default.

To find a room's `fullLux`: light it the way it should look, then press
**Measure**. The button writes whatever the room's sensor reads at that moment.

## Tests

`setpointBrightness` is pure and joins the rest of `lib/daylight.js`:

- a reading below target raises the command, above it lowers it, and one at
  target does nothing
- a step is capped at `MAX_STEP` however large the error
- the result clamps to 0–1, and a saturated target stays at 1 rather than
  accumulating
- a reading of zero produces a finite step rather than an infinite one
- a deadband-sized error produces no change
- a simulated room converges: iterating against a model lamp reaches the target
  and stays there, and does not oscillate
- `validDaylight` accepts hold with a `fullLux`, and refuses it with the
  modelled source, with no `fullLux`, and with a non-positive one
- an entry with no `mode` is read as follow

## Out of scope

**Workplane calibration.** Learning the ratio between a room's sensor and its
desk would let the published figures be used directly. It needs a handheld
meter and a note kept per room, and it would go stale the day a lamp is moved
or a wall repainted.

**Per-room gain.** `GAIN` and `MAX_STEP` stay constants. A room that needs its
own is a room whose `fullLux` is wrong, and adding two more knobs to a table
that already has five columns is not the fix.
