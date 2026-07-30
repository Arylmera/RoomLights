# Room defaults mapping — design

*2026-07-30*

## The problem

Every room in this house already has its brightness and temperature computed for
it. A `Circadian` Flow recomputes `Global - Brightess` / `Global - Temp` and
`Side - Brightness` / `Side - Temp` every thirty minutes; each `<Room> - Scene`
Flow copies those into per-room Logic variables (`Salon - Brightness`,
`Salon - Temp`, and so on); each `<Room> - Handler` Flow then drops those two
tokens into a RoomLights **Set room lights** card.

That last step is the waste. The values are already known per room, yet every
card has to be told where to find them, and every new Flow repeats the wiring.

## The shape of the fix

Map each room to its two Logic variables **once**, in app settings. Add one new
action card that takes no brightness and no temperature: it looks the mapping up
and reads the variables itself.

The existing cards are untouched. A card with explicit values stays the way to
express a one-off ("turn the kitchen to 20% for the night"); the new card is for
the common case, where the room already knows what it wants.

## Data

App setting `roomDefaults`:

```json
{ "<zoneId>": { "brightness": "<variableId>", "temperature": "<variableId>" } }
```

Variable **ids**, not names — renaming `Salon - Temp` in Homey must not break the
link. `temperature` may be absent; `brightness` is what makes an entry useful.

Entries for zones that no longer exist are pruned on every rebuild, alongside
`lightSnapshots`, and under the same guard: a read that came back with no zones
at all is a failed read, not a house with no rooms.

## Reading variables

`homeyApi.logic.getVariables()` — `ManagerLogic` is in the local API
specification homey-api ships, and the app already holds `homey:manager:api`.

Reads go behind the same one-second cache as `freshDevices()`: a held wall
button runs its card once per repeat, and each run must not become a round-trip.
Unlike devices there is no invalidation to do — the app never writes variables,
so nothing it does can make a read stale.

## The card

`setroomlightsauto` — *Set room lights (automatic)*.

Arguments: room (autocomplete), role, apply-to, plus Homey's fade duration. No
brightness, no temperature.

The run listener resolves the mapping, reads both variables, and calls the
existing `setLightsBrightness()`. Everything downstream is therefore identical
to the manual card: excluded lights skipped, `onoff` written before `dim`,
brightness 0 meaning off, the role and already-on filters, the fade.

## Errors

- No mapping for the room, or the mapped brightness variable is gone, or its
  value is not a finite number → the card fails with a readable message naming
  the room. Silence here would look exactly like a broken card.
- No temperature mapped, or its variable is unreadable → brightness is applied
  and the lights keep their current tint. `setLightsBrightness()` already
  treats a null temperature that way.
- A value outside 0–1 is clamped rather than sent to a bulb.

## Settings page

A second section under *Light roles*: one row per room in the picker, with a
brightness and a temperature dropdown listing the house's **number** variables.

An **Auto-fill from names** button fills every room whose variables follow the
`<Room> - Brightness` / `<Room> - Temp` convention. Matching is
accent-insensitive and case-insensitive; an exact `<room> - <kind>` match wins,
otherwise a *unique* prefix match is taken, and an ambiguous one is left blank.
Rooms whose names drifted from their variables (zone `Budanderie` against
`Buanderie - Brightness`) stay empty and get set by hand — one click each, and
never a silently wrong guess.

Saving replaces the whole map, as the roles section already does. The API
validates it: unknown zones and unknown or non-number variables are dropped.

New endpoints: `GET /defaults` (rooms, number variables, current mapping) and
`PUT /defaults`.

## Tests

In `test/app.test.js`, against a stubbed `homeyApi.logic`:

- a mapped room resolves to its brightness and temperature
- a missing temperature mapping applies brightness alone
- an unmapped room, a deleted variable, and a non-numeric value each throw
- values outside 0–1 are clamped
- `setRoomDefaults` drops unknown zones and non-number variables
- a deleted zone loses its mapping on rebuild, and a failed zone read does not
- the card is registered, in its place in the registration order

## Out of scope

Colour mapping (`<Room> - Color` and its name → hex table), automatic variants
of the toggle and dim cards, and per-role mappings. The setting is keyed by room
with a named object per room, so any of them can be added without a migration.
