# Off-threshold for brightness

*2026-08-15*

## The problem

Lights in a room sometimes settle into a faint glow instead of going out, even
though the room's brightness is meant to be zero.

`applyBrightness` treats "off" as `brightness === 0`. That is a strict equality
against a number produced by a circadian formula, and such a formula reaches
"dark" as a small float far more often than as an exact zero. Insights confirms
it on the live house: `Salon - Brightness` sits at `0.0307`, `0.0345`, `0.011`
across three consecutive five-minute buckets — a quarter of an hour at one to
three percent, not a transient spike.

Told `0.0345`, the app faithfully writes `onoff true` followed by `dim 0.0345`.
The bulb obeys. The room glows.

The behaviour is intermittent for the obvious reason: it depends entirely on
where the curve happens to bottom out on a given day.

## The rule

Brightness at or below a threshold means off, rather than on at a hair above
nothing. The threshold defaults to 5% and is configurable.

Comparison is `<=`, which makes a threshold of `0` exactly equivalent to the
old behaviour. That is the natural way to switch the feature off and it saves
carrying a separate enable flag.

## Where the guard goes

In the shared functions, not in the cards:

- `applyBrightness` — the single funnel for the set, colours, role, automatic
  and toggle cards. One guard there covers all of them; a guard per card would
  be a larger diff that still left the next card to be written broken.
- `dimRoomLights` — its existing `dim === 0` check becomes the same comparison.
  This is the same defect reached from a wall button: holding "down" currently
  stalls at a glow instead of arriving at off.

`restoreRoomLights` is deliberately left alone. Restore replays a saved state
verbatim; that is its contract, and a snapshot taken of a genuinely dim room
should come back dim.

## The setting

An `offBelow` key in app settings holding a 0–1 fraction.

Reads go through an accessor shaped like the existing `variableValue`: anything
non-numeric, non-finite or out of range falls back to the default rather than
to zero, because a corrupted setting must never be the reason the app stops
turning lights off. Writes drop an invalid value instead of storing it, so a
bad save cannot leave state the reader then has to paper over. Both share one
validator.

## Settings page

One percentage input, carried on the existing `/defaults` route in both
directions. `getRoomDefaultsPage()` already promises everything that section
needs in a single read, so the write becomes symmetric: `{ mappings, offBelow }`
in, the accepted values back out. No new route and no second save button.

It renders in the automatic-brightness section, since that is where the problem
originates, with copy stating that it applies to every card — including a
manually dragged slider. A slider at 3% with a 5% threshold turns the room off.
That is the intended reading of "this app never leaves a light glowing below
the threshold", and the alternative — the automatic card and the slider card
disagreeing at 3% — is harder to explain than the rule itself.

## Tests

Extending `test/app.test.js`:

- brightness below the threshold writes only `onoff false`
- brightness above it still writes `onoff true` before `dim`
- a threshold of `0` restores exact-zero behaviour
- a non-numeric or out-of-range stored setting falls back to the default
- an invalid value offered to the setter is not stored
- dimming down across the threshold turns the light off

## Out of scope

**Per-light dim floors.** A bulb whose own hardware minimum sits above the
threshold will still glow. Fixing that needs a minimum recorded per light,
alongside the roles the settings page already carries. Worth revisiting if a
light still glows after this ships — with evidence about which light.

**Retrying dropped commands.** A Zigbee or Z-Wave command that never lands is a
real failure mode, but it produces a light at its previous brightness, not a
faint glow, so it is not this bug.

## Noted, not changed

`eachLight` fails a Flow only when *every* light fails. A single unreachable
bulb is logged and the card still reports success. That is deliberate — one
dead bulb is the normal state of a Zigbee room and must not abort the others —
but it does mean a stuck light can go unnoticed indefinitely. Separate concern,
separate change.
