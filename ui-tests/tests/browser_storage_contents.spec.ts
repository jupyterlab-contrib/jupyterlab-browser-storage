import { Buffer } from 'buffer';
import { promises as fs } from 'fs';

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  clearBrowserStorageDrive,
  createBrowserStorageDirectory,
  deleteBrowserStoragePath,
  getFileModel,
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

async function createBinaryFile(
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
        format: 'base64',
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

    await openBrowserStorageItem(page, notebookPath);
    await page.waitForSelector('.jp-NotebookPanel');
    await page.notebook.setCell(0, 'markdown', updatedSource);
    await page.notebook.save();
    await expect
      .poll(() => getNotebookSource(page, notebookPath))
      .toBe(updatedSource);
  });

  test('roundtrips text and binary files through BrowserStorage contents', async ({
    page
  }) => {
    const textWithExtension = {
      content: 'Hello from BrowserStorage',
      name: 'example.txt'
    };
    const textWithoutExtension = {
      content: 'Crème brûlée 😀',
      name: 'example'
    };
    const binaryContent = Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x61]).toString(
      'base64'
    );
    const binaryWithExtension = {
      content: binaryContent,
      name: 'binary.bin'
    };
    const binaryWithoutExtension = {
      content: binaryContent,
      name: 'noext-binary'
    };

    const textPath = await createTextFile(
      page,
      textWithExtension.name,
      textWithExtension.content
    );
    const noExtensionTextPath = await createTextFile(
      page,
      textWithoutExtension.name,
      textWithoutExtension.content
    );
    const binaryPath = await createBinaryFile(
      page,
      binaryWithExtension.name,
      binaryWithExtension.content
    );
    const noExtensionBinaryPath = await createBinaryFile(
      page,
      binaryWithoutExtension.name,
      binaryWithoutExtension.content
    );

    expect(
      await isBrowserStorageFileListedInBrowser(page, textWithExtension.name)
    ).toBeTruthy();
    expect(
      await isBrowserStorageFileListedInBrowser(page, textWithoutExtension.name)
    ).toBeTruthy();
    expect(
      await isBrowserStorageFileListedInBrowser(page, binaryWithExtension.name)
    ).toBeTruthy();
    expect(
      await isBrowserStorageFileListedInBrowser(
        page,
        binaryWithoutExtension.name
      )
    ).toBeTruthy();

    const textModel = await getFileModel(page, textPath, 'text');
    expect(textModel.format).toBe('text');
    expect(textModel.size).toBe(Buffer.byteLength(textWithExtension.content));
    expect(textModel.content).toBe(textWithExtension.content);

    const noExtensionTextModel = await getFileModel(
      page,
      noExtensionTextPath,
      'text'
    );
    expect(noExtensionTextModel.format).toBe('text');
    expect(noExtensionTextModel.size).toBe(
      Buffer.byteLength(textWithoutExtension.content)
    );
    expect(noExtensionTextModel.content).toBe(textWithoutExtension.content);

    const noExtensionTextAsBase64 = await getFileModel(
      page,
      noExtensionTextPath,
      'base64'
    );
    expect(noExtensionTextAsBase64.format).toBe('base64');
    expect(noExtensionTextAsBase64.content).toBe(
      Buffer.from(textWithoutExtension.content, 'utf8').toString('base64')
    );

    const binaryModel = await getFileModel(page, binaryPath, 'base64');
    expect(binaryModel.format).toBe('base64');
    expect(binaryModel.size).toBe(Buffer.from(binaryContent, 'base64').length);
    expect(binaryModel.content).toBe(binaryContent);

    const noExtensionBinaryModel = await getFileModel(
      page,
      noExtensionBinaryPath,
      'base64'
    );
    expect(noExtensionBinaryModel.format).toBe('base64');
    expect(noExtensionBinaryModel.size).toBe(
      Buffer.from(binaryContent, 'base64').length
    );
    expect(noExtensionBinaryModel.content).toBe(binaryContent);

    const noContentModel = await page.evaluate(async path => {
      const app = (window as any).galata.app;
      await app.serviceManager.ready;

      const model = await app.serviceManager.contents.get(path, {
        content: false,
        format: 'text'
      });

      return {
        content: model.content,
        format: model.format,
        size: model.size,
        type: model.type
      };
    }, noExtensionTextPath);
    expect(noContentModel).toEqual({
      content: null,
      format: 'text',
      size: 0,
      type: 'file'
    });
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

  test('creates untitled files inside BrowserStorage directories', async ({
    page
  }) => {
    const directoryPath = await createBrowserStorageDirectory(page);
    const untitledModel = await page.evaluate(async path => {
      const app = (window as any).galata.app;
      await app.serviceManager.ready;

      return app.serviceManager.contents.newUntitled({
        ext: 'txt',
        path,
        type: 'file'
      });
    }, directoryPath);

    expect(untitledModel.name).toBe('untitled.txt');
    expect(untitledModel.path).toBe(`${directoryPath}/untitled.txt`);
    expect(untitledModel.format).toBe('text');
    expect(untitledModel.type).toBe('file');

    const untitledFile = await getFileModel(page, untitledModel.path, 'text');
    expect(untitledFile.path).toBe(untitledModel.path);
    expect(untitledFile.content).toBe('');
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
