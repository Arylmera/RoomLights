# RoomLights

A [Homey](https://homey.app) app that lets you control **every light in a zone at once** from a single Flow card — instead of adding one card per bulb.

| | |
|---|---|
| App ID | `inc.lemer.roomLights` |
| Version | 1.0.0 |
| Homey SDK | 3 |
| Compatibility | Homey `>=5.0.0`, platform `local` |
| Category | lights |
| License | GPL-3.0 (see [LICENSE](LICENSE)) |

## What it does

On start-up the app reads your Homey zones and devices through the Homey Web API and builds an in-memory map of *zone → devices grouped by device class*. Two Flow action cards then apply a setting to every device of class `light` in the chosen zone.

Zones whose name starts with an underscore (`_`) are hidden from the room autocomplete — use that prefix for zones you never want to target.

## Flow cards

Both cards are **actions** (the *…then* column of a Flow).

### `setroomlights` — "Set all the lights of \[room] to brightness \[brightness] and Temperature \[temperature]"

| Argument | Type | Range | Notes |
|---|---|---|---|
| `room` | autocomplete | — | Type to filter your zones by name |
| `brightness` | range | 0 – 1, step 0.01 (shown as 0–100 %) | `0` turns the lights **off** instead of dimming to zero |
| `temperature` | range | 0 – 1, step 0.01 (shown as 0–100 %) | Only applied to lights that expose `light_temperature` |

Sets the `dim` capability on every light in the zone, and `light_temperature` on the lights that support it.

### `setroomlightscolors` — "Set all the lights of \[room] to brightness \[brightness] and Color \[color]"

| Argument | Type | Range | Notes |
|---|---|---|---|
| `room` | autocomplete | — | Same zone picker as above |
| `brightness` | range | 0 – 1, step 0.01 (shown as 0–100 %) | `0` turns the lights **off** |
| `color` | color | `#RRGGBB` | Converted to hue/saturation before being applied |

The picked hex colour is converted to HSL; hue and saturation are written to `light_hue` and `light_saturation`. Lights without `light_hue` (e.g. plain white bulbs) simply take the brightness and ignore the colour.

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
 ├─ watchForChanges()                → rebuilds the map when zones/devices change
 └─ registers the two action cards   → run listener + room autocomplete listener
```

State held on the app instance:

- **`zoneFilter`** — `[{ id, name }]`, the list backing the room autocomplete. Excludes `_`-prefixed zones.
- **`myHome`** — `{ [zoneId]: { id, name, parentId, devices: { [deviceClass]: Device[] } } }`, every zone with its devices bucketed by class. A device is added to its own zone **and to every ancestor zone**, so targeting `Ground floor` also reaches the lights in the rooms below it.

Key methods:

| Method | Purpose |
|---|---|
| `buildRoomLightsZones()` | Fetches zones + devices and rebuilds the two structures above from scratch |
| `watchForChanges()` | Subscribes to `device.*` / `zone.*` events and schedules a debounced rebuild |
| `roomLights(room)` | The lights of a zone, or an empty array if the zone has none |
| `parseHexToHSL(hex)` | `#RRGGBB` → `[h, s, l]`, each normalised to 0–1 and rounded to 3 decimals |
| `setLightsBrightness(room, brightness, temperature)` | Backs the `setroomlights` card |
| `setRoomLightsColors(room, brightness, color)` | Backs the `setroomlightscolors` card; converts the hex then delegates to `setLightsColors` |
| `setLightsColors(room, brightness, hue, saturation)` | Writes `dim` / `light_hue` / `light_saturation` per device |

The map is a snapshot, so the app subscribes to Homey's realtime `device.create` / `device.delete` / `device.update` and `zone.create` / `zone.delete` / `zone.update` events and rebuilds when any of them fire. Rebuilds are debounced by 5 s (`REBUILD_DEBOUNCE_MS`) so a burst of events — pairing several devices, or a dimming light emitting `device.update` — collapses into one rebuild.

## Repository layout

```
app.js                      the entire app
app.json                    GENERATED — do not edit by hand
.homeycompose/
  app.json                  app manifest source
  flow/actions/*.json       one file per Flow card
test/app.test.js            node --test suite for the pure logic
locales/en.json             translation strings (empty — all copy is inline in .homeycompose)
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
