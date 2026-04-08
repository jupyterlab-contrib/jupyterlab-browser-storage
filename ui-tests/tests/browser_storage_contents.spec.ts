import { promises as fs } from 'fs';

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  clearBrowserStorageDrive,
  createBrowserStorageDirectory,
  deleteBrowserStoragePath,
  getNotebookSource,
  isBrowserStorageFileListedInBrowser,
  openBrowserStorageItem
} from './browser_storage_utils';

async function createNotebook(
  page: IJupyterLabPageFixture,
  source: string
): Promise<string> {
  return page.evaluate(async notebookSource => {
    const app = (window as any).galata.app;
    await app.serviceManager.ready;
    const name = `browser-storage-${Date.now()}-${Math.floor(
      Math.random() * 1000
    )}.ipynb`;
    const path = `BrowserStorage:${name}`;

    const content = {
      cells: [
        {
          cell_type: 'markdown',
          metadata: {},
          source: notebookSource
        }
      ],
      metadata: {
        orig_nbformat: 4
      },
      nbformat: 4,
      nbformat_minor: 5
    };

    await app.serviceManager.contents.save(path, {
      content,
      format: 'json',
      name,
      type: 'notebook'
    });

    return path;
  }, source);
}

async function createTextFile(
  page: IJupyterLabPageFixture,
  name: string,
  content: string
): Promise<string> {
  return page.evaluate(
    async ({ fileContent, fileName }) => {
      const app = (window as any).galata.app;
      await app.serviceManager.ready;

      const path = `BrowserStorage:${fileName}`;
      await app.serviceManager.contents.save(path, {
        content: fileContent,
        format: 'text',
        name: fileName,
        type: 'file'
      });

      return path;
    },
    { fileContent: content, fileName: name }
  );
}

async function createCustomJsonFile(
  page: IJupyterLabPageFixture,
  name: string,
  content: Record<string, unknown>
): Promise<string> {
  return page.evaluate(
    async ({ fileContent, fileName }) => {
      const app = (window as any).galata.app;
      await app.serviceManager.ready;

      const path = `BrowserStorage:${fileName}`;
      await app.serviceManager.contents.save(path, {
        content: fileContent,
        format: 'json',
        mimetype: 'application/json',
        name: fileName,
        type: 'file'
      });

      return path;
    },
    { fileContent: content, fileName: name }
  );
}

async function dismissKernelDialog(
  page: IJupyterLabPageFixture
): Promise<void> {
  const kernelDialog = page.locator('.jp-Dialog');
  const noKernelButton = kernelDialog.getByRole('button', {
    name: 'No Kernel'
  });

  try {
    await noKernelButton.click({ timeout: 5000 });
    await expect(kernelDialog).toBeHidden();
  } catch {
    // The notebook may already be open without prompting for a kernel.
  }
}

test.describe('Browser Storage Contents', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto();
    await clearBrowserStorageDrive(page);
  });

  test('lists BrowserStorage notebooks and keeps them across reloads', async ({
    page
  }) => {
    const source = '## Browser storage notebook';
    const notebookPath = await createNotebook(page, source);
    const notebookName = notebookPath.split(':')[1];

    expect(
      await isBrowserStorageFileListedInBrowser(page, notebookName)
    ).toBeTruthy();

    await page.reload();
    await page.waitForSelector('.jp-Launcher');

    expect(
      await isBrowserStorageFileListedInBrowser(page, notebookName)
    ).toBeTruthy();
    expect(await getNotebookSource(page, notebookPath)).toBe(source);
  });

  test('opens BrowserStorage notebooks in JupyterLab and saves edits', async ({
    page
  }) => {
    const notebookPath = await createNotebook(page, '## initial source');
    const updatedSource = '## saved from notebook panel';
    const selectAllShortcut =
      process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

    await openBrowserStorageItem(page, notebookPath);
    await page.waitForSelector('.jp-NotebookPanel');
    await dismissKernelDialog(page);

    await page.notebook.enterCellEditingMode(0);
    const cellEditor = page
      .locator('.jp-NotebookPanel .jp-Cell')
      .first()
      .getByRole('textbox');
    await expect(cellEditor).toBeVisible();
    await cellEditor.click();
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(updatedSource);
    await page.keyboard.press('Escape');

    await page
      .getByRole('button', { name: /Save and create checkpoint/ })
      .click();

    const notebookName = notebookPath.split(':')[1];
    const notebookTab = page.getByRole('tab', { name: notebookName });
    await notebookTab.locator('.lm-TabBar-tabCloseIcon').click();
    await expect(page.getByRole('tab', { name: notebookName })).toHaveCount(0);

    await openBrowserStorageItem(page, notebookPath);
    await page.waitForSelector('.jp-NotebookPanel');
    await dismissKernelDialog(page);

    await expect(
      page
        .locator('.jp-NotebookPanel')
        .getByRole('heading', { name: 'saved from notebook panel' })
    ).toBeVisible();
  });

  test('creates a BrowserStorage notebook and deletes it', async ({ page }) => {
    const notebookPath = await createNotebook(page, '## delete me');
    const notebookName = notebookPath.split(':')[1];

    expect(await getNotebookSource(page, notebookPath)).toBe('## delete me');
    expect(
      await isBrowserStorageFileListedInBrowser(page, notebookName)
    ).toBeTruthy();

    await deleteBrowserStoragePath(page, notebookPath);

    await expect
      .poll(() => isBrowserStorageFileListedInBrowser(page, notebookName))
      .toBe(false);
  });

  test('creates a folder with content and deletes it recursively', async ({
    page
  }) => {
    const directoryPath = await createBrowserStorageDirectory(page);
    const directoryName = directoryPath.split(':')[1];
    const nestedPath = `${directoryPath}/inside.txt`;

    await page.evaluate(async filePath => {
      const app = (window as any).galata.app;
      await app.serviceManager.ready;
      await app.serviceManager.contents.save(filePath, {
        content: 'inside folder',
        format: 'text',
        name: 'inside.txt',
        type: 'file'
      });
    }, nestedPath);

    expect(
      await isBrowserStorageFileListedInBrowser(page, directoryName)
    ).toBeTruthy();

    await deleteBrowserStoragePath(page, directoryPath);

    await expect
      .poll(() => isBrowserStorageFileListedInBrowser(page, directoryName))
      .toBe(false);
  });

  test('downloads a BrowserStorage notebook', async ({ page }) => {
    const source = '## Downloaded notebook';
    const path = await createNotebook(page, source);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async targetPath => {
        const app = (window as any).galata.app;
        const url =
          await app.serviceManager.contents.getDownloadUrl(targetPath);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = '';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, path)
    ]);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    const content = await fs.readFile(downloadPath!, 'utf8');
    const parsed = JSON.parse(content);

    expect(parsed.cells[0].source).toBe(source);
  });

  test('downloads BrowserStorage text files through the browser', async ({
    page
  }) => {
    const content = 'Browser storage download\nsecond line';
    const path = await createTextFile(page, 'download.txt', content);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async targetPath => {
        const app = (window as any).galata.app;
        const url =
          await app.serviceManager.contents.getDownloadUrl(targetPath);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = '';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, path)
    ]);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    expect(await fs.readFile(downloadPath!, 'utf8')).toBe(content);
  });

  test('downloads a custom file type from BrowserStorage', async ({ page }) => {
    const path = await createCustomJsonFile(page, 'test.customfile', {
      hello: 'coucou'
    });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async targetPath => {
        const app = (window as any).galata.app;
        const url =
          await app.serviceManager.contents.getDownloadUrl(targetPath);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = '';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, path)
    ]);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    const content = await fs.readFile(downloadPath!, 'utf8');
    expect(JSON.parse(content)).toEqual({ hello: 'coucou' });
  });
});
