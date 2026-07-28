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

* **Keep [`app.js`](app.js) parseable on Node 12.** The manifest declares `compatibility: ">=5.0.0"`,
  and Homey Pro (2016-2019) below firmware v7.4.0 runs Node 12. Optional chaining (`?.`) and nullish
  coalescing (`??`, `??=`) are a load-time `SyntaxError` there, so the app would not start at all.
  A test guards this. If you would rather use modern syntax, raise `compatibility` to `>=7.4.0` first.
* **Never edit [`app.json`](app.json).** It is generated from [`.homeycompose/`](.homeycompose) by the
  Homey CLI and your changes will be overwritten. Edit `.homeycompose/app.json` or the per-card files
  under `.homeycompose/flow/actions/` instead.
* Adding a Flow card means a new JSON file in `.homeycompose/flow/actions/` **and** a
  `getActionCard(...)` registration in [`app.js`](app.js). The filename must match the card id.
* Version bumps go in `.homeycompose/app.json`, `package.json`, and `.homeychangelog.json` together.

## License

Contributions are licensed under the [GPL-3.0](LICENSE) license that covers this project.
