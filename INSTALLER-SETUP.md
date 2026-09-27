# Trendify Nexus installer v2

The public GitHub Pages page collects only a Cloudflare API token. A small dispatcher validates it, stores it encrypted in Cloudflare KV for up to 20 minutes, and triggers the public repository's GitHub Actions workflow. The workflow checks out the panel Worker from the private `Arefgh72/trendify-nexus-private` repository, claims the token once, creates or reuses D1, deploys the Worker, sets its `CF_TOKEN` and `CF_ACCOUNT_ID` secrets, and verifies first-run database setup.

The panel source and gateway source remain in the private repository. The public repository contains only the installer UI, dispatcher, and workflow orchestration.

## One-time setup

1. Create a fine-grained GitHub token limited to these repositories and permissions:
   - `Arefgh72/trendify-nexus-installer`: Actions **write**.
   - `Arefgh72/trendify-nexus-private`: Contents **read**.
2. Add that token as the public installer repository Actions secret `NEXUS_PRIVATE_SOURCE_TOKEN`.
3. Set the same token as the dispatcher Worker's `GITHUB_TOKEN` secret. The dispatcher needs it to dispatch the workflow and authenticate the Worker's one-time claim/progress calls.
4. Set the repository Actions variable `INSTALLER_DISPATCHER_URL` to the dispatcher's `https://…workers.dev` URL and set the same URL in `index.html`.
5. Create a Workers KV namespace and bind it as `JOBS` in `dispatcher/wrangler.jsonc`. Deploy `dispatcher/index.js`; keep `GITHUB_TOKEN` out of source control.
6. Enable GitHub Pages for the public installer repository from `main` (or the published installer branch after review).

The Cloudflare token is not placed in workflow-dispatch inputs or GitHub logs. It is encrypted at rest in KV, expires automatically, and is deleted when the runner claims it. The deployed panel needs the token later to create Gateway Workers, so the installer stores it as the panel Worker secret `CF_TOKEN`; it also stores the account ID as `CF_ACCOUNT_ID`.

The installer selects the first account accessible to the supplied token. A new panel initializes its D1 tables on first request and presents the first-admin setup flow; it does not create a default `admin/admin` password.

## Cloudflare API token permissions

The user token needs Account Settings **Read**, D1 **Edit**, and Workers Scripts **Edit** for the selected account.

