# Tencent Docs plugin (tencent-docs)

> Unofficial third-party plugin, built and maintained by MagicLizi. Not made by Tencent.

Lets Cindy read and write your Tencent Docs: find, read, summarize, create and edit docs, Word, Excel, slides,
smart sheets, mind maps and flowcharts, organize folders, knowledge spaces and sharing, import local files or web
pages, and read text from images.

The plugin uses the official Tencent Docs MCP service, so the available actions follow what Tencent Docs offers
(about 350 for Personal accounts).

## Install and update

1. Download the latest `tencent-docs-<version>.cindy` from
   [Releases](https://github.com/MagicLizi/cindy-tencent-docs-plugin/releases) and import it on the Cindy plugins page.
2. Later updates appear in the host section of the plugin settings: `githubRelease` points to this repository, and
   Cindy verifies the release asset digest before the normal plugin update confirmation.
3. Requires Cindy 0.1.141 or later.

## Connect

In Cindy, open Plugins → Tencent Docs:

- **Personal** (QQ / Weixin, docs.qq.com) and **Enterprise** (saas.docs.qq.com): click Connect account and approve
  access in your browser. You can connect both; Cindy asks which one to use each time.
- **Personal Token (optional)**: Tencent Docs grants one-click sign-in apps only read and write access, so deleting,
  moving or changing sharing is refused. Copy a personal Token from the
  [Tencent Docs open platform](https://docs.qq.com/open/auth/mcp.html) and save it in the settings; the plugin uses it
  only to retry those refused actions. Use the same account as one-click sign-in.

Credentials are encrypted and kept by Cindy. OAuth tokens are injected by Cindy and never reach plugin code; the
personal Token is only handed to the bundled Node worker for management actions.

## Permissions

- Network: `docs.qq.com` and `saas.docs.qq.com` only.
- Bundled Node worker (local access): starts only when you ask to import local files, package HTML, run OCR on local
  images, upload local images, or perform management actions with the personal Token. It reads the files at the paths
  you give and uploads them to Tencent Docs and the Tencent Cloud storage address Tencent Docs returns.
- A few internal Tencent Docs actions are hidden: unsupported-feature reporting (which would send your words to
  Tencent), skill update checks, and smart sheet app-internal commit and UI actions.

## Not included

Real-time editing of local Office files depends on Tencent's closed-source local editor engine, which has no public
distribution. Import local files as online docs first.

## Tests

```sh
node test/harness.mjs
```

Runs `main.js` and `node/worker.cjs` against local mock Personal and Enterprise MCP services. No network access.

## Trademarks

"Tencent Docs" and its logo belong to Tencent. The icon is the official logo from the Tencent Docs website. This is a
third-party plugin, not affiliated with or endorsed by Tencent.

## License

[Apache-2.0](LICENSE)
