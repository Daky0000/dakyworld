import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const date = new Date().toISOString();
  const visit = { id: "visit", sessionId: "session", country: "GH", countryName: "Ghana", city: "Kumasi", region: "Ashanti",
    flag: "", citySource: "geolite_city", locationStatus: "resolved", locationLabel: "Approximate location: Kumasi, Ashanti, Ghana",
    durationSeconds: 10, scrollDepth: 20, clickCount: 0, createdAt: date, updatedAt: date };
  const report = {
    demo: { id: "geo-demo", slug: "geo-demo", title: "Geo fixture", businessName: "Fixture", url: "http://127.0.0.1:5199/demo-fixture", views: 2, createdAt: date },
    summary: { totalViews: 2, uniqueVisitors: 2, totalVisits: 2, avgDurationSeconds: 10, avgScrollDepth: 20, totalClicks: 0, bounceRate: 0,
      locationCoverage: { total: 2, eligible: 2, local: 0, legacy: 1, unknown: 0, country: 1, city: 1, countryPercent: 50, cityPercent: 50 } },
    breakdowns: { countries: [{ code: "GH", name: "Ghana", count: 1, percentage: 50, flag: "" }],
      cities: [{ city: "Kumasi", region: "Ashanti", country: "Ghana", count: 1, percentage: 50, flag: "", unverified: false }],
      devices: [], browsers: [], os: [] },
    visits: [visit, { ...visit, id: "legacy", city: "Accra", citySource: "legacy", locationStatus: "legacy", locationLabel: "Legacy / unverified location" }],
    heatmap: { totalClicks: 0, clicks: [], topClickedElements: [] },
  };
  await page.route("**/api/demos/geo-demo/analytics", route => route.fulfill({ json: report }));
  await page.goto("http://127.0.0.1:5199/builder-harness.html?analytics=1");
  await page.getByText("Location coverage: country 50%, city 50%.", { exact: false }).waitFor();
  assert.ok(await page.getByText("Kumasi, Ashanti", { exact: true }).count());
  assert.ok(await page.getByText("Legacy / unverified location", { exact: true }).count());
  assert.ok(await page.getByText("Approximate location: Kumasi, Ashanti, Ghana", { exact: true }).count());
  assert.deepEqual(errors, []);
  console.log("geoAnalytics: approximate, legacy, region and coverage labels render correctly");
} finally { await browser.close(); }
