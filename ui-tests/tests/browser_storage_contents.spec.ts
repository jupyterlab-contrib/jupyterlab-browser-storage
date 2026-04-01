import { promises as fs } from 'fs';

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  clearBrowserStorageDrive,
  createBrowserStorageDirectory,
  deleteBrowserStoragePath,
  getBrowserStorageItems,
  getNotebookSource
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

    let items = await getBrowserStorageItems(page);
    expect(items.map(item => item.name)).toContain(notebookName);

    await page.reload();
    await page.waitForSelector('.jp-Launcher');

    items = await getBrowserStorageItems(page);
    expect(items.map(item => item.name)).toContain(notebookName);
    expect(await getNotebookSource(page, notebookPath)).toBe(source);
  });

  test('opens BrowserStorage notebooks in JupyterLab and saves edits', async ({
    page
  }) => {
    const notebookPath = await createNotebook(page, '## initial source');
    const updatedSource = '## saved from notebook panel';

    await page.evaluate(async path => {
      const app = (window as any).galata.app;
      await app.commands.execute('docmanager:open', { path });
    }, notebookPath);

    await page.waitForSelector('.jp-NotebookPanel');

    await page.evaluate(source => {
      const app = (window as any).galata.app;
      const panel = app.shell.currentWidget as any;
      panel.content.model.cells.get(0).sharedModel.setSource(source);
    }, updatedSource);

    await page
      .getByRole('button', { name: /Save and create checkpoint/ })
      .click();
    await expect
      .poll(() => getNotebookSource(page, notebookPath))
      .toBe(updatedSource);
  });

  test('creates a BrowserStorage notebook and deletes it', async ({ page }) => {
    const notebookPath = await createNotebook(page, '## delete me');
    const notebookName = notebookPath.split(':')[1];

    expect(await getNotebookSource(page, notebookPath)).toBe('## delete me');
    expect(await getBrowserStorageItems(page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: notebookName, path: notebookPath })
      ])
    );

    await deleteBrowserStoragePath(page, notebookPath);

    await expect
      .poll(() =>
        getBrowserStorageItems(page).then(items =>
          items.some(item => item.name === notebookName)
        )
      )
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

    expect(await getBrowserStorageItems(page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: directoryName, path: directoryPath })
      ])
    );

    await deleteBrowserStoragePath(page, directoryPath);

    await expect
      .poll(() =>
        getBrowserStorageItems(page).then(items =>
          items.some(item => item.name === directoryName)
        )
      )
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
