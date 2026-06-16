# Privacy Policy — Stepture — QA Screenshots, Word Logs & Azure DevOps

_Last updated: [INSERT DATE]_

Stepture — QA Screenshots, Word Logs & Azure DevOps ("the Extension") is a Chrome browser extension that helps software testers capture annotated screenshots and screen recordings of web pages, compile them into a Word document test log, and optionally send the results to the user's own Azure DevOps organization.

This policy explains what the Extension does and does not do with your data.

## Summary

The Extension is designed to keep your data local. Screenshots, recordings, captions, and document generation all happen inside your browser. The Extension does not run its own servers, does not collect analytics, and does not transmit your data to the developer or any third party. The only external service the Extension communicates with is the Azure DevOps organization that you explicitly choose to connect to, using credentials you provide.

## What the Extension stores

The following are stored **locally** in your browser using Chrome's local storage, and never leave your device except as described under "Azure DevOps" below:

- **Test session data:** scenarios, step descriptions, Pass/Fail status, expected/actual results, timestamps, and the screenshots you capture or import.
- **Azure DevOps settings (optional):** your organization name, project name, team, area path, default field values, and a Personal Access Token (PAT) that you enter. These are stored locally so you do not have to re-enter them. The PAT is a credential you generate and control; you can clear it at any time using the "Clear" button in the Extension's settings.

This data remains on your device until you delete it (via the Extension's controls or by removing the Extension). It is not synced to the developer.

## What the Extension captures

- **Screenshots** are captured only when you explicitly click Capture. The Extension captures the visible area of the tab you are testing.
- **Screen recordings** are captured only when you click Record and choose a screen, window, or tab through the browser's own sharing picker. Optional microphone audio is included only if you enable it.
- The Extension does **not** read, log, or transmit the text or content of the web pages you visit. It only takes a screenshot image when you ask it to.

## Azure DevOps integration (optional)

If — and only if — you choose to use the Azure DevOps feature and click a push/attach action, the Extension sends the relevant data (such as screenshots, a Word document, a screen recording, step text, and field values) to the Azure DevOps organization you configured, using the Personal Access Token you provided. This communication goes directly from your browser to Azure DevOps (dev.azure.com) over HTTPS. The developer of the Extension does not receive or have access to this data.

You are responsible for the credentials you enter and for ensuring you are authorized to send data to the Azure DevOps organization you connect to.

## What the Extension does NOT do

- It does not collect personally identifiable information for the developer.
- It does not use analytics or tracking.
- It does not sell or share your data with third parties.
- It does not display ads.
- It does not send your data anywhere except the Azure DevOps organization you explicitly connect to.

## Data retention and deletion

All data is stored locally. To delete it:

- Use the Extension's "Clear All" (session) and "Clear" (Azure DevOps settings) controls, or
- Remove the Extension from Chrome, which clears its local storage.

## Permissions

The Extension requests browser permissions strictly to provide its features: capturing the active tab, injecting the annotation toolbar, storing your session locally, recording the screen when you choose to, and communicating with Azure DevOps when you initiate a push. Each permission is used only for the corresponding feature described above.

## Children

The Extension is a professional tool for software testing and is not directed at children.

## Changes to this policy

If this policy changes, the updated version will be posted at this URL with a new "Last updated" date.

## Contact

For questions about this policy, contact: [teja.ravi244@gmail.com]
