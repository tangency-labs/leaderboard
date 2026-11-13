# SolidCraft daily leaderboard

A daily board of who got the most pull requests merged into [tangency-labs/solidcraft](https://github.com/tangency-labs/solidcraft), live at [solidcraft.io/leaderboard](https://solidcraft.io/leaderboard/).

- Days run midnight to midnight US Eastern.
- Only merged PRs count. Opened ones never do.
- Bots are left out. `bherbruck` and `jyviko` appear in a separate maintainers line, not in the ranking.
- Each count links to the GitHub search for that person's merged PRs that day.
- Every day has its own page at `/<YYYY-MM-DD>/` with the board baked into the HTML and a 1200x630 share card (`og.png`), so link previews work without JavaScript.
- No trackers, and nothing downloads when a page opens.

## How it works

A GitHub Action runs every 15 minutes (`.github/workflows/leaderboard.yml`). `scripts/build.mjs` queries the GitHub search API with the workflow's own `GITHUB_TOKEN`, writes the site, renders the cards with the Chrome that ships on the runner, and commits changes to the `gh-pages` branch. Today's page refreshes from `leaderboard.json` every 5 minutes. After midnight Eastern the previous day is rebuilt once more and then frozen.

Run it locally with `GITHUB_TOKEN=$(gh auth token) BASE_URL=http://localhost:8000 node scripts/build.mjs site` (needs Node 22 and Chrome).

## License

MIT
