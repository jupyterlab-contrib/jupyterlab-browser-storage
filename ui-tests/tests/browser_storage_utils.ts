import { Buffer } from 'buffer';

import { expect, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Contents } from '@jupyterlab/services';
import type { Locator } from '@playwright/test';

export type UploadFile = Readonly<{
  base64: string;
  mimeType: string;
  name: string;
  size: number;
}>;

type UploadContentsModel = Pick<
  Contents.IModel,
  'content' | 'format' | 'path' | 'size' | 'type'
>;

const BROWSER_STORAGE_TOOLBAR_SELECTOR = '#jp-browserstorage-toolbar';

function toBrowserStoragePath(path: string): string {
  return path.startsWith('BrowserStorage:') ? path : `BrowserStorage:${path}`;
}

function toBrowserStorageLocalPath(path: string): string {
  return toBrowserStoragePath(path).replace(/^BrowserStorage:/, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function browserStorageRoot(page: IJupyterLabPageFixture): Locator {
  return page
    .locator(BROWSER_STORAGE_TOOLBAR_SELECTOR)
    .locator('xpath=ancestor::*[contains(@class, "jp-FileBrowser")][1]');
}

function browserStorageTab(page: IJupyterLabPageFixture): Locator {
  return page.getByRole('tab', { name: 'Browser Storage' });
}

function browserStorageItemLocator(
  page: IJupyterLabPageFixture,
  name: string
): Locator {
  return browserStorageRoot(page).getByRole('listitem', {
    name: new RegExp(`^Name: ${escapeRegExp(name)}(?:$|\\s|\\n)`)
  });
}

export async function createBrowserStorageDirectory(
  page: IJupyterLabPageFixture
): Promise<string> {
  return page.evaluate(async () => {
    const app = (window as any).galata.app;
    await app.serviceManager.ready;

    const manager = app.serviceManager.contents as any;
    const drive = manager._additionalDrives.get('BrowserStorage');
    if (!drive) {
      throw new Error('BrowserStorage drive not found');
    }

    const model = await drive.newUntitled({ type: 'directory' });
    return `BrowserStorage:${model.path}`;
  });
}

export async function deleteBrowserStoragePath(
  page: IJupyterLabPageFixture,
  path: string
): Promise<void> {
  const targetPath = toBrowserStoragePath(path);
  await page.evaluate(async filePath => {
    const app = (window as any).galata.app;
    await app.serviceManager.ready;
    await app.serviceManager.contents.delete(filePath);
  }, targetPath);
}

export async function activateBrowserStorage(
  page: IJupyterLabPageFixture
): Promise<void> {
  const tab = browserStorageTab(page);

  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
  }

  await expect(page.locator(BROWSER_STORAGE_TOOLBAR_SELECTOR)).toBeVisible();
  await expect(browserStorageRoot(page)).toBeVisible();
}

export async function clearBrowserStorageDrive(
  page: IJupyterLabPageFixture
): Promise<void> {
  await page.evaluate(async () => {
    const app = (window as any).galata.app;
    await app.serviceManager.ready;

    const manager = app.serviceManager.contents as any;
    const drive = manager._additionalDrives.get('BrowserStorage');
    if (!drive) {
      throw new Error('BrowserStorage drive not found');
    }

    await drive.clearStorage();
  });
}

export async function isBrowserStorageFileListedInBrowser(
  page: IJupyterLabPageFixture,
  name: string
): Promise<boolean> {
  await activateBrowserStorage(page);
  return (await browserStorageItemLocator(page, name).count()) > 0;
}

async function openBrowserStorageDirectory(
  page: IJupyterLabPageFixture,
  directoryPath: string
): Promise<void> {
  await activateBrowserStorage(page);

  const homeButton = browserStorageRoot(page)
    .locator('.jp-FileBrowser-crumbs span')
    .first();
  if (await homeButton.count()) {
    await homeButton.click();
    await page.waitForTimeout(200);
  }

  for (const segment of directoryPath.split('/').filter(Boolean)) {
    const directory = browserStorageItemLocator(page, segment);
    await expect(directory).toBeVisible();
    await directory.dblclick();
    await browserStorageRoot(page)
      .getByText(`/${segment}/`, { exact: true })
      .waitFor();
    await page.waitForTimeout(200);
  }
}

export async function openBrowserStorageItem(
  page: IJupyterLabPageFixture,
  path: string
): Promise<void> {
  const localPath = toBrowserStorageLocalPath(path);
  const parts = localPath.split('/').filter(Boolean);
  const name = parts.pop();

  if (!name) {
    throw new Error(`Invalid BrowserStorage path: ${path}`);
  }

  await openBrowserStorageDirectory(page, parts.join('/'));

  const item = browserStorageItemLocator(page, name);
  await expect(item).toBeVisible();
  await item.dblclick();
}

export async function chooseFilesForUpload(
  page: IJupyterLabPageFixture,
  files: UploadFile[]
): Promise<void> {
  await activateBrowserStorage(page);

  const uploadButton = page.locator('#jp-browserstorage-toolbar .jp-id-upload');
  await expect(uploadButton).toBeVisible();

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    uploadButton.click()
  ]);

  await fileChooser.setFiles(
    files.map(file => ({
      buffer: Buffer.from(file.base64, 'base64'),
      mimeType: file.mimeType,
      name: file.name
    }))
  );
}

export async function uploadFiles(
  page: IJupyterLabPageFixture,
  files: UploadFile[]
): Promise<void> {
  await chooseFilesForUpload(page, files);
  const progressBar = page.locator('.jp-Statusbar-ProgressBar-progress-bar');

  for (const file of files) {
    await expect
      .poll(async () => {
        const isListed = await isBrowserStorageFileListedInBrowser(
          page,
          file.name
        );
        const isProgressHidden = !(await progressBar
          .isVisible()
          .catch(() => false));

        return isListed && isProgressHidden;
      })
      .toBeTruthy();
  }
}

export async function getFileModel(
  page: IJupyterLabPageFixture,
  path: string,
  format?: 'json' | 'text' | 'base64'
): Promise<UploadContentsModel> {
  const targetPath = toBrowserStoragePath(path);

  return page.evaluate(
    async options => {
      await (window as any).galata.app.serviceManager.ready;
      const model = await (
        window as any
      ).galata.app.serviceManager.contents.get(options.path, {
        content: true,
        format: options.format
      });
      return {
        content: model.content,
        format: model.format,
        path: model.path,
        size: model.size,
        type: model.type
      };
    },
    { path: targetPath, format }
  );
}

export async function getNotebookSource(
  page: IJupyterLabPageFixture,
  path: string
): Promise<string> {
  const model = await getFileModel(page, path);
  return normalizeNotebookSource((model.content as any).cells[0].source);
}

export function normalizeNotebookSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

export async function openAndGetEditorContent(
  page: IJupyterLabPageFixture,
  path: string
): Promise<string> {
  await openBrowserStorageItem(page, path);

  await page.waitForSelector('.jp-FileEditor');
  const editor = page.locator('.jp-FileEditor').getByRole('textbox').last();

  await editor.click();
  await editor.press('Control+A');
  await editor.press('Control+C');

  try {
    await page.context().grantPermissions(['clipboard-read']);
  } catch {
    // Firefox does not support clipboard-read but does not need it either.
  }

  return page.evaluate(() => navigator.clipboard.readText());
}

export async function openAndGetNotebookCellSource(
  page: IJupyterLabPageFixture,
  path: string,
  cellIndex: number = 0
): Promise<string> {
  await openBrowserStorageItem(page, path);

  await page.waitForSelector('.jp-NotebookPanel');
  return page.notebook.getCellTextInput(cellIndex);
}
