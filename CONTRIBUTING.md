# Contributing to RoomLights

Thank you for taking the time to contribute!

RoomLights is a [Homey](https://homey.app) app maintained at
[Arylmera/RoomLights](https://github.com/Arylmera/RoomLights). Issues and pull requests for the app
belong here. For questions about Homey itself, use the
[community forum](https://community.homey.app) or the
[Homey Apps SDK docs](https://apps.developer.homey.app).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```bash
npm install
```

```bash
npm test
```

The tests stub the `homey` runtime, so they run with plain Node — no Homey required. To try the app
on real hardware you also need the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```bash
homey app run
```

See the [README](README.md#development) for the rest of the development workflow.

## Before submitting a bug report

* Have you read the error message in `homey app run` output?
* Have you searched for a similar issue?
* Have you updated Homey, the app, and the CLI?
* Is the problem in RoomLights, or in the app that provides the light device?

## A great bug report contains

* Context — what were you trying to achieve?
* Steps to reproduce from scratch, with the Flow card and its arguments.
* Which zone and what kind of lights are in it (colour, tunable white, plain on/off).
* Relevant log output from `homey app run`.
* Ideally a theory on the cause, and a possible fix.

## A great feature request contains

* The current situation, and why it is a problem.
* A use case — who needs this and why.
* A proposal, or better, a pull request.
* Any caveats.

## A great pull request contains

* Minimal changes, dedicated to one issue or feature. Unrelated changes go in a separate PR.
* No conflicts — rebase onto the latest `main` before submitting.
* Code matching the existing style (2-space indent, double quotes, `"use strict"`). Please don't
  reformat untouched whitespace.
* Tests in [`test/`](test) covering the change, and `npm test` passing.
* Updated documentation when behaviour changes.

## Things worth knowing

* **Modern JavaScript is fine.** The manifest declares `compatibility: ">=12.9.0"`, which is the
  Homey version that moved apps to Node 22, so optional chaining, nullish coalescing and logical
  assignment all work. If you ever lower `compatibility`, check the Node version that range implies
  before using newer syntax — below Homey v7.4.0 apps run on Node 12.
* **Never edit [`app.json`](app.json).** It is generated from [`.homeycompose/`](.homeycompose) by the
  Homey CLI and your changes will be overwritten. Edit `.homeycompose/app.json` or the per-card files
  under `.homeycompose/flow/actions/` instead.
* Adding a Flow card means a new JSON file in `.homeycompose/flow/actions/` **and** a
  `getActionCard(...)` registration in [`app.js`](app.js). The filename must match the card id.
* Changing a published card's arguments breaks every Flow already using it. Add
  `"deprecated": true` to the old card, leave its run listener alone, and ship a new card instead.
* API routes are implemented in [`api.js`](api.js) and declared in the `"api"` block of
  `.homeycompose/app.json`. The key there is the exported function name.
* Version bumps go in `.homeycompose/app.json`, `package.json`, and `.homeychangelog.json` together.

## License

Contributions are licensed under the [GPL-3.0](LICENSE) license that covers this project.
