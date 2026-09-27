# Trendify Nexus Installer

GitHub Pages presents a one-token installer. A user enters only a scoped Cloudflare API token; they do not need to sign in to GitHub. A small dispatcher validates the token and starts the GitHub Actions workflow. The workflow downloads the panel source from the private `Arefgh72/trendify-nexus-private` repository, creates or reuses D1, deploys the panel Worker, configures its bindings and secrets, and reports the resulting URL to the page.

The panel source and generated Gateway source are kept in the private repository. This public repository contains only the installation UI and deployment orchestration.

## First-time maintainer setup

Before publishing the new installer flow:

1. Create a fine-grained GitHub token restricted to the two repositories:
   - `trendify-nexus-installer`: Actions **write**.
   - `trendify-nexus-private`: Contents **read**.
2. Add that token to the public installer repository as Actions secret `NEXUS_PRIVATE_SOURCE_TOKEN`.
3. Set the same token as the dispatcher Worker's `GITHUB_TOKEN` secret.
4. Create a Workers KV namespace and bind it as `JOBS`, then deploy `dispatcher/index.js` using `dispatcher/wrangler.jsonc`. The KV ID and public URL are already configured for this dispatcher.
5. Merge and publish the installer branch through GitHub Pages.

Detailed setup and behavior: [INSTALLER-SETUP.md](INSTALLER-SETUP.md).

## Cloudflare token permissions

The end user’s token needs Account Settings **Read**, D1 **Edit**, and Workers Scripts **Edit** on the account that should receive the panel. The installer selects the first account available to that token.

The token is encrypted while briefly queued for the Action, is not sent in the workflow dispatch input, and is not printed in logs. The deployed panel needs it later to create Gateway Workers, so it is stored as the panel Worker secret `CF_TOKEN`; the account ID is stored as `CF_ACCOUNT_ID`. The panel initializes its D1 schema on first request and then guides the owner through creating the first administrator account.

## Persian

این صفحه فقط توکن Cloudflare را از کاربر می‌گیرد؛ ورود به GitHub لازم نیست. سرویس واسط توکن را بررسی و اجرای GitHub Actions را شروع می‌کند. Action کد پنل را از ریپازیتوری خصوصی می‌خواند، D1 را می‌سازد یا استفاده می‌کند، Worker پنل را دیپلوی و تنظیمات و Secretهای لازم را اضافه می‌کند.

کد پنل و Gateway در ریپازیتوری خصوصی `Arefgh72/trendify-nexus-private` باقی می‌ماند. این ریپازیتوری عمومی فقط صفحهٔ نصب و هماهنگی دیپلوی را نگه می‌دارد.

قبل از فعال‌کردن Pages، مراحل یک‌بارهٔ بالا و فایل [INSTALLER-SETUP.md](INSTALLER-SETUP.md) را کامل کن. توکن Cloudflare پس از نصب به‌عنوان Secret داخل Worker پنل ذخیره می‌شود، چون پنل برای ساخت Gateway به آن نیاز دارد.
