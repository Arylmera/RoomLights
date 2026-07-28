# RoomLights — light roles and state filtering

**Date:** 2026-07-28
**Status:** approved design, not yet implemented

## Problem

A RoomLights Flow card applies to *every* light in a zone. There is no way to say "all the lights
except the accent strip", so the workaround has been to suffix accent lights with `-A` in their
device name and avoid the cards for those rooms.

Three needs came out of the discussion:

1. Exclude specific lights from a card, more than one per room.
2. Distinguish main lighting from ambient lighting, replacing the `-A` naming convention.
3. Turn a whole room off with a single card, ignoring any exclusion.

## Observed state

Measured against the live Homey (`Guillaume's Homey Pro`, `65097a231611105897794a0c`) on
2026-07-28, not assumed:

- **38 devices of class `light`.** 28 are ceiling downlights named `<Room> spot <n>`.
- **The `-A` convention exists on exactly three lights**, all RGB accent fixtures:
  `Bureau Gradian  -A`, `Buffet Strip -A`, `TV Gradiant -A`.
- **Accent lights that were never renamed**: `Vitrine` (on/off + dim only), `Painting desk`,
  arguably `Chambre chevet`.
- **`Circadian Zone`** sits in the `Gembloux` zone and appears to be a virtual device rather than a
  fixture. It is currently swept into any card targeting that zone or its ancestors.
- **8 Advanced Flows use the cards, 10 card instances total** (`Salon - Handler` uses the colour
  card twice). **0 standard Flows.**

## Decisions

### Roles

Every light has exactly one role:

| Role | Meaning | Expected occupants today |
|---|---|---|
| `main` | The room's functional lighting. **Default.** | The 28 spots, anything unconfigured |
| `ambient` | Accent and mood lighting | The three `-A` lights, `Vitrine`, `Painting desk` |
| `excluded` | Never touched by any card, whatever the filter | `Circadian Zone`, virtual/proxy devices |

The third column is what these lights look like today, not behaviour the app infers. Roles are
assigned by hand on the settings page. There is deliberately **no automatic migration from the `-A`
suffix**: it is a one-time assignment of five or six lights, and parsing device names to derive
config would re-introduce exactly the coupling this design removes. Renaming those lights to drop
`-A` afterwards is optional and has no effect on behaviour.

`excluded` is the manual-exclusion feature. It wins over every role filter, including `All`.

A `task` role was considered and rejected: `Chambre chevet` is the only candidate device today, and
one device does not justify a concept. Free-form role names were rejected because the Flow card's
role argument would have to become an autocomplete, which is a much larger build.

### Storage

App settings key `lightRoles`, shape `{ "<deviceId>": "ambient" | "excluded" }`.

Only non-default roles are stored. Consequences, all deliberate:

- Nothing to migrate — an empty map reproduces today's behaviour exactly.
- A newly paired light is `main` without any write.
- A deleted device leaves a stale key, which is ignored on read and dropped on the next save.

### Settings page

`settings/index.html`, loading `/homey.js` with `data-origin="settings"`, calling `Homey.ready()`.

One section per zone that contains lights. Within a section, per non-default role:

- a `<select>` listing that room's lights currently holding the default role;
- choosing one moves it into that role's table below;
- each table row shows the light's name and a trash button returning it to `main`.

Rooms where every light is `main` render collapsed, so the page is not 15 empty tables.

### App API

`api.js` plus an `"api"` block in `.homeycompose/app.json`:

| Route | Purpose |
|---|---|
| `GET /lights` | Zones with their lights and current roles, read from the existing `myHome` map |
| `PUT /roles` | Validate and persist the whole role map |

`PUT /roles` rejects unknown role names and non-light device ids rather than storing them.

### Flow cards

The existing `setroomlights` and `setroomlightscolors` get `"deprecated": true`. Their run listeners
stay registered and unchanged — per Homey's breaking-changes guidance, removing or altering them
breaks the 8 Advanced Flows already using them. Deprecated cards remain functional and simply stop
appearing in the picker for new Flows.

Three replacements are added:

| Card | Arguments |
|---|---|
| `setroomlightsrole` | room, **role**, **state**, brightness, temperature |
| `setroomlightscolorsrole` | room, **role**, **state**, brightness, colour |
| `turnoffroomlights` | room, **role** |

The two new dropdowns:

| Argument | Values | Default |
|---|---|---|
| `role` | All / Main only / Ambient only | All |
| `state` | All lights / Only lights already on | All lights |

`All` + `All lights` reproduces the deprecated cards' behaviour, so a migrated Flow behaves
identically until you change a dropdown.

Role and state are orthogonal, so they are dropdowns rather than separate cards: expressing both as
cards would need six of them and still could not say "ambient lights that are already on".

**Turning off is a card, not a dropdown value.** Today `brightness = 0` is a magic value meaning
"off", which is why "the room off" and "the room dimmed" are the same card. A dedicated
`turnoffroomlights` card gives the most common operation two arguments instead of five, and makes
"shut the whole house down" a single card with `role: All`. An `action` dropdown on the existing
cards was considered and rejected: Homey cannot hide arguments conditionally, so choosing
`Turn off` would still display brightness and temperature fields that are silently ignored.

`turnoffroomlights` deliberately has **no `state` argument** — turning off a light that is already
off is a no-op, so the filter would make no difference.

The new set-cards still treat `brightness = 0` as "turn off" rather than writing `dim = 0`. This is
a pragmatic call, not an oversight: many bulbs reject or misbehave on `dim = 0`, and it keeps
behaviour identical to the deprecated cards for anyone migrating a Flow. The dedicated card exists
for clarity and for the one-card shutdown, not because the magic value was removed.

### Filter semantics

`roomLights(room, role, state)` resolves at execution time, reading `lightRoles` from settings on
each run rather than baking roles into `myHome`. A settings change therefore takes effect on the
next card run, with no rebuild and no app restart.

Order of filtering:

1. Drop every light whose role is `excluded`. No argument overrides this.
2. Apply the `role` filter, unless it is `All`.
3. If `state` is `Only lights already on`, drop lights whose `onoff` is currently false.

**Turning a room off with one card** is `turnoffroomlights` with `role: All` — which overrides the
ambient/main split by construction, while still respecting `excluded`.

**`state: Only lights already on` with `brightness: 0`** on a set-card turns off the lights that
were on and leaves the rest alone. The unambiguous way to express "everything off" is the dedicated
card.

**Set-cards must write `onoff: true` before the brightness.** The current code writes `dim` without
touching `onoff`, so applying 40 % to a light that is off leaves it off on some devices and turns it
on with others — behaviour that varies by bulb. With `state: All lights` the intent is explicitly
"include the lights that are off", so the card must turn them on rather than hope the `dim` write
does it. This is a behaviour change relative to the deprecated cards, which keep their current
write-`dim`-only logic untouched.

## Edge cases

- A room with no lights in the selected role is a no-op, not an error. Already handled by
  `roomLights()` returning `[]`.
- A room where every light is `excluded` behaves the same way.
- Stale device ids in `lightRoles` are ignored on read.
- `Vitrine` has neither `light_hue` nor `light_temperature`; the colour card must leave it on
  brightness only, which the current code already does.

## Testing

Extending the existing `node --test` suite (`npm test`), which stubs the `homey` runtime:

- role filtering for each of All / Main only / Ambient only;
- `excluded` dropped under every role value, including `All`;
- `state: Only lights already on` skipping lights whose `onoff` is false;
- `brightness: 0` with `state: Only lights already on` turning off only the lit ones;
- `turnoffroomlights` turning off every light of the selected role, and respecting `excluded`;
- set-cards writing `onoff: true` before `dim` for a light that was off;
- unknown and stale device ids in `lightRoles` ignored;
- a light with no entry defaulting to `main`;
- the deprecated cards still behaving as All / All lights, still writing `dim` without `onoff`.

`api.js` route handlers are testable the same way. `settings/index.html` is not unit-tested —
verify it by hand with `homey app run`.

## Constraints carried from the existing code

`app.js` and `api.js` must stay parseable on **Node 12**: the manifest declares
`compatibility: ">=5.0.0"`, and Homey Pro (2016-2019) below firmware v7.4.0 runs Node 12, where
`?.`, `??` and `??=` are a load-time `SyntaxError`. A test enforces this. `settings/index.html` runs
in a browser and is not subject to it.

Both of this account's Homeys run software 13.4.0 (Node 22), so this constraint exists only to keep
the declared compatibility range honest. Raising `compatibility` to `>=12.9.0` would lift it.

## To verify during implementation

**Reading `onoff` must reflect live state.** The `state` filter depends on the current value of
`onoff` from the `homey-api` device objects held in `myHome`. The app connects to the devices
manager, so values should be live — but a stale value would make the filter silently wrong, which is
the worst kind of bug. Confirm against the real Homey before relying on it; if values prove stale,
read the capability explicitly at execution time instead.

## Later: removing the deprecated cards

Once no Flow references them, delete both card JSON files, their manifest entries and their run
listeners in a single commit. The check:

```bash
homey api flow get-advanced-flows --json
```

Both that and `homey api flow get-flows --json` must show zero references to `setroomlights` and
`setroomlightscolors`. Today: 8 and 0 respectively.

## Out of scope

Named light groups per room, per-Flow one-off exclusions, circadian/time-of-day automation, and
lux-sensor-driven brightness. Roles cover the stated need; each of these can be added later without
reworking this design.
