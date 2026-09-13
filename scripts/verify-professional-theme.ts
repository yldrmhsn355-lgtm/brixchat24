import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const origin = process.env.THEME_PREVIEW_URL ?? "http://127.0.0.1:3320";
const localPreview = origin.startsWith("http://127.0.0.1:");
const smoke = process.env.THEME_SMOKE === "1";
const output = "artifacts/professional-theme";
mkdirSync(output, { recursive: true });
const credentials = Object.fromEntries(
  readFileSync("C:/ProgramData/Brixchat24/live/admin-access.txt", "utf8")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.search(/[:=]/);
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);
const response = await fetch("https://api.brixchat24.com/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: credentials["E-posta"],
    password: credentials["Parola"],
  }),
});
const auth = (await response.json()) as { data?: { accessToken: string } };
if (!response.ok || !auth.data?.accessToken)
  throw new Error(`Login failed: ${response.status}`);
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: localPreview ? ["--disable-web-security"] : [],
});
const errors: string[] = [];
try {
  const context = await browser.newContext();
  if (localPreview) {
    // Read-only UI testing with the production API. Never change server CORS.
    await context.route("https://api.brixchat24.com/**", async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          origin: "https://brixchat24.com",
        },
      });
    });
  }
  await context.addInitScript((token) => {
    if (location.pathname === "/login")
      localStorage.removeItem("brixchat_access_token");
    else localStorage.setItem("brixchat_access_token", token);
    localStorage.setItem("brixchat_app_theme", "light");
  }, auth.data.accessToken);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [name, width, height] of (
    [
      ["desktop", 1440, 1000],
      ["tablet", 820, 1100],
      ["mobile", 390, 844],
    ] as const
  ).filter(([name]) => !smoke || name === "mobile")) {
    await page.setViewportSize({ width, height });
    for (const route of [
      "/app/inbox",
      "/app/campaigns",
      "/app/automations",
      "/app/ai-chats",
      "/platform-admin",
      "/login",
    ].filter(
      (route) =>
        !smoke || ["/app/inbox", "/platform-admin", "/login"].includes(route),
    )) {
      console.log(`Checking ${name} ${route}`);
      await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
      await page
        .locator(
          route === "/login"
            ? ".premium-login-card"
            : route === "/platform-admin"
              ? ".pa-shell"
              : ".app-shell-premium",
        )
        .waitFor();
      await page.waitForTimeout(1500);
      if (route === "/app/inbox") {
        await page
          .locator(".conversation-row .row-title strong")
          .first()
          .waitFor();
        const readable = await page
          .locator(".conversation-row .row-title strong")
          .first()
          .evaluate((node) => {
            const rgb =
              getComputedStyle(node)
                .color.match(/\d+/g)
                ?.slice(0, 3)
                .map(Number) ?? [];
            return rgb.length === 3 && Math.max(...rgb) < 150;
          });
        if (!readable)
          errors.push(`${name}: light inbox names have insufficient contrast`);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      );
      if (overflow) errors.push(`${name} ${route}: horizontal overflow`);
      await page.screenshot({
        path: `${output}/${name}-${route.replaceAll("/", "_")}.png`,
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/app/inbox`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell-premium").waitFor();
  await page.locator(".conversation-row .row-title strong").first().waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.appTheme = "dark";
  });
  await page.screenshot({ path: `${output}/dark-inbox.png`, fullPage: true });
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log(
    JSON.stringify({
      routes: smoke ? 3 : 6,
      viewports: smoke ? 1 : 3,
      dark: true,
      status: "passed",
    }),
  );
} finally {
  await browser.close();
}
