# Stepture

QA screenshot capture + annotation + Azure DevOps integration Chrome extension.
Built for Team Blaze (YPO Salesforce project).

## What it does
- Captures and annotates browser screenshots step-by-step during manual QA testing
- Generates Word test-log documents
- Pushes Bugs / Test Cases directly to Azure DevOps, with screenshots attached
- QBR sprint reporting panel (pulls velocity, story points, defects, test cases,
  releases per sprint from ADO) — internal use, opened via a secret trigger phrase
  in any textbox, not a visible menu item

## Distribution
Not published to the Chrome Web Store. Distributed internally as a packed `.crx`
(see manager/IT for the current signing key and internal hosting location).

## Current version
See `manifest.json` → `version`.

## Local setup
1. `chrome://extensions` → enable Developer mode
2. "Load unpacked" → select this folder

See `CHANGELOG.md` for version history.
