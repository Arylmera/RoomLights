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

One section per zone that contains lights — **including `_`-prefixed zones**, which are hidden from
the room picker but not from role management. Their lights are still reached by cards targeting an
ancestor zone, and `PUT /roles` replaces the whole map, so a light the page cannot see is a light
whose role the next unrelated save would silently erase.

Within a section, per non-default role:

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

The existing `setroomlights` and `setroomlightscolors` get `"deprecated": true`. Their **arguments**
stay unchanged — per Homey's breaking-changes guidance, altering them breaks the 8 Advanced Flows
already using them. Deprecated cards remain functional and simply stop appearing in the picker for
new Flows.

They do gain two behaviours:

- **The `excluded` filter.** Safe by construction: `excluded` is opt-in per light and empty by
  default, so nothing changes until you exclude something — and once you have, a card that still
  swept `Circadian Zone` would defeat the point of the role.
- **`onoff: true` before the brightness**, as described under Filter semantics. This one does change
  what existing Flows do, deliberately.

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

**Every set-card writes `onoff: true` before the brightness.** The original code wrote `dim` without
touching `onoff`, so applying 40 % to a light that is off left it off on some devices and turned it
on with others — behaviour that varied by bulb. Setting a brightness means "on", so the card says so.

This was initially scoped to the new cards only, to leave existing Flows untouched. That was
reversed on 2026-07-28 at the author's request: it is a genuine bug, the deprecated cards were the
ones actually suffering from it, and confining the fix to new cards meant the 8 Advanced Flows kept
the broken behaviour indefinitely. The deprecated cards' **arguments** remain frozen; only this
write was fixed.

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

## Resolved: the Node version floor

The manifest originally declared `compatibility: ">=5.0.0"`, the SDK v3 default, which claims support
for Homey Pro (2016-2019) below firmware v7.4.0 — where apps run **Node 12** and `?.`, `??` and `??=`
are a load-time `SyntaxError`. That was enforced by a test.

Raised to `">=12.9.0"` on 2026-07-28 at the author's request. Both of this account's Homeys run
software 13.4.0, the app has never been published, and the old range was advertising support for
hardware nobody tests on. Homey v12.9.0 is where apps moved to Node 22, so modern syntax is now free
to use and the guard test is gone.

`>=7.4.0` (Node 16) would also have permitted that syntax while covering more devices. It was not
chosen: nothing here is tested below 13.4.0, and a compatibility claim should describe what is
actually known to work.

## Resolved: reading `onoff` reflects live state

**Verified 2026-07-28, and the design changed as a result.** Against the real Homey,
`capabilitiesObj.onoff.value` is populated for all 38 lights (2 on, 35 off, none unknown) with
distinct per-device `lastUpdated` timestamps — so the value is live *in the API*.

That was not enough. The app holds long-lived cached device objects in `myHome`, whereas each CLI
call re-fetches. `homey-api` documents `makeCapabilityInstance()` as the mechanism for realtime
capability updates, which implies the cached `capabilitiesObj` on a device object is **not**
guaranteed to be written back. Relying on it would have made the filter silently wrong — the exact
failure this section existed to prevent.

`roomLights()` is therefore `async` and calls `lightStates()`, which re-reads devices from the API,
but **only** when a card actually asks for `state: Only lights already on`. Cards using
`state: All lights` cost nothing extra. A regression test drives the stale case directly: the cached
object reports on, the API reports off, and the filter must follow the API.

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

### Decided 2026-07-28: one card driving main and ambient differently

Asked for, and deliberately **not** built. Four options were weighed: an "other lights" dropdown
(`Leave alone` / `Turn off`), two full argument groups on one card, named room scenes in settings,
and simply placing two cards side by side in an Advanced Flow.

The author chose two cards. It requires no code, expresses cases the single-card options cannot —
main at 40 % *and* ambient at 15 %, which the dropdown could never do — and avoids a card carrying
seven-plus controls that Homey has no way to hide conditionally. Named scenes remain the option
worth revisiting if several distinct looks per room are ever wanted; a card argument is not.
