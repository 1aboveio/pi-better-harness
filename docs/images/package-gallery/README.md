# Package Gallery Images

This folder keeps two package-gallery image styles:

- `./pi-better-*.png` and `./pi-better-*.svg` are the primary package images used by `package.json` `pi.image`. They are terminal-style screenshots generated from actual feature render surfaces with `npm run gallery:render`.
- `./overview/pi-better-*.png` and `./overview/pi-better-*.svg` are the earlier overview-card images. They are kept as alternate assets for docs, posts, or future package-gallery experiments.
- `./real-session/pi-better-harness.png`, `.svg`, and `.txt` are captured from a disposable real Pi TUI session with the goal, subagents, and background-task extensions loaded. The capture seeds durable extension state and uses a temporary probe extension only to read the live session id.

Run this from the repository root to regenerate only the primary actual-feature screenshots:

```sh
npm run gallery:render
```

Run this to recapture the real Pi TUI session screenshot:

```sh
npm run gallery:capture-real
```
