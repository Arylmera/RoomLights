# RoomLights

A [Homey](https://homey.app) app that lets you control **every light in a zone at once** from a single Flow card — instead of adding one card per bulb.

| | |
|---|---|
| App ID | `inc.lemer.roomLights` |
| Version | 1.5.0 |
| Homey SDK | 3 |
| Compatibility | Homey `>=12.9.0`, platform `local` |
| Category | lights |
| License | GPL-3.0 (see [LICENSE](LICENSE)) |

## What it does

On start-up the app reads your zones and devices through the Homey Web API and builds an in-memory map of *zone → devices grouped by device class*. The Flow cards then act on every device of class `light` in the chosen zone: set brightness and temperature or colour, turn off, dim up or down, toggle, save and restore, and ask whether anything is on.

A device belongs to its own zone **and to every ancestor zone**, so targeting `Ground floor` also reaches the lights in the rooms below it.

Zones whose name starts with an underscore (`_`) are hidden from the room autocomplete — use that prefix for zones you never want to target. They still appear on the settings page, because their lights are still reached by any card targeting a parent zone, so their roles have to remain editable.

## Settings page

The app's settings page (Homey app → RoomLights → Settings) holds both configurations below. It is available in English and French, and follows Homey's own light or dark theme.

### Light roles

Every light has a role:

| Role | Meaning |
|---|---|
| **Main** | The room's functional lighting. The default — a light you never configure is main. |
| **Ambient** | Accent and mood lighting: strips, gradients, display cabinets. |
| **Excluded** | Never touched by any card, whatever it targets. For virtual devices and anything a room card should not sweep. |

Each room is listed with a dropdown of its lights; picking one adds it to that role's table, and the trash icon puts it back to main. Only non-default roles are stored, so an app you have never configured behaves exactly as it did before roles existed. `Excluded` overrides every filter, including `All`.

Roles only govern *this app's* cards. A Homey **mood** writes to the devices stored in it directly, so a mood containing an excluded light will still switch it on — and because excluded means never touched, no card of this app will switch it back off afterwards. If an excluded light keeps coming on, check the zone's moods before suspecting the role.

### Room brightness and temperature

Most houses already compute their lighting somewhere — a circadian Flow, a scene handler, a pair of Logic variables per room. The second half of the settings page maps each room to the Logic variables that already hold its **brightness** and its **temperature**; [`setroomlightsauto`](#setroomlightsauto) then reads them itself, so the card carries no values at all.

- Variables are stored by **id**, so renaming `Salon - Temp` in Homey does not unhook the room.
- Only **number** variables are offered; brightness and temperature are both 0–1.
- **Fill in from names** maps every room whose variables follow the `<Room> - Brightness` / `<Room> - Temp` convention. Matching ignores case and accents. An exact match wins, then a unique prefix match; an ambiguous one is left blank rather than guessed at, because `Hall` and `Hall d'entrée` are both rooms. Only empty slots are filled, so a choice you made by hand survives the button.
- Deleting a room discards its mapping.

### The off threshold

A brightness at or below this value means **off**, for every card — not just the automatic one. It defaults to **5 %** and lives above the room table.

The reason it exists: a circadian formula reaches "dark" as a small float far more often than as a clean zero. Told `0.0345`, the app used to write `onoff true` followed by `dim 0.0345`, the bulb obeyed, and the room glowed instead of going out. Insights on a live house showed the brightness variable sitting at one to three percent for a quarter of an hour at a stretch.

- The comparison is inclusive, so a threshold of **0** turns lights off only at exactly zero — that is how you switch the behaviour off, and there is no separate flag.
- It applies to a hand-dragged slider too. Setting a room to 3 % with a 5 % threshold turns it off.
- A stored value that is missing, out of range or not a number falls back to 5 %, because a corrupted setting must never be the reason the app stops turning lights off.
- A bulb whose own hardware minimum sits above the threshold can still glow. That needs a per-light minimum, which the app does not have.

### Daylight

The third section of the page lets a room's automatic brightness follow the light it already has: brighter outside, dimmer lamps, and the other way round. Rooms left unset behave exactly as before, so this changes nothing until you configure it.

Each room picks a **source** and then one of two **modes**.

#### Hold a level — the default

One number: **Full brightness (lux)**, what the room's sensor reads when the room is fully lit. The target rides the circadian variable from there, `target = fullLux × brightness`, so the room still dims through the evening.

Each re-evaluation compares the reading against that target and steps the lamps toward it. The lamps' own contribution never appears in the arithmetic — convergence discovers it, which is why nothing needs calibrating and nothing goes stale when a lamp moves.

The cost is **settling time**. Convergence takes several reports, and a Hue sensor reports every five minutes, so expect fifteen to thirty minutes from a cold start. The room is never dark while it settles: the card writes the circadian brightness first, exactly as it always did, and correction starts from there.

#### Follow the daylight

Two lux **anchors** and a **swing**. At or below **Dark** the room runs at *mapped brightness + swing*; at or above **Bright**, *mapped brightness − swing*. In between it's interpolated on `log10(lux)`, matching both the Zigbee illuminance encoding (`10000·log10(lux)+1`) and human brightness perception — a linear interpolation would spend almost its whole range on the top decade. At the **geometric mean** of the anchors the mapped brightness passes through untouched.

No settling and no defined level. Use it where the room must be right immediately.

#### What level is the right level

Published guidance is consistent:

| Room | Recommended |
|---|---|
| Kitchen worktop, office desk | 300–500 lx |
| Living room | 150–300 lx |
| Bathroom | 150 lx general, 400 lx at the mirror |
| Bedroom | 100–150 lx general, 300 lx for reading |
| Hall, stairs | 100–150 lx |

**None of those numbers goes in the box.** Every one is measured *at the task* — on the desk, the worktop, the floor. These sensors are on ceilings and walls and read light reflected back off the room, a small fraction of it: Bureau reads 3–30 lx while its desk is certainly in the hundreds. The daylight-harvesting literature is explicit that a ceiling sensor is closer to measuring luminance than illuminance, and treating one as the other is how these systems misbehave. Nothing in software bridges the two without a handheld meter.

So use the table to judge whether a room's *full brightness* is set sensibly, then light it that way and press **Measure**. The button re-reads the sensor and writes what it actually says. Every source is also listed with its live reading, for the same reason.

**Sources.** A room may point at any lux device, not only one in that room — pointing several rooms at a single well-placed sensor is a perfectly good configuration, and anchors are per-room so each still gets its own curve. *Modelled daylight* is computed instead of measured, from the sun's position (Homey's own coordinates plus the NOAA solar-position algorithm) scaled by the cloud cover of a weather device you name once, globally:

```
lux ≈ 120000 · sin(solar elevation) · (1 − 0.75 · cloudiness/100)
```

The cloudiness term is dropped — leaving a clear-sky curve, never darkness — when no weather device is mapped, when the stored one no longer resolves or no longer exposes `measure_cloudiness`, or when its reading is more than three hours old. That last case is not hypothetical: the house this was built against had a weather device sit frozen for three weeks while still answering with an entirely plausible number.

**Why neither mode hunts.** A sensor sitting in the room it lights sees its own lamps, which is a closed loop and the classic configuration for *hunting*: lamps brighten, the sensor reads more light, the controller dims, the sensor reads less.

*Follow* bounds it by clamping beyond the anchors, which holds the loop gain below one, plus a 3 % deadband that keeps small corrections off the mesh. That argument assumes the anchors sit **at least a decade apart** — the closer they are, the more brightness moves per lux, and a narrow span with a large swing is the one configuration that can sustain a cycle. Nothing clamps what you type, but the settings page says so when a room's anchors are less than tenfold apart with a swing above 25 %.

*Hold* contracts while `gain × s < 2`, where `s` is how many decades of measured light a full sweep of the dimmer is worth. A lamp-dominated room is worth about 1.5, and the gain of 0.4 stays contracting up to `s = 5` — past anything a real room does. A per-tick cap of 0.15 bounds a mis-estimated room to a walk rather than a jump. Integration happens on the output and the output is clamped to 0–1, so that clamp *is* the anti-windup: there's no accumulator to run away, and a target the lamps can't reach saturates at full instead of winding up behind it.

Modelled daylight has no feedback path at all — it cannot see your lamps — so it's stable whatever you set. It also cannot *hold* anything, for the same reason, so that combination is refused.

**Tracking.** [`setroomlightsauto`](#setroomlightsauto) on a room with a source doesn't just apply a value, it starts *tracking*: the room keeps being corrected as the light moves, on the sensor's own reporting cadence (five minutes for a Hue sensor) or on a five-minute timer for a modelled room. Tracking stops when every non-excluded light in the room is off, when [`stopdaylighttracking`](#stopdaylighttracking) runs, when the settings are saved, or when the zone map rebuilds. It is held in memory only, so restarting the app clears it and the next automatic card re-arms it.

Because tracking stops once the room is dark, daylight that dims a room through the [off threshold](#the-off-threshold) turns it off and leaves it off — it will not switch itself back on at dusk. Turning a room on is a Flow's decision, never the app's.

A **manual dim is transient**: the app corrects it back within one sample. Treating a hand-dialled level as a new baseline would need the app to tell its own writes from everyone else's, and it does not.

## Flow cards

Eleven **actions** (the *…then* column of a Flow) and one **condition** (the *…and* column).

| Card | Arguments | Fade |
|---|---|---|
| [`setroomlightsrole`](#setroomlightsrole) | room, role, state, brightness, temperature | ✓ |
| [`setroomlightscolorsrole`](#setroomlightscolorsrole) | room, role, state, brightness, colour | ✓ |
| [`setroomlightsauto`](#setroomlightsauto) | room, role, state | ✓ |
| [`turnoffroomlights`](#turnoffroomlights) | room, role | |
| [`dimroomlights`](#dimroomlights) | room, role, direction, step | |
| [`toggleroomlights`](#toggleroomlights) | room, role, brightness | |
| [`saveroomlights` / `restoreroomlights`](#saveroomlights--restoreroomlights) | room | |
| [`stopdaylighttracking`](#stopdaylighttracking) | room | |
| [`anyroomlightson`](#anyroomlightson) *(condition)* | room, role | |
| [`setroomlights` / `setroomlightscolors`](#deprecated-setroomlights-and-setroomlightscolors) | *deprecated* | |

Common arguments:

| Argument | Type | Notes |
|---|---|---|
| `room` | autocomplete | Type to filter your zones by name |
| `role` | dropdown | `All` · `Main only` · `Ambient only` |
| `state` | dropdown | `All lights` · `Only lights already on` — the second leaves lights that are currently off untouched, so an evening dim doesn't wake a lamp nobody switched on |
| `brightness` | range 0–1, step 0.01 (shown as 0–100 %) | Anything at or below the [off threshold](#the-off-threshold) turns the lights **off** instead of dimming them to almost nothing |
| `temperature` | range 0–1, step 0.01 | A colour bulb with no `light_temperature` takes the [nearest hue and saturation](#colour-bulbs-and-white-temperature) instead |
| `color` | colour picker (`#RRGGBB`) | Converted to HSV; plain white bulbs take the brightness and ignore it |

`role` and `state` are independent.

### Colour bulbs and white temperature

A `light_temperature` write only reaches a bulb that has a white channel. A colour-only bulb used to keep whatever hue it was last given while every other lamp in the room walked the circadian curve — visibly out of step, and easy to mistake for a light the app had stopped managing.

So a light that exposes `light_hue` but not `light_temperature` gets the same temperature converted to hue and saturation: 0–1 is mapped onto 6500 K–2200 K, through the standard blackbody approximation of the Planckian locus, and the resulting colour's value channel is discarded because `dim` already carries the brightness. A bulb that has both capabilities is untouched by this and still takes the temperature directly.

The two Kelvin bounds are Hue's range and are the only knob here: a lamp that still reads colder than the room's ceiling lights at the warm end wants the warm bound lowered, in [`lib/whitepoint.js`](lib/whitepoint.js). The match is an approximation and always will be — an RGB bulb has three narrow-band emitters where a white-tunable one has a phosphor, and no arithmetic reconciles that. At the cold end the result is near-white rather than exactly `#FFFFFF`, which is what a real 6500 K bulb looks like next to one.

### `setroomlightsrole`

> Set \[role] lights of \[room] (\[state]) to brightness \[brightness] and temperature \[temperature]

Writes `onoff: true` before the brightness, so a light that was off actually comes on rather than depending on how the bulb interprets a `dim` write.

### `setroomlightscolorsrole`

> Set \[role] lights of \[room] (\[state]) to brightness \[brightness] and colour \[color]

Same as above with `color` in place of `temperature`. The hex is converted to HSV — Homey's `light_hue` / `light_saturation` / `dim` triple is HSV, with `dim` as the value channel — and the hue and saturation are written to the bulb. A malformed colour fails the card rather than writing nonsense to a bulb.

### `setroomlightsauto`

> Set \[role] lights of \[room] (\[state]) to its mapped brightness and temperature

`setroomlightsrole` with the two value arguments removed. Brightness and temperature come from the Logic variables the room is mapped to on the settings page, read at run time — so a circadian Flow that moves those variables moves every Flow using this card.

A mapped brightness of `0` still means off, exactly as a typed `0` does. Values outside 0–1 are clamped rather than sent to a bulb.

The card **fails** when the room has no brightness variable mapped, or when that variable has been deleted or no longer holds a number — the error names the room. Doing nothing there would look exactly like a broken card. A missing *temperature* is not an error: the lights take the brightness and keep the tint they had.

If the room has a [daylight](#daylight) source, the mapped brightness is moved by the current light level before it is written, and the card also starts tracking — the room keeps being corrected as the daylight moves until something stops it. A room with no source is unaffected.

### `stopdaylighttracking`

> Stop daylight tracking in \[room]

Stops correcting the room until the automatic card runs again. It writes nothing itself.

This exists because `homey-api` ships **no moods manager** — there is no mood event an app can subscribe to — so a mood Flow has no way to say "leave this room alone" other than saying it. Drop this card into your mood Flows next to the mood itself, or a mood set on a tracking room is quietly overwritten a few minutes later.

### `turnoffroomlights`

> Turn off \[role] lights of \[room]

Two arguments, because turning a room off shouldn't need five. There is no `state` argument — turning off a light that is already off is a no-op. `role: All` is the whole-room kill switch.

### `dimroomlights`

> Dim \[role] lights of \[room] \[direction] by \[step]

Relative dimming for wall buttons and dial remotes. Only touches lights that are already on: dimming *up* never wakes a lamp nobody switched on. Reaching the [off threshold](#the-off-threshold) turns the light off, so holding *down* arrives at darkness instead of stalling at a glow; a light whose current brightness cannot be read is skipped.

### `toggleroomlights`

> Toggle \[role] lights of \[room] (on at brightness \[brightness])

If any light of the role is on, turns them all off; otherwise turns them on at the given brightness, keeping whatever colour or temperature they last had.

### `saveroomlights` / `restoreroomlights`

> Save / Restore the lights of \[room]

The movie-mode pair. *Save* remembers on/off, brightness and colour of every light in the room (minus excluded) in app settings, replacing the room's previous snapshot; *restore* replays it. A light removed since the save is skipped. Restoring a room that was never saved **fails the card** — silently doing nothing there just looks broken. Deleting a room discards its snapshot.

### `anyroomlightson`

> Any \[role] light of \[room] is on

The app's only condition card. True when at least one light of the role is currently on — re-read from Homey, not taken from the zone map's snapshot. Excluded lights never count. Homey offers the inverted "…is off" variant automatically. A light whose on/off state cannot be read counts as on, consistent with the `state` filter on the set-cards.

### Deprecated: `setroomlights` and `setroomlightscolors`

The original cards. They still work and their arguments are unchanged (`room`, `brightness`, and `temperature`/`color`, applied to every light in the zone), but they no longer appear when building a new Flow and they get no fade duration.

They share two behaviour fixes with the new cards: they skip `excluded` lights, and they write `onoff: true` before the brightness. The second is a deliberate change to existing Flows — previously they wrote `dim` alone, which left a light that was off in a device-dependent state.

Migrate a Flow by replacing the card with its `…role` equivalent set to `All` / `All lights`, which now behaves identically.

## Behaviour

### Fade duration

The three set-cards support Homey's native duration picker. With a duration set, the brightness, temperature and colour writes all become fades, so a transition does not snap its colour halfway through; the on/off write stays instant, so a light that was off jumps on and then fades to the target.

### When a light doesn't respond

One unreachable bulb is normal in a Zigbee or Z-Wave room, and it does not abort the card. Every light of the selection is commanded independently; a failure is logged against that light and the rest still go where you asked. The Flow only fails when *nothing* could be reached. The same applies to `restore`: lights that have gone missing since the save are skipped rather than failing the replay.

### Driving main and ambient differently

There is no single card that sets main lights *and* ambient lights to different values — deliberately. Use two cards side by side in an Advanced Flow:

> *Set `Main only` lights of `Salon` (`All lights`) to brightness `40 %` and temperature `20 %`*
> *Turn off `Ambient only` lights of `Salon`*

They run independently, so the spots come up warm and dim while the TV strip goes dark. A combined card would need two full argument groups — seven-plus controls Homey cannot conditionally hide — and could only ever turn the other group off.

## Architecture

[`app.js`](app.js) exports one `Homey.App` subclass and holds everything that talks to Homey. There are no drivers — the app owns no devices of its own, it only drives existing ones.

Beside it, [`lib/daylight.js`](lib/daylight.js) holds the arithmetic that decides how bright a room gets: solar position, modelled illuminance, the lux-to-brightness mapping, the hold loop, and the validation of a stored daylight entry. It imports nothing and touches no Homey API, which is the point — it is the part most worth testing, and its tests need no stub at all.

The settings page is tested too, through a small stub DOM in [`test/dom.js`](test/dom.js) that evaluates the page's own inline script. The stub is deliberately **strict**: any DOM property the page sets that it has not been taught throws, because a permissive stub is one that can be wrong in the same direction as the code it guards. Its fake server validates a save with the app's real `validDaylight`, so a page that builds something the app would reject fails in the suite rather than in your hands.

```
onInit()
 ├─ HomeyAPI.createAppAPI()          → authenticated Homey Web API client
 ├─ buildRoomLightsZones()           → fills this.zoneFilter, this.myHome, this.deviceIndex
 ├─ registerFlowCards()              → run listener + room autocomplete listener, one line per card
 └─ watchForChanges()                → rebuilds the map when zones/devices change
```

Card registration comes before `watchForChanges()` on purpose: the cards work fine without live updates, so a failed event subscription must not leave the app with no cards at all. `onUninit()` disarms every tracking room, so an app being stopped or updated does not leave capability listeners behind.

Roles are read from settings on every card run rather than baked into `myHome`, so changing a role takes effect on the next run — no rebuild, no restart.

### State held on the app instance

| Field | Contents |
|---|---|
| `zoneFilter` | `[{ id, name }]`, the list backing the room autocomplete. Excludes `_`-prefixed zones |
| `myHome` | `{ [zoneId]: { id, name, parentId, devices: { [deviceClass]: Device[] } } }`, every zone with its devices bucketed by class, ancestors included |
| `deviceIndex` | `Map<id, "zone\|class\|name">` as of the last rebuild. Compared against on each `device.update` to decide whether the map is actually affected. It stores strings rather than device references on purpose: homey-api mutates its cached `Device` in place *before* emitting, so a retained reference would always compare equal |
| `deviceCache` / `deviceGen` | The shared device read behind `freshDevices()`, and the generation counter that invalidates it. Anything that makes a read obsolete — one of our writes, or a rebuild — bumps the generation, so a read already in flight can neither be joined afterwards nor land in the cache |
| `variableCache` | The same shape for `logicVariables()`, minus the generation counter: the app only ever reads Logic variables, so nothing it does can make a read stale |
| `daylightTracking` | `Map<roomId, { room, options, lastWritten, source, instance, timer }>` — the rooms currently being corrected as their daylight moves, with the capability subscription or timer keeping each one going. In memory only: a restart clears it. A room is only published here once its subscription exists, so a failed read cannot strand an entry that has no listener |
| `daylightGen` | Bumped by anything that stops tracking, including a disarm of a room that is *not* in the map yet. An arm is asynchronous, so a stop card or rebuild landing during its device read has no instance to destroy — the arm compares this counter afterwards and destroys its own |

### Key methods

| Method | Purpose |
|---|---|
| `buildRoomLightsZones()` | Fetches zones + devices and rebuilds the structures above from scratch |
| `watchForChanges()` | Subscribes to `device.*` / `zone.*` events and schedules a debounced rebuild |
| `topologyChanged(device)` | Whether a `device.update` can actually affect the map. Anything too partial to tell counts as changed |
| `scheduleRebuild()` | Debounces the rebuild, without letting a steady event stream defer it past the deadline |
| `pruneByRoom(key)` | Drops entries of a room-keyed setting (`lightSnapshots`, `roomDefaults`, `daylight`) for rooms that no longer exist; never prunes against an empty zone map |
| `argId(value)` / `filters(args)` | Normalise a dropdown argument (object or plain string) and pull `role` + `state` off a card's arguments |
| `roomLights(room, role, state)` | **async.** The lights of a zone after the role and state filters, or `[]` |
| `isOn(device)` | Whether a light counts as on; unreadable state counts as on |
| `freshDevices()` | Current device state, shared between concurrent callers and reused for 1 s; dropped by any write of ours |
| `invalidateDevices()` | Marks every outstanding device read obsolete; called by `write()` and by each rebuild |
| `lightRoles()` / `setLightRoles(roles)` | Read and persist the role map in app settings |
| `getLightsByZone()` | Rooms with their own lights and roles, for the settings page |
| `logicVariables()` / `variableValue(variables, id)` | **async** read of every Logic variable, shared and cached for 1 s; and the number behind one id |
| `roomDefaults()` | The room → `{ brightness, temperature }` variable-id map from app settings |
| `roomDefaultValues(room)` | **async.** Resolves that mapping to numbers, clamped to 0–1. Throws when the brightness variable is unmapped, gone, or not a number; a missing temperature resolves to `null` |
| `getRoomDefaultsPage()` / `setRoomDefaults(body)` | **async.** Read and persist `{ mappings, offBelow, daylight, weather }` for the settings page; the save keeps only picker rooms and number variables, and drops an unusable threshold or daylight entry rather than storing it |
| `parseHexToHSV(hex)` | `#RRGGBB` → `[h, s, v]`, each normalised to 0–1 and rounded to 3 decimals; throws on anything else |
| `applyBrightness(room, brightness, options, tint)` | Shared body of the set-cards: `0` means off, otherwise `onoff` then `dim` then the caller's colour write |
| `eachLight(lights, run)` | Runs a command against every light, tolerating individual failures; throws only if all of them failed |
| `setLightsBrightness()` / `setLightsColors()` / `setRoomLightsColors()` | Back the brightness and colour set-cards |
| `setRoomLightsAuto(room, options)` | Backs the automatic card: apply the room's automatic brightness, then arm daylight tracking |
| `applyRoomAuto(room, options)` | **async.** The mapped values, moved by daylight, written to the room. Shared by the card and by every re-evaluation, so the two cannot drift apart |
| `daylightSettings()` / `roomDaylight(roomId)` | The room → daylight map from app settings, and one room's entry after validation (`null` when unusable). Each mode keeps only its own fields — `{ mode, source, fullLux }` or `{ mode, source, dark, bright, swing }` — so a stale anchor cannot come back later and change what a room does. An entry with no `mode` at all predates the hold mode and keeps following |
| `weatherDeviceId()` | The globally mapped weather device id, or `null` when none is stored |
| `geolocation()` | The house's latitude and longitude, or `null` on a Homey that cannot answer — needs the `homey:manager:geolocation` permission |
| `capabilityReading(deviceId, capabilityId)` | **async.** A numeric capability value with the age of the reading, or `null` for any way a stored device id stops meaning anything |
| `cloudiness()` | **async.** The cloud-cover percentage to scale the clear sky by, or `null` to drop the term (unmapped, unresolvable, capability gone, or stale) |
| `daylightLux(config)` / `daylightAdjusted(room, circadian, commanded)` | **async.** The room's daylight reading in lux, and the circadian brightness after it has been moved. `commanded` is what the app last wrote and only the hold loop uses it, stepping from where it left off; `null` means a cold start, where the step is taken from the circadian value |
| `armDaylight()` / `disarmDaylight()` / `disarmAllDaylight()` | Start and stop correcting a room: a capability subscription for a sensor source, a timer for a modelled one. Re-arming the same source does not stack a second listener, and a sensor that cannot be reached is logged rather than failing the card — the lights are already where they were asked to go |
| `reviewDaylight(roomId)` / `runDaylightReview()` | **async.** One re-evaluation: disarm if the room is dark, otherwise recompute and write, unless the change is inside the deadband. A review already running holds the room, so a sensor report landing mid-write steps aside rather than racing it; the level is recorded only once the write has gone out, so a failed one is retried instead of being swallowed by the deadband |
| `stopDaylightTracking(room)` | Backs the stop card |
| `daylightPage()` / `setDaylight(body)` | **async.** The daylight half of the settings route: every source with its current reading, and the validated save |
| `devicesWith(capabilityId)` | **async.** The ids of every device currently exposing a capability, so a saved source that no longer measures it can be refused |
| `turnOffRoomLights(room, role)` | Backs the turn-off card, and the off half of the toggle |
| `anyLightsOn(room, role)` | **async.** True when any non-excluded light of the role is on — backs the condition card and the toggle |
| `dimRoomLights(room, role, direction, step)` | Relative dim of the lights currently on, clamped to 0–1; reaching the off threshold turns off |
| `validOffBelow(value)` / `offBelow()` | The threshold check — a finite number in 0–1, or `null` — and the brightness at or below which a light is switched off rather than dimmed: the stored setting, or 5 % when it is missing or unusable |
| `toggleRoomLights(room, role, brightness)` | All off if anything is on, otherwise on at the given brightness |
| `saveRoomLights(room)` / `restoreRoomLights(room)` | Persist and replay a per-room snapshot in the `lightSnapshots` setting |
| `write(device, capabilityId, value, duration)` | One capability write, as a fade when a duration (ms) is given. The duration goes in homey-api's third `opts` argument — passed anywhere else it is dropped without an error and the light simply snaps |

### Keeping the map fresh

The map is a snapshot, so the app subscribes to Homey's realtime `device.create` / `device.delete` / `device.update` and `zone.create` / `zone.delete` / `zone.update` events and rebuilds when any of them fire. A `device.update` only counts when the device's zone, class or name actually changed — everything else about a device leaves the map identical — and a payload too partial to tell rebuilds anyway.

Rebuilds are debounced by 5 s (`REBUILD_DEBOUNCE_MS`) so a burst of events collapses into one. The first event of a burst also opens a 30 s deadline (`REBUILD_MAX_WAIT_MS`): a trailing debounce on its own starves, because events arriving faster than the debounce would defer the rebuild forever.

## Repository layout

```
app.js                      the app: zone map, role filtering, Flow cards, daylight tracking
lib/daylight.js             pure arithmetic: solar position, the lux → brightness mapping
api.js                      the four HTTP routes the settings page calls
settings/index.html         the role editor, the room → variable mapping, the daylight table
app.json                    GENERATED — do not edit by hand
.homeycompose/
  app.json                  app manifest source, including the api routes
  flow/actions/*.json       one file per action card
  flow/conditions/*.json    one file per condition card
.homeychangelog.json        per-version store changelog
test/app.test.js            node --test suite for the app and the daylight maths
test/settings.test.js       the settings page, driven through a stub DOM
test/dom.js                 that DOM, and the harness that evaluates the page
locales/en.json             settings-page copy (Flow card copy is inline in .homeycompose)
locales/fr.json             the same, in French
docs/superpowers/           design specs and implementation plans
assets/
  icon.svg                  app icon
  images/                   store images + Makefile that generates them
README.txt                  the one-line store description
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

Install the CLI to work against real hardware:

```bash
npm install -g homey
```

Install the app on your own Homey:

```bash
homey app install
```

Run it with live logs instead (stops when you disconnect):

```bash
homey app run
```

Validate before publishing:

```bash
homey app validate --level publish
```

The app requests the `homey:manager:api` permission — it needs the Web API to enumerate zones and devices.

## Releasing

Bump `version` in `.homeycompose/app.json` **and** `package.json`, then add a matching entry to `.homeychangelog.json`:

```json
{
  "1.2.1": { "en": "What changed in this release." }
}
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Author

Guillaume Lemer — <guillaume@lemer.be>
