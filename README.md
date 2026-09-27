# HV Test

All HV Test self-assessment tests in one place. The home page lists every test as a card, and each test lives in its own folder.

**Live:** https://harshvittori.github.io/hv-tests/

| Test | Link |
|---|---|
| HV Personal Growth Test | https://harshvittori.github.io/hv-tests/tests/personal-growth/ |

Everything runs in the browser. No login, no server, and no answers are stored or sent anywhere. These are self-assessment and personal growth tools, not clinical or psychological diagnosis.

## Structure

```
index.html                     All Tests page (reads tests.json and shows the cards)
tests.json                     List of tests, built automatically. Do not edit by hand.
tests/
  personal-growth/
    index.html                 The test app
    test.json                  Card details for the All Tests page
scripts/build-manifest.mjs     Builds tests.json from every tests/*/test.json
.github/workflows/             Runs the script on every push to main
```

## Add a new test

1. Create a folder in `tests/` with a short lowercase name, for example `tests/career-clarity/`. This becomes the link: `.../tests/career-clarity/`.
2. Put the test app in it as `index.html`. Easiest start: copy `tests/personal-growth/index.html` and change the questions, dimensions, and copy. Keep the "All tests" link (`href="../../"`) on the intro screen.
3. Add `test.json` next to it:

```json
{
  "title": "HV Career Clarity Test",
  "tagline": "One line shown under the title.",
  "description": "Two or three lines on what the test covers and what the person gets.",
  "questions": "25",
  "minutes": 8,
  "outputs": ["Score out of 100", "Report PDF"],
  "status": "live",
  "order": 2,
  "added": "2026-10-15"
}
```

4. Commit to `main`. The GitHub Action rebuilds `tests.json` and the new card appears on the All Tests page in about a minute.

Only `title` is required. `status` can be `live` (clickable card), `coming-soon` (greyed card, no link, no `index.html` needed yet) or `hidden` (not listed, but the test link still works). Cards are sorted by `order`, then newest `added`. Folders starting with `_` are ignored, so a `_draft` folder stays private from the list.

To check locally: `node scripts/build-manifest.mjs` (writes `tests.json`) or `node scripts/build-manifest.mjs --check`.

## Update an existing test

Replace `tests/<name>/index.html` and commit. GitHub Pages redeploys automatically at the same link.
