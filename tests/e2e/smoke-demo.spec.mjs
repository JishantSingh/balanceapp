import { test, expect } from '@playwright/test';
import { lsJSON } from './helpers.mjs';

/* Demo mode is fully local — no backend, no routing needed. */

test('demo ledger opens and records an entry end-to-end', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btn-demo').click();

  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('#chip-demo')).toBeVisible();
  await expect(page.locator('.customer-row').first()).toBeVisible();

  const firstRow = page.locator('.customer-row').first();
  const name = await firstRow.locator('.customer-name').textContent();
  await firstRow.click();
  await expect(page.locator('#screen-customer')).toBeVisible();
  await expect(page.locator('#cust-name')).toHaveText(name);

  const balBefore = await page.locator('#bal-amt').textContent();
  await page.locator('#btn-gave').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await page.locator('#txn-amount').fill('123');
  await page.locator('#txn-save').click();

  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row').first()).toContainText('123');
  await expect(page.locator('#bal-amt')).not.toHaveText(balBefore);
});

test('demo Settings offer a real khata instead of a connection form that does nothing', async ({ page }) => {
  // The Connection block was visible in demo mode and its Save was silently
  // ignored — the one thing a demo user actually wants was nowhere.
  await page.goto('/');
  await page.locator('#btn-demo').click();
  await expect(page.locator('#screen-home')).toBeVisible();

  await page.locator('#btn-settings').click();
  await expect(page.locator('#dlg-settings')).toBeVisible();
  await expect(page.locator('.settings-conn')).toBeHidden();
  await expect(page.locator('#settings-demo')).toBeVisible();

  await page.locator('#btn-leave-demo').click();
  await expect(page.locator('#screen-connect')).toBeVisible();
  expect(await lsJSON(page, 'bahi.config')).toBe(null);
  expect(await lsJSON(page, 'bahi.demo')).not.toBe(null);   // the demo khata is kept

  // …and it is still there when they come back
  await page.locator('#btn-demo').click();
  await expect(page.locator('.customer-row').first()).toBeVisible();
});
