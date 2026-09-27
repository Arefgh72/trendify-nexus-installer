# Trendify Nexus Installer — Arefgh72 Fork

## English

This repository is forked from [Trendiify/trendify-nexus-installer](https://github.com/Trendiify/trendify-nexus-installer). It has been reviewed and adapted with assistance from GPT-6 Luna for the Arefgh72 Trendify Nexus releases. The installer now targets this project's Installer API and supports selecting a version whose panel source is kept in the private versioned source repository.

**Install this fork:** [Trendify Nexus Installer](https://arefgh72.github.io/trendify-nexus-installer/)

## فارسی

این مخزن از [Trendiify/trendify-nexus-installer](https://github.com/Trendiify/trendify-nexus-installer) فورک شده است. با کمک GPT-6 Luna بازبینی و برای نسخه‌های پروژهٔ Trendify Nexus متعلق به Arefgh72 اصلاح شده است. نصب‌کننده به API نصب اختصاصی این پروژه وصل می‌شود و امکان انتخاب نسخه‌ای را دارد که کد پنل آن در مخزن خصوصی و نسخه‌بندی‌شده نگهداری می‌شود.

نصب این فورک: [صفحهٔ نصب Trendify Nexus](https://arefgh72.github.io/trendify-nexus-installer/)

## Version notes / یادداشت‌های نسخه

### v1.0.0

**English:** The first versioned panel release in this fork. Its panel source was copied unchanged from the previous `src/main.js` source. Compared with the upstream installer, this fork retrieves the release from the private source repository through its own Installer API; v1.0.0 keeps the existing `trendify-nexus` Worker and D1 database names.

**فارسی:** اولین نسخهٔ نسخه‌بندی‌شدهٔ پنل در این فورک است. کد آن بدون تغییر از منبع قبلی `src/main.js` کپی شده است. تفاوت با نصب‌کنندهٔ اصلی این است که این فورک فایل نسخه را از مخزن خصوصی، از طریق Installer API خودش دریافت و نصب می‌کند؛ نام Worker و دیتابیس v1 همان `trendify-nexus` باقی می‌ماند.

### v2.0.0

**English:** Adds a gateway type choice when generating a gateway: **Non-Direct** uses the proxy-enabled gateway and its proxy-selection/cache behavior; **Direct** deploys the original pure-direct gateway worker without a public proxy. Unlike v1.0.0, v2.0.0 installs to its own `trendify-nexus-v2` Worker and D1 database, keeping the two panel versions separate. The Installer API must support the `version` field sent by this page and fetch `v2.0.0/main.js` from the private source repository.

**فارسی:** هنگام ساخت گیت‌وی، انتخاب نوع گیت‌وی اضافه شده است: **Non-Direct** از گیت‌وی دارای پروکسی و منطق انتخاب و کش پروکسی استفاده می‌کند؛ **Direct** همان Worker خالص و مستقیم نسخهٔ اصلی را بدون پروکسی عمومی مستقر می‌کند. برخلاف v1.0.0، این نسخه روی Worker و دیتابیس جداگانهٔ `trendify-nexus-v2` نصب می‌شود تا داده‌های دو نسخه از هم جدا بمانند. Installer API باید فیلد `version` ارسالی این صفحه را پشتیبانی کند و فایل `v2.0.0/main.js` را از مخزن خصوصی دریافت کند.

## Installer behavior / روند نصب

The browser sends the selected version and the user's Cloudflare API token to this project's Installer API. The API fetches the selected panel source from the private repository and deploys the matching panel Worker and D1 database.

مرورگر نسخهٔ انتخاب‌شده و توکن Cloudflare کاربر را به Installer API این پروژه می‌فرستد. API کد همان نسخه را از مخزن خصوصی می‌گیرد و Worker و دیتابیس متناظر را مستقر می‌کند.
