import { PathExt, URLExt } from '@jupyterlab/coreutils';

import type { INotebookContent } from '@jupyterlab/nbformat';

import type { Contents } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';

import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import type localforage from 'localforage';

import { FILE, MIME } from './file';

type IModel = Contents.IModel;

export const DRIVE_NAME = 'BrowserStorage';

/**
 * The name of the local storage.
 */
const DEFAULT_STORAGE_NAME = 'JupyterLab Browser Storage';

/**
 * The number of checkpoints to save.
 */
const N_CHECKPOINTS = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function decodeBase64ToText(content: string): string {
  const binary = atob(content);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return decoder.decode(bytes);
}

function encodeTextToBase64(content: string): string {
  const binary = Array.from(encoder.encode(content), byte =>
    String.fromCharCode(byte)
  ).join('');
  return btoa(binary);
}

/**
 * Converts a contents model into JSON.
 */
function convertToJSON(model: Contents.IModel): Contents.IModel {
  switch (model.format) {
    case 'json': {
      return model;
    }
    case 'text': {
      return {
        ...model,
        content: JSON.parse(model.content as string),
        format: 'json'
      };
    }
    case 'base64': {
      return {
        ...model,
        content: JSON.parse(decodeBase64ToText(model.content as string)),
        format: 'json'
      };
    }
    default: {
      throw new Error(`Invalid format ${model.format}`);
    }
  }
}

/**
 * Converts a contents model into text.
 */
function convertToText(model: Contents.IModel): Contents.IModel {
  switch (model.format) {
    case 'json': {
      return {
        ...model,
        content: JSON.stringify(model.content),
        format: 'text'
      };
    }
    case 'text': {
      return model;
    }
    case 'base64': {
      return {
        ...model,
        content: decodeBase64ToText(model.content as string),
        format: 'text'
      };
    }
    default: {
      throw new Error(`Invalid format ${model.format}`);
    }
  }
}

/**
 * Converts a contents model into base64.
 */
function convertToBase64(model: Contents.IModel): Contents.IModel {
  switch (model.format) {
    case 'json': {
      return {
        ...model,
        content: encodeTextToBase64(JSON.stringify(model.content)),
        format: 'base64'
      };
    }
    case 'text': {
      return {
        ...model,
        content: encodeTextToBase64(model.content as string),
        format: 'base64'
      };
    }
    case 'base64': {
      return model;
    }
    default: {
      throw new Error(`Invalid format ${model.format}`);
    }
  }
}

export class BrowserStorageDrive implements Contents.IDrive {
  constructor(options: BrowserStorageDrive.IOptions) {
    this._localforage = options.localforage;
    this._storageName = options.storageName || DEFAULT_STORAGE_NAME;
    this._storageDrivers = options.storageDrivers || null;
    this._serverSettings =
      options.serverSettings ?? ServerConnection.makeSettings();
    this._storage = this.createDefaultStorage();
    this._counters = this.createDefaultCounters();
    this._checkpoints = this.createDefaultCheckpoints();
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
  }

  get name(): string {
    return DRIVE_NAME;
  }

  /**
   * Get the storage name used by the localforage instances.
   */
  get storageName(): string {
    return this._storageName;
  }

  /**
   * Set the storage name and recreate the localforage instances.
   */
  set storageName(value: string) {
    if (this._storageName === value) {
      return;
    }
    this._storageName = value;
    this._storage = this.createDefaultStorage();
    this._counters = this.createDefaultCounters();
    this._checkpoints = this.createDefaultCheckpoints();
  }

  get serverSettings(): ServerConnection.ISettings {
    return this._serverSettings;
  }

  get fileChanged(): ISignal<Contents.IDrive, Contents.IChangedArgs> {
    return this._fileChanged;
  }

  /**
   * Get a file or directory.
   *
   * @param path: The path to the file.
   * @param options: The options used to fetch the file.
   *
   * @returns A promise which resolves with the file content.
   */
  async get(path: string, options?: Contents.IFetchOptions): Promise<IModel> {
    // remove leading slash
    path = decodeURIComponent(path.replace(/^\//, ''));

    if (path === '') {
      return await this._getFolder(path);
    }

    const storage = this._storage;
    const item = await storage.getItem(path);
    let model = item as IModel | null;

    if (!model) {
      throw Error(`Could not find content with path ${path}`);
    }

    if (options?.content) {
      const requestedFormat = options.format;
      if (requestedFormat && model.format !== requestedFormat) {
        switch (requestedFormat) {
          case 'json': {
            model = convertToJSON(model);
            break;
          }
          case 'text': {
            model = convertToText(model);
            break;
          }
          case 'base64': {
            model = convertToBase64(model);
            break;
          }
        }
      }
    } else {
      return {
        ...model,
        size: 0,
        format: options?.format ?? model.format,
        content: null
      };
    }

    // for directories, find all files with the path as the prefix
    if (model.type === 'directory') {
      const contentMap = new Map<string, IModel>();
      await storage.iterate<IModel, void>((file, key) => {
        // use an additional slash to not include the directory itself
        if (key === `${path}/${file.name}`) {
          contentMap.set(file.name, file);
        }
      });

      const content = [...contentMap.values()];

      return {
        name: PathExt.basename(path),
        path,
        last_modified: model.last_modified,
        created: model.created,
        format: 'json',
        mimetype: MIME.JSON,
        content,
        size: 0,
        writable: true,
        type: 'directory'
      };
    }
    return model;
  }

  /**
   * Get the download URL.
   */
  async getDownloadUrl(path: string): Promise<string> {
    path = decodeURIComponent(path.replace(/^\//, ''));

    const localItem = (await this._storage.getItem(path)) as IModel | null;
    if (localItem && localItem.content !== null) {
      let blob: Blob;

      if (localItem.format === 'base64') {
        const binaryString = atob(localItem.content as string);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: localItem.mimetype });
      } else if (localItem.format === 'json') {
        const content = JSON.stringify(localItem.content);
        blob = new Blob([content], { type: localItem.mimetype });
      } else {
        blob = new Blob([localItem.content as string], {
          type: localItem.mimetype
        });
      }

      return URL.createObjectURL(blob);
    }

    const baseUrl = this.serverSettings.baseUrl;
    return URLExt.join(baseUrl, 'files', URLExt.encodeParts(path));
  }

  /**
   * Clear all storage (files, counters, and checkpoints).
   *
   * @returns A promise which resolves when all storage is cleared.
   */
  async clearStorage(): Promise<void> {
    await Promise.all([
      this._storage.clear(),
      this._counters.clear(),
      this._checkpoints.clear()
    ]);
  }

  /**
   * Create a new untitled file or directory in the specified directory path.
   *
   * @param options: The options used to create the file.
   *
   * @returns A promise which resolves with the created file content when the file is created.
   */
  async newUntitled(options?: Contents.ICreateOptions): Promise<IModel> {
    const path = options?.path ?? '';
    const type = options?.type ?? 'notebook';
    const created = new Date().toISOString();
    let name: string | undefined = undefined;

    let file: IModel;
    switch (type) {
      case 'directory': {
        const counter = await this._incrementCounter('directory');
        name = `Untitled Folder${counter || ''}`;
        file = {
          name,
          path: PathExt.join(path, name),
          last_modified: created,
          created,
          format: 'json',
          mimetype: '',
          content: null,
          size: 0,
          writable: true,
          type: 'directory'
        };
        break;
      }
      case 'notebook': {
        const counter = await this._incrementCounter('notebook');
        name = name || `Untitled${counter || ''}.ipynb`;
        file = {
          name,
          path: PathExt.join(path, name),
          last_modified: created,
          created,
          format: 'json',
          mimetype: MIME.JSON,
          content: Private.EMPTY_NB,
          size: encoder.encode(JSON.stringify(Private.EMPTY_NB)).length,
          writable: true,
          type: 'notebook'
        };
        break;
      }
      default: {
        let ext = options?.ext;
        if (ext && !ext.startsWith('.')) {
          ext = `.${ext}`;
        }
        const counter = await this._incrementCounter('file');
        const mimetype = ext
          ? FILE.getType(ext) || MIME.OCTET_STREAM
          : MIME.OCTET_STREAM;

        let format: Contents.FileFormat;
        if (!ext) {
          format = 'base64';
          ext = '';
        } else if (
          FILE.hasFormat(ext, 'text') ||
          mimetype.indexOf('text') !== -1
        ) {
          format = 'text';
        } else if (ext.indexOf('json') !== -1 || ext.indexOf('ipynb') !== -1) {
          format = 'json';
        } else {
          format = 'base64';
        }

        name = name || `untitled${counter || ''}${ext}`;
        file = {
          name,
          path: PathExt.join(path, name),
          last_modified: created,
          created,
          format,
          mimetype,
          content: '',
          size: 0,
          writable: true,
          type: 'file'
        };
        break;
      }
    }

    const key = file.path;
    await this._storage.setItem(key, file);
    this._fileChanged.emit({
      type: 'new',
      oldValue: null,
      newValue: file
    });
    return file;
  }

  /**
   * Delete a file from browser storage.
   *
   * Has no effect on server-backed files, which will re-appear with their
   * original timestamp.
   *
   * @param path - The path to the file.
   */
  async delete(path: string): Promise<void> {
    path = decodeURIComponent(path);
    const slashed = `${path}/`;
    const toDelete = (await this._storage.keys()).filter(
      key => key === path || key.startsWith(slashed)
    );
    await Promise.all(toDelete.map(this.forgetPath, this));
    this._fileChanged.emit({
      type: 'delete',
      oldValue: { path },
      newValue: null
    });
  }

  /**
   * Rename a file or directory.
   *
   * @param oldPath - The original file path.
   * @param newPath - The new file path.
   *
   * @returns A promise which resolves with the new file content model when the file is renamed.
   */
  async rename(oldPath: string, newPath: string): Promise<IModel> {
    const path = decodeURIComponent(oldPath);
    const file = await this.get(path, { content: true }).catch(() => null);
    if (!file) {
      throw Error(`Could not find file with path ${path}`);
    }
    const modified = new Date().toISOString();
    const name = PathExt.basename(newPath);
    const newFile = {
      ...file,
      name,
      path: newPath,
      last_modified: modified
    };
    const storage = this._storage;
    await storage.setItem(newPath, newFile);
    // remove the old file
    await storage.removeItem(path);
    // remove the corresponding checkpoint
    await this._checkpoints.removeItem(path);
    // if a directory, recurse through all children
    if (file.type === 'directory') {
      let child: IModel;
      for (child of file.content) {
        await this.rename(
          URLExt.join(oldPath, child.name),
          URLExt.join(newPath, child.name)
        );
      }
    }

    this._fileChanged.emit({
      type: 'rename',
      oldValue: { path: oldPath },
      newValue: newFile
    });

    return newFile;
  }

  /**
   * Save a file.
   *
   * @param path - The desired file path.
   * @param options - Optional overrides to the model.
   *
   * @returns A promise which resolves with the file content model when the file is saved.
   */
  async save(
    path: string,
    options: Partial<Contents.IModel> = {}
  ): Promise<IModel> {
    path = decodeURIComponent(path);

    // process the file if coming from an upload
    const name = options.name || PathExt.basename(path);
    const ext = name ? PathExt.extname(name) || undefined : undefined;
    const mimetype =
      options.mimetype ||
      (ext ? FILE.getType(ext) || MIME.OCTET_STREAM : MIME.OCTET_STREAM);
    const chunk = options.chunk;

    // retrieve the content if it is a later chunk or the last one
    // the new content will then be appended to the existing one
    const appendChunk = chunk ? chunk > 1 || chunk === -1 : false;
    let item: IModel | null = await this.get(path, {
      content: appendChunk
    }).catch(() => null);

    // keep a reference to the original content
    const originalContent = item?.content;

    const now = new Date().toISOString();
    let type = options.type || 'file';

    if (ext && ext.toLowerCase() === '.ipynb') {
      type = 'notebook';
    }

    const format = options.format ?? 'base64';
    const content = options.content ?? '';

    if (item) {
      item = {
        ...item,
        name,
        last_modified: now,
        format,
        mimetype,
        content,
        writable: true,
        type
      };
    } else {
      item = {
        name,
        path,
        last_modified: now,
        created: now,
        format,
        mimetype,
        content,
        size: 0,
        writable: true,
        type
      };
    }

    if (chunk) {
      const lastChunk = chunk === -1;

      const contentBinaryString = this._handleUploadChunk(
        content as string,
        originalContent,
        appendChunk
      );

      if (item.format === 'json') {
        const content = lastChunk
          ? JSON.parse(
              decoder.decode(this._binaryStringToBytes(contentBinaryString))
            )
          : contentBinaryString;
        item = {
          ...item,
          content,
          size: contentBinaryString.length
        };
      } else if (item.format === 'text') {
        const content = lastChunk
          ? decoder.decode(this._binaryStringToBytes(contentBinaryString))
          : contentBinaryString;
        item = {
          ...item,
          content,
          size: contentBinaryString.length
        };
      } else {
        const content = lastChunk
          ? btoa(contentBinaryString)
          : contentBinaryString;
        item = {
          ...item,
          content,
          size: contentBinaryString.length
        };
      }
    }

    // fixup content sizes if necessary
    if (item.content) {
      switch (item.format) {
        case 'json': {
          item = {
            ...item,
            size: encoder.encode(JSON.stringify(item.content)).length
          };
          break;
        }
        case 'text': {
          item = {
            ...item,
            size: encoder.encode(item.content as string).length
          };
          break;
        }
        case 'base64': {
          const padding = ((item.content as string).match(/=+$/) || [''])[0]
            .length;
          item = {
            ...item,
            size: ((item.content as string).length * 3) / 4 - padding
          };
          break;
        }
        default: {
          item = { ...item, size: 0 };
          break;
        }
      }
    } else {
      item = { ...item, size: 0 };
    }

    await this._storage.setItem(path, item);
    this._fileChanged.emit({
      type: 'save',
      oldValue: null,
      newValue: item
    });
    return item;
  }

  /**
   * Copy a file into a given directory.
   *
   * @param path - The original file path.
   * @param toLocalDir - The destination directory path.
   *
   * @returns A promise which resolves with the new contents model when the
   *  file is copied.
   *
   * #### Notes
   * The server will select the name of the copied file.
   */
  async copy(path: string, toLocalDir: string): Promise<IModel> {
    let name = PathExt.basename(path);
    toLocalDir = toLocalDir === '' ? '' : `${PathExt.removeSlash(toLocalDir)}/`;
    // TODO: better handle naming collisions with existing files
    while (
      await this.get(`${toLocalDir}${name}`, { content: true })
        .then(() => true)
        .catch(() => false)
    ) {
      const ext = PathExt.extname(name);
      const base = name.replace(ext, '');
      name = `${base} (copy)${ext}`;
    }
    const toPath = `${toLocalDir}${name}`;
    let item = await this.get(path, { content: true }).catch(() => null);
    if (!item) {
      throw Error(`Could not find file with path ${path}`);
    }
    item = {
      ...item,
      name,
      path: toPath
    };
    await this._storage.setItem(toPath, item);
    this._fileChanged.emit({
      type: 'new',
      oldValue: null,
      newValue: item
    });
    return item;
  }

  /**
   * Create a checkpoint for a file.
   *
   * @param path - The path of the file.
   *
   * @returns A promise which resolves with the new checkpoint model when the
   *   checkpoint is created.
   */
  async createCheckpoint(path: string): Promise<Contents.ICheckpointModel> {
    const checkpoints = this._checkpoints;
    path = decodeURIComponent(path);
    const item = await this.get(path, { content: true }).catch(() => null);
    if (!item) {
      throw Error(`Could not find file with path ${path}`);
    }
    const copies = (
      ((await checkpoints.getItem(path)) as IModel[]) ?? []
    ).filter(Boolean);
    copies.push(item);
    // keep only a certain amount of checkpoints per file
    if (copies.length > N_CHECKPOINTS) {
      copies.splice(0, copies.length - N_CHECKPOINTS);
    }
    await checkpoints.setItem(path, copies);
    const id = `${copies.length - 1}`;
    return { id, last_modified: item.last_modified };
  }

  /**
   * List available checkpoints for a file.
   *
   * @param path - The path of the file.
   *
   * @returns A promise which resolves with a list of checkpoint models for
   *    the file.
   */
  async listCheckpoints(path: string): Promise<Contents.ICheckpointModel[]> {
    const copies: IModel[] = (await this._checkpoints.getItem(path)) || [];
    return copies.filter(Boolean).map(this.normalizeCheckpoint, this);
  }

  /**
   * Restore a file to a known checkpoint state.
   *
   * @param path - The path of the file.
   * @param checkpointID - The id of the checkpoint to restore.
   *
   * @returns A promise which resolves when the checkpoint is restored.
   */
  async restoreCheckpoint(path: string, checkpointID: string): Promise<void> {
    path = decodeURIComponent(path);
    const copies = ((await this._checkpoints.getItem(path)) || []) as IModel[];
    const id = parseInt(checkpointID, 10);
    const item = copies[id];
    await this._storage.setItem(path, item);
  }

  /**
   * Delete a checkpoint for a file.
   *
   * @param path - The path of the file.
   * @param checkpointID - The id of the checkpoint to delete.
   *
   * @returns A promise which resolves when the checkpoint is deleted.
   */
  async deleteCheckpoint(path: string, checkpointID: string): Promise<void> {
    path = decodeURIComponent(path);
    const copies = ((await this._checkpoints.getItem(path)) || []) as IModel[];
    const id = parseInt(checkpointID, 10);
    copies.splice(id, 1);
    await this._checkpoints.setItem(path, copies);
  }

  /**
   * Get default options for localForage instances
   */
  protected get defaultStorageOptions(): LocalForageOptions {
    const driver =
      this._storageDrivers && this._storageDrivers.length
        ? this._storageDrivers
        : null;
    return {
      version: 1,
      name: this._storageName,
      ...(driver ? { driver } : {})
    };
  }

  /**
   * Initialize the default storage for contents.
   */
  protected createDefaultStorage(): LocalForage {
    return this._localforage.createInstance({
      description: 'Offline Storage for Notebooks and Files',
      storeName: 'files',
      ...this.defaultStorageOptions
    });
  }

  /**
   * Initialize the default storage for counting file suffixes.
   */
  protected createDefaultCounters(): LocalForage {
    return this._localforage.createInstance({
      description: 'Store the current file suffix counters',
      storeName: 'counters',
      ...this.defaultStorageOptions
    });
  }

  /**
   * Create the default checkpoint storage.
   */
  protected createDefaultCheckpoints(): LocalForage {
    return this._localforage.createInstance({
      description: 'Offline Storage for Checkpoints',
      storeName: 'checkpoints',
      ...this.defaultStorageOptions
    });
  }

  /**
   * Remove the localForage and checkpoints for a path.
   *
   * @param path - The path to the file
   */
  protected async forgetPath(path: string): Promise<void> {
    await Promise.all([
      this._storage.removeItem(path),
      this._checkpoints.removeItem(path)
    ]);
  }

  /**
   * Normalize a checkpoint
   */
  protected normalizeCheckpoint(
    model: IModel,
    id: number
  ): Contents.ICheckpointModel {
    return { id: id.toString(), last_modified: model.last_modified };
  }

  /**
   * Retrieve the contents for this path from the local storage.
   *
   * @param path - The contents path to retrieve
   *
   * @returns A promise which resolves with a Map of contents, keyed by local file name
   */
  private async _getFolder(path: string): Promise<IModel> {
    const content = new Map<string, IModel>();
    const storage = this._storage;
    await storage.iterate<IModel, void>((file, key) => {
      if (key.includes('/')) {
        return;
      }
      content.set(file.path, file);
    });

    return {
      name: '',
      path,
      last_modified: new Date(0).toISOString(),
      created: new Date(0).toISOString(),
      format: 'json',
      mimetype: MIME.JSON,
      content: Array.from(content.values()),
      size: 0,
      writable: true,
      type: 'directory'
    };
  }

  /**
   * Increment the counter for a given file type.
   * Used to avoid collisions when creating new untitled files.
   *
   * @param type The file type to increment the counter for.
   */
  private async _incrementCounter(type: Contents.ContentType): Promise<number> {
    const counters = this._counters;
    const current = ((await counters.getItem(type)) as number) ?? -1;
    const counter = current + 1;
    await counters.setItem(type, counter);
    return counter;
  }

  /**
   * Handle an upload chunk for a file.
   * Each chunk is base64 encoded, so decode it and append it to the original
   * content when needed.
   */
  private _handleUploadChunk(
    newContent: string,
    originalContent: unknown,
    appendChunk: boolean
  ): string {
    const newContentBinaryString = atob(newContent);
    return appendChunk
      ? `${(originalContent as string | undefined) || ''}${newContentBinaryString}`
      : newContentBinaryString;
  }

  /**
   * Convert a binary string to an Uint8Array.
   */
  private _binaryStringToBytes(binaryString: string): Uint8Array {
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  private _isDisposed = false;
  private _fileChanged = new Signal<Contents.IDrive, Contents.IChangedArgs>(
    this
  );
  private _storageName: string = DEFAULT_STORAGE_NAME;
  private _storageDrivers: string[] | null = null;
  private _storage: LocalForage;
  private _counters: LocalForage;
  private _checkpoints: LocalForage;
  private _localforage: typeof localforage;
  private _serverSettings: ServerConnection.ISettings;
}

/**
 * A namespace for `BrowserStorageDrive` statics.
 */
export namespace BrowserStorageDrive {
  export interface IOptions {
    /**
     * The localforage instance to use.
     */
    localforage: typeof localforage;
    /**
     * The name of the storage.
     */
    storageName?: string | null;
    /**
     * The storage drivers to use.
     */
    storageDrivers?: string[] | null;
    /**
     * The server settings to use when generating fallback download URLs.
     */
    serverSettings?: ServerConnection.ISettings;
  }
}

/**
 * A namespace for private data.
 */
namespace Private {
  /**
   * The content for an empty notebook.
   */
  export const EMPTY_NB: INotebookContent = {
    metadata: {
      orig_nbformat: 4
    },
    nbformat_minor: 5,
    nbformat: 4,
    cells: []
  };
}
