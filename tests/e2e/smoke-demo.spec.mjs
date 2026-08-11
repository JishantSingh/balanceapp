import { test, expect } from '@playwright/test';

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
