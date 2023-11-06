import { type Page } from '@playwright/test';

import {
  addNote,
  edgelessCommonSetup,
  getSelectedBound,
  selectNoteInEdgeless,
} from '../utils/actions/edgeless.js';
import { assertSelectedBound } from '../utils/asserts.js';
import { test } from '../utils/playwright.js';

test.describe('auto-connect', () => {
  async function init(page: Page) {
    await edgelessCommonSetup(page);
  }
  test('navigator', async ({ page }) => {
    await init(page);
    const id1 = await addNote(page, 'page1', 100, 100);
    await addNote(page, 'page2', 200, 300);
    await addNote(page, 'page3', 300, 500);
    await page.mouse.click(200, 50);
    await selectNoteInEdgeless(page, id1);
    const bound = await getSelectedBound(page, 0);
    await page.locator('.edgeless-index-label').nth(0).click();
    await assertSelectedBound(page, bound);

    await page.locator('.edgeless-auto-connect-next-button').click();
    bound[0] += 100;
    bound[1] += 200;
    await assertSelectedBound(page, bound);

    await page.locator('.edgeless-auto-connect-next-button').click();
    bound[0] += 100;
    bound[1] += 200;
    await assertSelectedBound(page, bound);
  });
});