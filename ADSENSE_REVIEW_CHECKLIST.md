# Sky Hopper — AdSense re-review checklist

The code can improve the site's usefulness and policy readiness, but it cannot guarantee AdSense approval. Google's review is performed against the live site and may consider originality, user value, navigation, audience, and policy compliance.

## 1. Deploy and check every page

- [ ] Commit and deploy the updated project. Confirm the deployment completed without a build or hosting error.
- [ ] Open the live home page and play at least one Classic and one Arcade run on desktop and mobile.
- [ ] Open `guide.html`, `faq.html`, `about.html`, `contact.html`, `privacy.html` and `license.html` directly. Confirm none return a 404 and all navigation links work.
- [ ] Test guest pilot-name changes, refresh the page, then test a signed-in name change after applying the required Supabase SQL migration.
- [ ] Play enough Arcade runs to check that relics do not render on top of gates and that relic identity remains stable while it moves.
- [ ] Read the published copy for accuracy. Remove any feature claim that does not work on the live site; do not publish generated filler or misleading claims to increase page length.

## 2. Verify domain and publisher files

- [ ] Confirm the canonical URLs match the live domain.
- [ ] Open `https://dytal.github.io/robots.txt` and `https://dytal.github.io/sitemap.xml`; verify both are served from the site root.
- [ ] Open `https://dytal.github.io/ads.txt` and confirm it contains the publisher record matching the AdSense client ID used by the site. If the publisher ID changes, update both files from the actual AdSense account.
- [ ] In Search Console, verify the property and inspect the main page plus the new guide, FAQ and policy pages for indexing or crawl errors.

## 3. Privacy, contact and consent

- [ ] Replace the placeholder operational instruction by publishing a real, monitored *private* contact route for privacy/account-deletion requests. A public GitHub issue is not appropriate for private account data. Do not invent or publish a personal address you cannot monitor.
- [ ] Review the privacy notice against the final deployed services, current AdSense settings, Supabase configuration and any new analytics or advertising integration.
- [ ] In AdSense **Privacy & messaging**, configure and test the required Google-certified consent management platform (CMP) integrated with the IAB Transparency and Consent Framework when serving personalised ads to UK, EEA or Swiss users.
- [ ] Test the consent flow and ad behaviour from a relevant region before reapplying. Avoid ad placements that obstruct gameplay controls, look like game buttons, or interrupt users unexpectedly.

## 4. AdSense account eligibility

- [ ] The applicant must meet Google's age requirement. If the person maintaining the site is under 18, a parent or guardian must apply using their own Google Account and be the responsible payee if approved.
- [ ] Review the current official guidance before requesting another review:
  - [AdSense eligibility requirements](https://support.google.com/adsense/answer/9724?hl=en-GB)
  - [AdSense age requirement](https://support.google.com/adsense/answer/14230?hl=en-GB)
  - [Google CMP requirements for the UK, EEA and Switzerland](https://support.google.com/adsense/answer/13554116?hl=en-GB)

## 5. Request the review

Only after the live-site checks above are complete, open AdSense Policy Centre, confirm the reported issue has been addressed, tick the confirmation that the issues are fixed, and request a review. Approval is Google's decision; adding a guide and policy pages alone does not guarantee it.
