# Contributing

Thanks for your interest in improving the World Cup Sweepstake Dashboard! This is a small,
dependency-light project with no build step, so getting started is quick.

## Getting set up

```bash
git clone <your-fork-url>
cd World_Cup_Dashboard
npm install
npm run dev
```

Open http://localhost:3050 and complete the setup wizard to get a working dashboard.

## Project layout

- `server.js` — Express server: serves `public/`, stores the sweepstake config in
  `data/config.json`, and proxies the upstream match API with an in-memory cache.
- `public/` — the front-end (plain HTML + Bootstrap 5 + vanilla JS, no framework):
  - `welcome.html` — first-run landing page
  - `setup.html` / `js/setup.js` — the setup wizard
  - `index.html` / `js/app.js` — the dashboard
  - `js/config.js` — runtime config loader and colour helpers
  - `css/` — theme (`styles.css`) and setup/welcome styling (`setup.css`)

## Guidelines

- **Keep it buildless.** No bundlers or transpilers — vanilla JS and CDN-loaded CSS only.
- **Match the existing style.** Follow the patterns and formatting already in each file.
- **Don't commit local state.** `data/config.json` is git-ignored on purpose; never commit
  a real configuration.
- **Test the flow manually.** Before opening a PR, walk through: first-run welcome → setup
  wizard (random draw + manual edit) → save → dashboard (fixtures, groups, leaderboard,
  head-to-head) → reconfigure.
- **Screenshots.** If a change affects the UI, update the images in `docs/screenshots/`.

## Opening a pull request

1. Create a branch: `git checkout -b my-change`.
2. Make your change and test it locally.
3. Write a clear commit message describing the *why*.
4. Open a PR summarising the change and how you verified it.

## Reporting issues

When filing a bug, please include: what you did, what you expected, what happened, your
Node.js version, and any relevant console/server output.
