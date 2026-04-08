import { createHash } from 'crypto';

import { expect, test } from '@jupyterlab/galata';

import {
  clearBrowserStorageDrive,
  chooseFilesForUpload,
  getFileModel,
  isBrowserStorageFileListedInBrowser,
  normalizeNotebookSource,
  type UploadFile,
  uploadFiles
} from './browser_storage_utils';

// Deliberately larger than JupyterLab's 1 MiB upload chunking threshold.
const LARGE_UPLOAD_SIZE = 2 * 1024 * 1024 + 4096;

// Larger than JupyterLab's 15 MiB threshold that triggers a confirmation dialog.
const VERY_LARGE_UPLOAD_SIZE = 15 * 1024 * 1024 + 4096;

type GeneratedBinaryFile = UploadFile & {
  sha256: string;
};

type GeneratedTextFile = UploadFile & {
  text: string;
};

type GeneratedNotebookFile = UploadFile & {
  source: string;
};

test.describe('Browser Storage Upload Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto();
    await clearBrowserStorageDrive(page);
  });

  test('Upload multiple small text and binary files', async ({ page }) => {
    test.setTimeout(120000);

    const textFile = createTextFileFromContent(
      '00-upload-small.txt',
      `${createDeterministicText(4096, 'small-text')}\nCrème brûlée 😀\n`
    );
    const binaryFile = createBinaryFile('01-upload-small.bin', 4096, 17);

    await uploadFiles(page, [textFile, binaryFile]);
    expect(
      await isBrowserStorageFileListedInBrowser(page, textFile.name)
    ).toBeTruthy();
    expect(
      await isBrowserStorageFileListedInBrowser(page, binaryFile.name)
    ).toBeTruthy();

    const uploadedText = await getFileModel(page, textFile.name, 'text');
    expect(uploadedText.type).toBe('file');
    expect(uploadedText.format).toBe('text');
    expect(uploadedText.size).toBe(textFile.size);
    expect(uploadedText.content).toBe(textFile.text);

    const uploadedBinary = await getFileModel(page, binaryFile.name, 'base64');
    expect(uploadedBinary.type).toBe('file');
    expect(uploadedBinary.format).toBe('base64');
    expect(uploadedBinary.size).toBe(binaryFile.size);
    expect(uploadedBinary.content).toBe(binaryFile.base64);

    expect(sha256FromBase64(uploadedBinary.content as string)).toBe(
      binaryFile.sha256
    );
  });

  test('Upload a large text file', async ({ page }) => {
    test.slow();

    const textFile = createTextFile(
      '02-upload-large.txt',
      LARGE_UPLOAD_SIZE,
      'large-text'
    );

    await uploadFiles(page, [textFile]);
    expect(
      await isBrowserStorageFileListedInBrowser(page, textFile.name)
    ).toBeTruthy();

    const uploadedText = await getFileModel(page, textFile.name, 'text');
    expect(uploadedText.type).toBe('file');
    expect(uploadedText.format).toBe('text');
    expect(uploadedText.size).toBe(textFile.size);
    expect(uploadedText.content).toBe(textFile.text);
  });

  test('Upload a large binary file', async ({ page }) => {
    test.setTimeout(120000);

    const binaryFile = createBinaryFile(
      '03-upload-large.bin',
      LARGE_UPLOAD_SIZE,
      29
    );

    await uploadFiles(page, [binaryFile]);
    expect(
      await isBrowserStorageFileListedInBrowser(page, binaryFile.name)
    ).toBeTruthy();

    const uploadedBinary = await getFileModel(page, binaryFile.name, 'base64');
    expect(uploadedBinary.type).toBe('file');
    expect(uploadedBinary.format).toBe('base64');
    expect(uploadedBinary.size).toBe(binaryFile.size);
    expect(uploadedBinary.content).toBe(binaryFile.base64);
    expect(sha256FromBase64(uploadedBinary.content as string)).toBe(
      binaryFile.sha256
    );
  });

  test('Upload a small notebook', async ({ page }) => {
    const notebook = createNotebookFileFromSource(
      '04-upload-small.ipynb',
      `${createDeterministicText(
        2048,
        'small-notebook-cell'
      )}\nCrème brûlée à Paris 😀\n`
    );

    await uploadFiles(page, [notebook]);
    expect(
      await isBrowserStorageFileListedInBrowser(page, notebook.name)
    ).toBeTruthy();

    const uploadedNotebook = await getFileModel(page, notebook.name, 'json');
    expect(uploadedNotebook.type).toBe('notebook');
    expect(uploadedNotebook.format).toBe('json');
    expect(uploadedNotebook.size).toBe(notebook.size);
    expect(
      normalizeNotebookSource((uploadedNotebook.content as any).cells[0].source)
    ).toBe(notebook.source);
  });

  test('Upload a large notebook', async ({ page }) => {
    test.slow();

    const notebook = createNotebookFile(
      '05-upload-large.ipynb',
      LARGE_UPLOAD_SIZE,
      'large-notebook'
    );

    await uploadFiles(page, [notebook]);
    expect(
      await isBrowserStorageFileListedInBrowser(page, notebook.name)
    ).toBeTruthy();

    const uploadedNotebook = await getFileModel(page, notebook.name, 'json');
    expect(uploadedNotebook.type).toBe('notebook');
    expect(uploadedNotebook.format).toBe('json');
    expect(uploadedNotebook.size).toBe(notebook.size);
    expect(
      normalizeNotebookSource((uploadedNotebook.content as any).cells[0].source)
    ).toBe(notebook.source);
  });

  test('Upload a very large binary file with confirmation dialog', async ({
    page
  }) => {
    test.setTimeout(240000);

    const binaryFile = createBinaryFile(
      '06-upload-very-large.bin',
      VERY_LARGE_UPLOAD_SIZE,
      37
    );

    await chooseFilesForUpload(page, [binaryFile]);

    const dialog = page.locator('.jp-Dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Upload' }).click();

    await expect
      .poll(() => isBrowserStorageFileListedInBrowser(page, binaryFile.name))
      .toBeTruthy();

    await expect
      .poll(
        async () => (await getFileModel(page, binaryFile.name, 'base64')).size,
        {
          timeout: 120000
        }
      )
      .toBe(binaryFile.size);

    const uploadedBinary = await getFileModel(page, binaryFile.name, 'base64');
    expect(uploadedBinary.type).toBe('file');
    expect(uploadedBinary.format).toBe('base64');
    expect(uploadedBinary.size).toBe(binaryFile.size);
    expect(uploadedBinary.content).toBe(binaryFile.base64);
    expect(sha256FromBase64(uploadedBinary.content as string)).toBe(
      binaryFile.sha256
    );
  });
});

function createBinaryFile(
  name: string,
  size: number,
  seed: number
): GeneratedBinaryFile {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index++) {
    bytes[index] = (index * 31 + seed) % 256;
  }

  return {
    base64: encodeBytesToBase64(bytes),
    mimeType: 'application/octet-stream',
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  };
}

function createNotebookFile(
  name: string,
  sourceSize: number,
  label: string
): GeneratedNotebookFile {
  return createNotebookFileFromSource(
    name,
    createDeterministicText(sourceSize, `${label}-cell`)
  );
}

function createNotebookFileFromSource(
  name: string,
  source: string
): GeneratedNotebookFile {
  const content = JSON.stringify({
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source
      }
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: {
        name: 'python'
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  });

  return {
    base64: encodeStringToBase64(content),
    mimeType: 'application/x-ipynb+json',
    name,
    size: Buffer.byteLength(content, 'utf8'),
    source
  };
}

function createTextFile(
  name: string,
  size: number,
  label: string
): GeneratedTextFile {
  return createTextFileFromContent(name, createDeterministicText(size, label));
}

function createTextFileFromContent(
  name: string,
  text: string
): GeneratedTextFile {
  return {
    base64: encodeStringToBase64(text),
    mimeType: 'text/plain',
    name,
    size: Buffer.byteLength(text, 'utf8'),
    text
  };
}

function createDeterministicText(size: number, label: string): string {
  const pattern = `${label}|0123456789|abcdefghijklmnopqrstuvwxyz|ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`;
  return pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function encodeStringToBase64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function sha256FromBase64(base64: string): string {
  return createHash('sha256')
    .update(Buffer.from(base64, 'base64'))
    .digest('hex');
}
