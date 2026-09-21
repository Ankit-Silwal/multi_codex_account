import { test, expect } from '@playwright/test';
const token = 'browser-test-token-not-a-real-secret';
async function login(page) {
  await page.goto('/');
  await page.getByLabel('Dashboard token').fill(token);
  await page.getByRole('button', { name: 'Open your workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'Keep the momentum.' }),
  ).toBeVisible();
}
test('desktop: authenticate, connect an account, fail over a job, inspect events, sign out', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page);
  await page.getByRole('button', { name: 'Connect an account' }).click();
  await page.getByLabel('Account name').fill('Personal');
  await page
    .locator('#account-form')
    .getByRole('button', { name: 'Add account' })
    .click();
  await expect(
    page
      .locator('#overview-accounts')
      .getByRole('heading', { name: 'Personal' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/overview-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'New job' }).click();
  await page
    .getByLabel('What should Codex do?')
    .fill('Review the demo project');
  await page.getByLabel('Project directory').fill('demo');
  await page.getByRole('button', { name: 'Queue job' }).click();
  await expect(page.locator('#job-detail > .badge')).toHaveText('Completed');
  await expect(page.locator('.output')).toContainText(
    'Browser test completed successfully.',
  );
  await expect(page.locator('.attempt')).toHaveCount(2);
  await page.screenshot({
    path: 'test-results/job-desktop.png',
    fullPage: true,
  });
  await page
    .locator('#detail-dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('link', { name: 'Job activity' }).click();
  await expect(
    page.getByRole('heading', { name: 'Every run, in view.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Dashboard token')).toBeVisible();
  expect(errors).toEqual([]);
});
test('mobile: no horizontal overflow, navigation and job permissions remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/overview-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'New job' }).click();
  await page
    .getByLabel('Permissions', { exact: true })
    .selectOption('workspace-write');
  await expect(
    page.getByLabel('Allow automatic retries of write-enabled jobs'),
  ).toBeVisible();
  await expect(
    page.getByLabel('Allow automatic retries of write-enabled jobs'),
  ).not.toBeChecked();
  await page.screenshot({
    path: 'test-results/job-mobile.png',
    fullPage: true,
  });
});
