# anki-client

Browser-only SRS reviewer for personal study decks. Hosted on GitHub Pages,
auths to your GitHub account, reads card YAMLs from a private deck repo, and
stores per-card SRS state in two GitHub Projects v2 boards.

**Live**: https://dipidoo.github.io/anki-client/

## Design

See [`Agent.PD/learning/anki/SYNC-DESIGN.md`](https://github.com/dipidoo/Agent.PD/blob/main/learning/anki/SYNC-DESIGN.md) (private — owner-only) for the architecture decision record. The short version:

- **Cards**: YAML in [`dipidoo/anki-decks`](https://github.com/dipidoo/anki-decks) (private). Fetched at runtime via authenticated Contents API.
- **SRS state**: one ProjectV2 Item per card in `anki-client/srs-state` (private). Items created lazily on first review.
- **Session log**: one DraftIssue per study session in `anki-client/session-log` (private).
- **Scheduler**: [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) — same algorithm Anki ≥ 23.10 uses.
- **Auth**: GitHub OAuth Device Flow (no backend, no client secret). Personal-access-token paste-in is the fallback.

## Why device flow?

GitHub OAuth Apps do not support PKCE (the standard no-secret SPA flow). A static
SPA on Pages has no backend to hold the client secret. Device flow is the only
no-backend, no-secret option that GitHub officially supports.

## Forking

The bundled [`public/config.json`](./public/config.json) points at the maintainer's
deck repo and projects. To use this app against your own account:

1. Fork this repo, enable Pages.
2. Register an OAuth App on your account with Device Flow enabled. Set the
   homepage URL to your fork's Pages URL.
3. Create two private ProjectV2 boards named `anki-client/srs-state` and
   `anki-client/session-log`. (Schema in `SYNC-DESIGN.md` §11.1 / §6.3.)
4. Either edit `public/config.json` to your IDs and rebuild, **or** load the app,
   open the Settings panel (TODO), and paste your values — overrides persist in
   `localStorage` per-device.

## Development

```sh
npm install
npm run dev
```

Vite serves the app at http://localhost:5173/anki-client/ with HMR. Note that
the device-flow start endpoint (`github.com/login/device/code`) is not always
CORS-friendly from `localhost`; the PAT-paste fallback works in dev.

## License

MIT — see [`LICENSE`](./LICENSE).
