# Changelog

## 1.4.21
The ADO PAT is now encrypted at rest (AES-GCM 256) before it's written to
`chrome.storage.local`. The key is a non-extractable CryptoKey stored in the
extension's own IndexedDB — it can be used to encrypt/decrypt from the
background service worker, but its raw bytes can never be exported by any
script. The PAT is also no longer redisplayed in the settings form once saved
(shown as "Saved — leave blank to keep" instead). Existing plaintext-stored
PATs from before this version keep working and get upgraded to encrypted
storage automatically the next time settings are saved.

## 1.4.20
Fixed a crash when creating a Bug ("Cannot read properties of undefined, reading 'split'").
Screenshots are stored separately from the step object (`shot_<id>` keys) and weren't
being re-fetched before upload — bug creation with screenshots was silently broken.

## 1.4.19
Security hardening: locked `chrome.storage.local` to extension-only contexts
(`setAccessLevel('TRUSTED_CONTEXTS')`) so content scripts running on any page can no
longer read the stored ADO PAT.

## 1.4.18
Added a per-sprint Releases column to the QBR report/export; fixed the default
Release# field reference name.

## 1.4.17
Tightened "Stories" count to exact `User Story` type only; Test Cases no longer
require Closed state to be counted.

## 1.4.16
Rebuilt QBR filtering to match the team's real ADO reporting queries — `State=Closed`
gate, `WorkItemType NOT IN (Task, Test Case)` for points, exact Area Path match,
corrected Defect type name.

## 1.4.15
Added an auto-diagnostic when Test Cases come back as 0 in QBR, to pinpoint which
filter is excluding them.

## 1.4.14
Fixed Item Status filter incorrectly excluding items from sprint totals — it now only
gates the Release count, not Stories/Defects/Points.

## 1.4.13
Fixed QBR pulling in other teams' data (added exact Area Path scoping); split out a
pure "Story Points" column separate from total Velocity.

## 1.4.12
Added Area Path and Iteration Path columns to the QBR table/export.

## 1.4.11
Fixed Test Cases in QBR to query by Iteration Path like other types.

## 1.4.10
Added the hidden QBR sprint-reporting panel (secret-phrase trigger) — pulls
velocity/stories/defects/test cases/releases from ADO, sprint-wise, per quarter.

## 1.4.9
Added a Standard/High image quality toggle in the popup.

## 1.4.8 and earlier
Baseline QA capture/annotate/export/ADO-push extension.
