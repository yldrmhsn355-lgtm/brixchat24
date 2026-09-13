import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const credentials = Object.fromEntries(
  readFileSync("C:/ProgramData/Brixchat24/live/admin-access.txt", "utf8")
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.search(/[:=]/);
      return separator < 0
        ? []
        : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
    .filter((parts) => parts.length === 2),
);
const email = credentials["E-posta"];
const password = credentials["Parola"];
if (!email || !password)
  throw new Error("Platform verification credentials are unavailable");
const loginResponse = await fetch(
  "https://api.brixchat24.com/api/v1/auth/login",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  },
);
const loginBody = (await loginResponse.json()) as {
  data?: { accessToken?: string };
  error?: { code?: string };
};
if (!loginResponse.ok || !loginBody.data?.accessToken)
  throw new Error(
    `Live admin login failed: ${loginBody.error?.code ?? loginResponse.status}`,
  );
const identityResponse = await fetch(
  "https://api.brixchat24.com/api/v1/auth/me",
  {
    headers: { authorization: `Bearer ${loginBody.data.accessToken}` },
  },
);
const identity = (await identityResponse.json()) as {
  data?: { platformAdmin?: boolean };
  error?: { code?: string };
};
if (!identityResponse.ok || !identity.data?.platformAdmin)
  throw new Error(
    `Live platform identity failed: ${identity.error?.code ?? identityResponse.status}`,
  );

const organizationResponse = await fetch(
  "https://api.brixchat24.com/api/v1/platform-admin/organizations?limit=1&offset=0",
  { headers: { authorization: `Bearer ${loginBody.data.accessToken}` } },
);
const organizationBody = (await organizationResponse.json()) as {
  data?: Array<{ id: string; name: string }>;
};
if (!organizationResponse.ok || !organizationBody.data?.[0])
  throw new Error("Live organization verification fixture is unavailable");
const verificationOrganization = organizationBody.data[0];

const output = "artifacts/platform-admin-live";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
try {
  await page.addInitScript(
    (token) => localStorage.setItem("brixchat_access_token", token),
    loginBody.data.accessToken,
  );
  const routes = [
    ["/platform-admin", "Operasyon merkezi"],
    ["/platform-admin/organizations", "Firmalar"],
    ["/platform-admin/users", "Kullanıcı dizini"],
    ["/platform-admin/billing", "Abonelik ve fiyatlar"],
    ["/platform-admin/operations", "Operasyon sağlığı"],
    ["/platform-admin/alerts", "Uyarı merkezi"],
    ["/platform-admin/audit", "Denetim geçmişi"],
    ["/platform-admin/settings", "Platform ayarları"],
  ] as const;
  for (const [route, heading] of routes) {
    await page.goto(`https://brixchat24.com${route}`, {
      waitUntil: "networkidle",
    });
    try {
      await page
        .getByRole("heading", { name: heading })
        .waitFor({ timeout: 20_000 });
    } catch {
      const headings = await page.getByRole("heading").allTextContents();
      const alerts = await page.locator('[role="alert"]').allTextContents();
      const browserIdentity = await page.evaluate(async () => {
        const token = localStorage.getItem("brixchat_access_token");
        const response = await fetch("/api/v1/auth/me", {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        const body = await response.json().catch(() => ({}));
        return {
          hasToken: Boolean(token),
          status: response.status,
          platformAdmin: body?.data?.platformAdmin,
        };
      });
      throw new Error(
        `${route} did not render: ${JSON.stringify({ headings, alerts, browserIdentity, pageErrors })}`,
      );
    }
    if (await page.getByText("Veriler alınamadı").count())
      throw new Error(`${route} API state failed`);
  }
  await page.goto(
    `https://brixchat24.com/platform-admin/organizations/${verificationOrganization.id}`,
    { waitUntil: "networkidle" },
  );
  await page
    .getByRole("heading", { name: verificationOrganization.name })
    .waitFor();
  for (const label of [
    "Genel Bakış",
    "Üyeler",
    "Abonelik",
    "Modüller",
    "Kullanım",
    "Uyarılar",
    "Geçmiş",
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForLoadState("networkidle");
    if (await page.getByText("Veriler alınamadı").count())
      throw new Error(`Organization detail tab ${label} failed`);
  }
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["tablet", 820, 1100],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("https://brixchat24.com/platform-admin", {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Operasyon merkezi" }).waitFor();
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  }
  process.stdout.write(
    JSON.stringify({
      routes: routes.length,
      organizationTabs: 7,
      viewports: 3,
      status: "passed",
    }) + "\n",
  );
} finally {
  await browser.close();
}
