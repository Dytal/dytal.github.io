# NeuraX Launcher

The official website of **NeuraX Launcher**, live at **https://dytal.github.io/**.
Owner & maintainer: **Anish Sandeep Bhargav (Dytalmc)** · fast, MIT licensed.

## Files in this pack

| File | Purpose |
|---|---|
| `index.html` | The full single-page site with complete SEO head (meta, Open Graph, Twitter card, canonical, hreflang) and schema.org JSON-LD structured data (WebSite, Person, SoftwareApplication, BreadcrumbList, FAQPage) |
| `css/style.css` | The complete stylesheet (dark premium theme, responsive, reduced-motion aware) |
| `js/main.js` | Vanilla JS: mobile nav, scroll-reveal, scroll-spy, screenshot lightbox, FAQ accordion, back-to-top |
| `404.html` | Branded 404 page (auto-served by GitHub Pages) |
| `robots.txt` | Crawler rules + sitemap pointer |
| `sitemap.xml` | XML sitemap for Google Search Console |
| `_config.yml` | Jekyll config for GitHub Pages (no plugins, launcher source dirs excluded from the served site) |
| `assets/favicon.svg` | NeuraX "N" favicon |

## Deploy (2 minutes)

1. Extract this archive at the **repository root** of `Dytalmc/dytal.github.io`
   (same level as `package.json` / `src/`). It does NOT touch your launcher source,
   and the screenshots folder is already in the repo.
2. Commit and push to `main`.
3. GitHub Pages builds automatically — done: https://dytal.github.io/

## After deploying — get ranked

1. **Google Search Console** → verify `https://dytal.github.io/`
   (paste your `<meta name="google-site-verification" content="...">` tag into
   `index.html` where the marked comment is).
2. Submit the sitemap: `https://dytal.github.io/sitemap.xml`.
3. Use **URL Inspection → Request indexing** on the homepage.
4. Bing Webmaster Tools: import from Search Console (it reads robots.txt automatically).

## Notes

- All screenshot references point to `screenshots/*.jpeg` already present in the repo
  (dashboard, versions, instances, create_instant, servers, create_server, modrinth,
  announcements, chatting, logs).
- The download button points to the official release:
  `releases/download/v1.0.0/NeuraX-Launcher-1.0.0.exe`.
- When you publish a new launcher release, update: version pills in `index.html`,
  the download URLs, `_config.yml` (`launcher.version` / `download_url`),
  and `sitemap.xml` `lastmod`.
