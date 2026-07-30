# RoomLights

A [Homey](https://homey.app) app that lets you control **every light in a zone at once** from a single Flow card — instead of adding one card per bulb.

| | |
|---|---|
| App ID | `inc.lemer.roomLights` |
| Version | 1.0.0 |
| Homey SDK | 3 |
| Compatibility | Homey `>=12.9.0`, platform `local` |
| Category | lights |
| License | GPL-3.0 (see [LICENSE](LICENSE)) |

## What it does

On start-up the app reads your Homey zones and devices through the Homey Web API and builds an in-memory map of *zone → devices grouped by device class*. Two Flow action cards then apply a setting to every device of class `light` in the chosen zone.

Zones whose name starts with an underscore (`_`) are hidden from the room autocomplete — use that prefix for zones you never want to target. They still appear on the settings page, because their lights are still reached by any card targeting a parent zone, so their roles have to remain editable.

## Light roles

Every light has a role, set on the app's **settings page** in the Homey app:

| Role | Meaning |
|---|---|
| **Main** | The room's functional lighting. The default — a light you never configure is main. |
| **Ambient** | Accent and mood lighting: strips, gradients, display cabinets. |
| **Excluded** | Never touched by any card, whatever it targets. For virtual devices and anything a room card should not sweep. |

Only non-default roles are stored, so an app you have never configured behaves exactly as it did before roles existed. `Excluded` overrides every filter, including `All` — it is the one setting no Flow card can talk past.

The settings page lists each room with a dropdown of its lights; picking one adds it to that role's table, and the trash icon puts it back to main.

## Flow cards

All cards are **actions** (the *…then* column of a Flow).

Two dropdowns appear on the set-cards, and they are independent:

- **`role`** — `All` · `Main only` · `Ambient only`
- **`state`** — `All lights` · `Only lights already on`. The second leaves lights that are currently off untouched, so an evening dim doesn't wake a lamp nobody switched on.

### `setroomlightsrole` — "Set \[role] lights of \[room] (\[state]) to brightness \[brightness] and temperature \[temperature]"

| Argument | Type | Range | Notes |
|---|---|---|---|
| `room` | autocomplete | — | Type to filter your zones by name |
| `role` | dropdown | All / Main only / Ambient only | |
| `state` | dropdown | All lights / Only lights already on | |
| `brightness` | range | 0 – 1, step 0.01 (shown as 0–100 %) | `0` turns the lights **off** instead of dimming to zero |
| `temperature` | range | 0 – 1, step 0.01 (shown as 0–100 %) | Only applied to lights that expose `light_temperature` |

Writes `onoff: true` before the brightness, so a light that was off actually comes on rather than depending on how the bulb interprets a `dim` write.

### `setroomlightscolorsrole` — "Set \[role] lights of \[room] (\[state]) to brightness \[brightness] and colour \[color]"

Same arguments, with `color` (`#RRGGBB`) in place of `temperature`. The hex is converted to HSV — Homey's `light_hue` / `light_saturation` / `dim` triple is HSV, with `dim` as the value channel — and the hue and saturation are written to the bulb. Lights without `light_hue` (plain white bulbs) simply take the brightness and ignore the colour. A malformed colour fails the card rather than writing nonsense to a bulb.

### `turnoffroomlights` — "Turn off \[role] lights of \[room]"

| Argument | Type | Range |
|---|---|---|
| `room` | autocomplete | — |
| `role` | dropdown | All / Main only / Ambient only |

Two arguments, because turning a room off shouldn't need five. There is no `state` argument — turning off a light that is already off is a no-op. `role: All` is the whole-room kill switch.

### `anyroomlightson` — condition: "Any \[role] light of \[room] is on"

The app's only **condition** card (the *…and* column). True when at least one light of the role is currently on — live state, not a cached snapshot. Excluded lights never count. Homey offers the inverted "…is off" variant automatically. A light whose on/off state cannot be read counts as on, consistent with the state filter on the set-cards.

### `dimroomlights` — "Dim \[role] lights of \[room] \[direction] by \[step]"

Relative dimming for wall buttons and dial remotes. Only touches lights that are already on: dimming *up* never wakes a lamp nobody switched on. Reaching zero turns the light off; a light whose current brightness cannot be read is skipped.

### `toggleroomlights` — "Toggle \[role] lights of \[room] (on at brightness \[brightness])"

If any light of the role is on, turns them all off; otherwise turns them on at the given brightness, keeping whatever colour or temperature they last had.

### `saveroomlights` / `restoreroomlights` — "Save/Restore the lights of \[room]"

The movie-mode pair. *Save* remembers on/off, brightness and colour of every light in the room (minus excluded) in app settings, replacing the room's previous snapshot; *restore* replays it. A light removed since the save is skipped. Restoring a room that was never saved **fails the card** — silently doing nothing there just looks like the card is broken. Deleting a room discards its snapshot.

### Fade duration

`setroomlightsrole` and `setroomlightscolorsrole` support Homey's native duration picker. With a duration set, the brightness, temperature and colour writes all become fades, so a transition does not snap its colour halfway through; the on/off write stays instant, so a light that was off jumps on and then fades to the target. The deprecated cards do not get durations.

### Deprecated: `setroomlights` and `setroomlightscolors`

The original cards. They still work and their arguments are unchanged, but they no longer appear when building a new Flow. They take `room`, `brightness` and `temperature`/`color`, and apply to every light in the zone.

They share two behaviour fixes with the new cards: they skip `excluded` lights, and they write `onoff: true` before the brightness. The second one is a deliberate change to existing Flows — previously they wrote `dim` alone, which left a light that was off in a device-dependent state.

Migrate a Flow by replacing the card with its `…role` equivalent set to `All` / `All lights`, which now behaves identically.

## Driving main and ambient differently

There is no single card that sets main lights *and* ambient lights to different values — deliberately. Use two cards side by side in an Advanced Flow:

> *Set `Main only` lights of `Salon` (`All lights`) to brightness `40 %` and temperature `20 %`*
> *Turn off `Ambient only` lights of `Salon`*

They run independently, so the spots come up warm and dim while the TV strip goes dark. The same shape covers the reverse (ambient on, main off) and any other split.

A card argument was considered for this and rejected: an "other lights" dropdown could only ever turn the other group *off*, and a card with two full argument groups would show seven-plus controls that Homey cannot conditionally hide. Two cards stay readable and can express anything.

## Example

> **When** the motion sensor detects movement
> **And** it is after sunset
> **Then** *Set all the lights of `Living room` to brightness `40 %` and Color `#FF8800`*

## Architecture

Everything lives in a single [`app.js`](app.js) exporting one `Homey.App` subclass. There are no drivers — the app owns no devices of its own, it only drives existing ones.

```
onInit()
 ├─ HomeyAPI.createAppAPI()          → authenticated Homey Web API client
 ├─ buildRoomLightsZones()           → fills this.zoneFilter and this.myHome
 ├─ registers the Flow cards         → run listener + room autocomplete listener
 └─ watchForChanges()                → rebuilds the map when zones/devices change
```

Card registration comes before `watchForChanges()` on purpose: the cards work fine without live updates, so a failed event subscription must not leave the app with no cards at all.

Roles are read from settings on every card run rather than baked into `myHome`, so changing a role takes effect on the next run — no rebuild, no restart.

State held on the app instance:

- **`zoneFilter`** — `[{ id, name }]`, the list backing the room autocomplete. Excludes `_`-prefixed zones.
- **`myHome`** — `{ [zoneId]: { id, name, parentId, devices: { [deviceClass]: Device[] } } }`, every zone with its devices bucketed by class. A device is added to its own zone **and to every ancestor zone**, so targeting `Ground floor` also reaches the lights in the rooms below it.

Key methods:

| Method | Purpose |
|---|---|
| `buildRoomLightsZones()` | Fetches zones + devices and rebuilds the two structures above from scratch |
| `watchForChanges()` | Subscribes to `device.*` / `zone.*` events and schedules a debounced rebuild |
| `roomLights(room, role, state)` | **async.** The lights of a zone after the role and state filters, or `[]` |
| `freshDevices()` | Current device state, shared between concurrent callers and reused for 1 s; dropped by any write of ours |
| `lightRoles()` / `setLightRoles(roles)` | Read and persist the role map in app settings |
| `getLightsByZone()` | Rooms with their own lights and roles, for the settings page |
| `parseHexToHSV(hex)` | `#RRGGBB` → `[h, s, v]`, each normalised to 0–1 and rounded to 3 decimals; throws on anything that is not a `#RRGGBB` string |
| `applyBrightness(room, brightness, options, tint)` | Shared body of the set-cards: `0` means off, otherwise `onoff` then `dim` then the caller's colour write |
| `eachLight(lights, run)` | Runs a command against every light, tolerating individual failures; throws only if all of them failed |
| `setLightsBrightness(room, brightness, temperature)` | Backs the `setroomlights` card |
| `setRoomLightsColors(room, brightness, color)` | Backs the `setroomlightscolors` card; converts the hex then delegates to `setLightsColors` |
| `setLightsColors(room, brightness, hue, saturation)` | Writes `dim` / `light_hue` / `light_saturation` per device |
| `anyLightsOn(room, role)` | **async.** True when any non-excluded light of the role is on — backs the condition card and the toggle |
| `dimRoomLights(room, role, direction, step)` | Relative dim of the lights currently on, clamped to 0–1; zero turns off |
| `toggleRoomLights(room, role, brightness)` | All off if anything is on, otherwise on at the given brightness |
| `saveRoomLights(room)` / `restoreRoomLights(room)` | Persist and replay a per-room snapshot in the `lightSnapshots` setting |
| `write(device, capabilityId, value, duration)` | One capability write, as a fade when a duration (ms) is given |

The map is a snapshot, so the app subscribes to Homey's realtime `device.create` / `device.delete` / `device.update` and `zone.create` / `zone.delete` / `zone.update` events and rebuilds when any of them fire. A `device.update` only counts when the device's zone, class or name actually changed — everything else about a device leaves the map identical — and a payload too partial to tell rebuilds anyway.

Rebuilds are debounced by 5 s (`REBUILD_DEBOUNCE_MS`) so a burst of events collapses into one. The first event of a burst also opens a 30 s deadline (`REBUILD_MAX_WAIT_MS`): a trailing debounce on its own starves, because events arriving faster than the debounce would defer the rebuild forever.

## Repository layout

```
app.js                      the app: zone map, role filtering, Flow cards
api.js                      HTTP routes the settings page calls
settings/index.html         the role editor shown in the Homey app
app.json                    GENERATED — do not edit by hand
.homeycompose/
  app.json                  app manifest source, including the api routes
  flow/actions/*.json       one file per action card
  flow/conditions/*.json    one file per condition card
test/app.test.js            node --test suite for the pure logic
locales/en.json             settings-page copy (Flow card copy is inline in .homeycompose)
locales/fr.json             the same, in French
assets/
  icon.svg                  app icon
  images/                   store images + Makefile that generates them
```

`app.json` is produced by `homey app build` / `homey app run` from the files in `.homeycompose/`. **Edit `.homeycompose/`, never `app.json`** — hand edits to the generated file are overwritten on the next build.

The store images are regenerated from `roomLights.webp` with ImageMagick:

```bash
cd assets/images && make convert
```

## Development

Requires Node.js and the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started).

```bash
npm install
```

Run the tests — they stub the `homey` runtime, so no Homey is needed:

```bash
npm test
```

Install the CLI to run the app on real hardware:

```bash
npm install -g homey
```

Run the app on your own Homey with live logs:

```bash
homey app run
```

Install it permanently:

```bash
homey app install
```

Validate before publishing:

```bash
homey app validate --level publish
```

The app requests the `homey:manager:api` permission — it needs the Web API to enumerate zones and devices.

## Releasing

Bump `version` in `.homeycompose/app.json` and `package.json`, then add a matching entry to `.homeychangelog.json`:

```json
{
  "1.0.1": { "en": "What changed in this release." }
}
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Author

Guillaume Lemer — <guillaume@lemer.be>
