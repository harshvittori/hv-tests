# HV Test

All HV Test self-assessment tests in one place. The home page lists every test as a card, grouped by category, and each test lives in its own folder.

**Live:** https://harshvittori.github.io/hv-tests/

| Test | Category | Link |
|---|---|---|
| Maturity Assessment | Personal Growth | https://harshvittori.github.io/hv-tests/tests/maturity-assessment/ |

Everything runs in the browser. No login, no server, and no answers are stored or sent anywhere. These are self-assessment and personal growth tools, not clinical or psychological diagnosis.

## Structure

```
index.html                     All Tests page (reads tests.json and shows the cards)
tests.json                     List of tests, built automatically. Do not edit by hand.
tests/
  maturity-assessment/
    index.html                 The test app
    test.json                  Card details for the All Tests page
  personal-growth/             Old link, redirects to maturity-assessment/
scripts/build-manifest.mjs     Builds tests.json from every tests/*/test.json
.github/workflows/             Runs the script on every push to main
```

## Add a new test

1. Create a folder in `tests/` with a short lowercase name, for example `tests/career-clarity/`. This becomes the link: `.../tests/career-clarity/`.
2. Put the test app in it as `index.html`. Easiest start: copy `tests/maturity-assessment/index.html` and change the questions, dimensions, and copy. Keep the "All tests" link (`href="../../"`) on the intro screen.
3. Add `test.json` next to it:

```json
{
  "title": "Career Clarity Test",
  "category": "Career",
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

4. For a proper link preview on WhatsApp and other apps, add a 1200x630 `og.png` in the test folder and copy the `og:` and `twitter:` meta tags from `tests/maturity-assessment/index.html` into the new page (change the title, description and URLs).
5. Commit to `main`. The GitHub Action rebuilds `tests.json` and the new card appears on the All Tests page in about a minute.

Only `title` is required. Tests with the same `category` appear together under one heading (no category: "More tests"). `status` can be `live` (clickable card), `coming-soon` (greyed card, no link, no `index.html` needed yet) or `hidden` (not listed, but the test link still works). Cards are sorted by `order`, then newest `added`. Folders starting with `_` are ignored, so a `_draft` folder stays private from the list.

To check locally: `node scripts/build-manifest.mjs` (writes `tests.json`) or `node scripts/build-manifest.mjs --check`.

## Rename or move a test

Old links keep working if the old folder stays as a redirect: put an `index.html` in it that sends visitors to the new folder (see `tests/personal-growth/`), and a `test.json` with `"status": "moved"` so it is not listed.

## Update an existing test

Replace `tests/<name>/index.html` and commit. GitHub Pages redeploys automatically at the same link.
