import { Buffer } from 'buffer';

import { expect, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Contents } from '@jupyterlab/services';

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

function toBrowserStoragePath(path: string): string {
  return path.startsWith('BrowserStorage:') ? path : `BrowserStorage:${path}`;
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
  await page.getByRole('tab', { name: 'Browser Storage' }).click();
  await expect(page.locator('#jp-filesystem-browser')).toBeVisible();
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

export async function getBrowserStorageItems(
  page: IJupyterLabPageFixture
): Promise<Array<{ name: string; path: string; type: string }>> {
  return page.evaluate(async () => {
    const app = (window as any).galata.app;
    await app.serviceManager.ready;

    const widgets = Array.from(app.shell.widgets('left'));
    const browser = widgets.find((widget: any) => {
      return widget.id === 'jp-filesystem-browser';
    });

    if (!browser) {
      throw new Error('Browser Storage file browser not found');
    }

    await browser.model.refresh();
    return Array.from(browser.model.items()).map((item: any) => ({
      name: item.name,
      path: item.path,
      type: item.type
    }));
  });
}

export async function isBrowserStorageFileListedInBrowser(
  page: IJupyterLabPageFixture,
  name: string
): Promise<boolean> {
  const items = await getBrowserStorageItems(page);
  return items.some(item => item.name === name);
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

  for (const file of files) {
    await expect
      .poll(() => isBrowserStorageFileListedInBrowser(page, file.name))
      .toBeTruthy();
  }
}

export async function getFileModel(
  page: IJupyterLabPageFixture,
  path: string
): Promise<UploadContentsModel> {
  const targetPath = toBrowserStoragePath(path);

  return page.evaluate(async filePath => {
    await (window as any).galata.app.serviceManager.ready;
    const model = await (window as any).galata.app.serviceManager.contents.get(
      filePath,
      {
        content: true
      }
    );
    return {
      content: model.content,
      format: model.format,
      path: model.path,
      size: model.size,
      type: model.type
    };
  }, targetPath);
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
  const targetPath = toBrowserStoragePath(path);

  await page.evaluate(async filePath => {
    const app = (window as any).galata.app;
    await app.commands.execute('docmanager:open', { path: filePath });
  }, targetPath);

  await page.waitForSelector('.jp-FileEditor');
  return page.evaluate(() => {
    const currentWidget = (window as any).galata.app.shell.currentWidget as {
      context: {
        model: {
          toString(): string;
        };
      };
    } | null;

    if (!currentWidget) {
      throw new Error('No active file editor widget');
    }

    return currentWidget.context.model.toString();
  });
}

export async function openAndGetNotebookCellSource(
  page: IJupyterLabPageFixture,
  path: string,
  cellIndex: number = 0
): Promise<string> {
  const targetPath = toBrowserStoragePath(path);

  await page.evaluate(async filePath => {
    const app = (window as any).galata.app;
    await app.commands.execute('docmanager:open', { path: filePath });
  }, targetPath);

  await page.waitForSelector('.jp-NotebookPanel');
  return page.evaluate(index => {
    const currentWidget = (window as any).galata.app.shell.currentWidget as {
      content: {
        model: {
          cells: {
            get(cellIndex: number): {
              sharedModel: {
                getSource(): string;
              };
            };
          };
        };
      };
    } | null;

    if (!currentWidget) {
      throw new Error('No active notebook widget');
    }

    return currentWidget.content.model.cells.get(index).sharedModel.getSource();
  }, cellIndex);
}
