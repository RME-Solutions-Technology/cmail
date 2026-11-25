import { test, expect, open, seriousA11yViolations, horizontalOverflow, storageFor } from './fixtures';

// Focused Inbox (docs/focused-inbox.md). This spec turns the organisation
// switch on, which changes every inbox, so it runs in its own project
// ("focused-inbox" in playwright.config.ts) after the device projects, and
// in CI as its own step against a fresh seed. It runs as Mia (a manager):
// nothing photographs her views after this.

test.describe.configure({ mode: 'serial' });
test.use({ as: 'user-mia' });

const DESKTOP = { width: 1280, height: 860 };

// Never leave the switch on for later runs, even if a test fails.
test.afterAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ storageState: storageFor('user-mia', baseURL!), ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto('/admin/settings');
  const off = page.getByRole('button', { name: 'Turn off Focused Inbox' });
  if (await off.count()) await off.click();
  await context.close();
});
const PHONE = { width: 390, height: 844 };

async function setSwitch(page: import('@playwright/test').Page, on: boolean) {
  await open(page, '/admin/settings');
  const button = page.getByRole('button', { name: on ? 'Turn on Focused Inbox' : 'Turn off Focused Inbox' });
  await button.click();
  await expect(page.getByText(on ? 'Focused Inbox is on.' : 'Focused Inbox is off.')).toBeVisible();
}

test('switched off (the default): the Inbox has no tabs and lists every message', async ({ page }) => {
  await open(page, '/mail');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Roster for the spring working bee/ })).toBeVisible();
  await open(page, '/mail/settings');
  await expect(page.getByRole('heading', { name: 'Focused Inbox' })).toHaveCount(0);
});

test('a manager turns it on in Admin', async ({ page }) => {
  await setSwitch(page, true);
});

test('Focused and Other tabs: recent mail is sorted, nothing is hidden', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  // The first Inbox visit sorts recent mail in the background.
  await open(page, '/mail');
  const tabs = page.getByRole('tablist', { name: 'Inbox views' });
  await expect(tabs.getByRole('tab')).toHaveText([/Focused/, /Other/]);
  await expect(tabs.getByRole('tab', { name: /Focused/ })).toHaveAttribute('aria-selected', 'true');
  // news@ is an automated-looking sender: it ends up under Other.
  await expect(async () => {
    await open(page, '/mail?view=other');
    await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'focus-tab-other');
  await open(page, '/mail');
  await expect(page.getByRole('link', { name: /Roster for the spring working bee/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toHaveCount(0);
  // Search still covers the whole Inbox and shows no tabs.
  await open(page, '/mail?q=planting');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toBeVisible();
});

test('the tabs work from the keyboard', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, '/mail');
  const focused = page.getByRole('tab', { name: /Focused/ });
  const other = page.getByRole('tab', { name: /Other/ });
  // One tab stop: the selected tab.
  await expect(focused).toHaveAttribute('tabindex', '0');
  await expect(other).toHaveAttribute('tabindex', '-1');
  await focused.focus();
  await page.keyboard.press('ArrowRight');
  await expect(other).toBeFocused();
  await page.keyboard.press('Home');
  await expect(focused).toBeFocused();
  await page.keyboard.press('End');
  await expect(other).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=other/);
  await expect(page.getByRole('tab', { name: /Other/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Other/ })).toHaveAttribute('tabindex', '0');
});

for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
  for (const path of ['/mail', '/mail?view=other', '/mail/settings', '/mail/msg-grant']) {
    test(`axe: no serious issues, ${path} (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, path);
      const violations = await seriousA11yViolations(page);
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }
}

test('phone layout: the tabs fit, are large enough to tap, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, '/mail');
  const boxes = await page.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().toJSON() as DOMRect));
  for (const box of boxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.right).toBeLessThanOrEqual(PHONE.width);
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test('move to Focused from the list, then "always move" a sender to Other from a message', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, '/mail?view=other');
  await page.getByRole('checkbox', { name: /Select Spring planting bulletin/ }).check();
  await page.getByRole('button', { name: 'Move to Focused' }).click();
  await expect(page.getByText('1 message moved to Focused.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toHaveCount(0);
  await open(page, '/mail');
  await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toBeVisible();

  await open(page, '/mail/msg-hall');
  await expect(page.getByText('In Focused.')).toBeVisible();
  await page.getByRole('button', { name: 'Always move messages from this sender to Other' }).click();
  await expect(page).toHaveURL(/\/mail(\?|$)/);
  await open(page, '/mail?view=other');
  // Both of Ren's messages moved.
  await expect(page.getByRole('link', { name: /Hall key handover/ })).toHaveCount(2);
  await open(page, '/mail/settings');
  await expect(page.getByRole('cell', { name: 'ren.tanaka@ironbark.test', exact: true })).toBeVisible();
});

test('a manager turns it off: the Inbox is one list again', async ({ page }) => {
  await setSwitch(page, false);
  await open(page, '/mail');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Hall key handover/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Spring planting bulletin/ })).toBeVisible();
});
