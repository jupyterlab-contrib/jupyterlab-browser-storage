import { PathExt, URLExt } from '@jupyterlab/coreutils';

import { INotebookContent } from '@jupyterlab/nbformat';

import { Contents, ServerConnection } from '@jupyterlab/services';

import { ISignal, Signal } from '@lumino/signaling';

import type localforage from 'localforage';

import { FILE, MIME } from './file';

export const DRIVE_NAME = 'BrowserStorage';

/**
 * The name of the local storage.
 * TODO: make this configurable in the settings.
 */
const DEFAULT_STORAGE_NAME = 'JupyterLab Browser Storage';

/**
 * The number of checkpoints to save.
 */
const N_CHECKPOINTS = 5;

export class BrowserStorageDrive implements Contents.IDrive {
  constructor(options: BrowserStorageDrive.IOptions) {
    this._localforage = options.localforage;
    this._storageName = options.storageName || DEFAULT_STORAGE_NAME;
    this._storageDrivers = options.storageDrivers || null;
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

  get serverSettings(): ServerConnection.ISettings {
    return ServerConnection.makeSettings();
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
  async get(
    path: string,
    options?: Contents.IFetchOptions
  ): Promise<Contents.IModel> {
    // remove leading slash
    path = decodeURIComponent(path.replace(/^\//, ''));

    if (path === '') {
      return await this._getFolder(path);
    }

    const storage = this._storage;
    const item = await storage.getItem(path);
    const model = item as Contents.IModel;

    // TODO: handle this?
    // if (!model) {
    //   return null;
    // }

    if (!options?.content) {
      return {
        size: 0,
        ...model,
        content: null
      };
    }

    // for directories, find all files with the path as the prefix
    if (model.type === 'directory') {
      const contentMap = new Map<string, Contents.IModel>();
      await storage.iterate<Contents.IModel, void>((file, key) => {
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

  async getDownloadUrl(path: string): Promise<string> {
    throw new Error('Method not implemented.');
  }

  /**
   * Create a new untitled file or directory in the specified directory path.
   *
   * @param options: The options used to create the file.
   *
   * @returns A promise which resolves with the created file content when the file is created.
   */
  async newUntitled(
    options?: Contents.ICreateOptions
  ): Promise<Contents.IModel> {
    const path = options?.path ?? '';
    const type = options?.type ?? 'notebook';
    const created = new Date().toISOString();

    let dirname = PathExt.dirname(path);
    const basename = PathExt.basename(path);
    const extname = PathExt.extname(path);
    const item = await this.get(dirname);

    // handle the case of "Save As", where the path points to the new file
    // to create, e.g. subfolder/example-copy.ipynb
    let name = '';
    if (path && !extname && item) {
      // directory
      dirname = `${path}/`;
      name = '';
    } else if (dirname && basename) {
      // file in a subfolder
      dirname = `${dirname}/`;
      name = basename;
    } else {
      // file at the top level
      dirname = '';
      name = path;
    }

    let file: Contents.IModel;
    switch (type) {
      case 'directory': {
        const counter = await this._incrementCounter('directory');
        name = `Untitled Folder${counter || ''}`;
        file = {
          name,
          path: `${dirname}${name}`,
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
          path: `${dirname}${name}`,
          last_modified: created,
          created,
          format: 'json',
          mimetype: MIME.JSON,
          content: Private.EMPTY_NB,
          size: JSON.stringify(Private.EMPTY_NB).length,
          writable: true,
          type: 'notebook'
        };
        break;
      }
      default: {
        const ext = options?.ext ?? '.txt';
        const counter = await this._incrementCounter('file');
        const mimetype = FILE.getType(ext) || MIME.OCTET_STREAM;

        let format: Contents.FileFormat;
        if (FILE.hasFormat(ext, 'text') || mimetype.indexOf('text') !== -1) {
          format = 'text';
        } else if (ext.indexOf('json') !== -1 || ext.indexOf('ipynb') !== -1) {
          format = 'json';
        } else {
          format = 'base64';
        }

        name = name || `untitled${counter || ''}${ext}`;
        file = {
          name,
          path: `${dirname}${name}`,
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
  }

  /**
   * Rename a file or directory.
   *
   * @param oldPath - The original file path.
   * @param newPath - The new file path.
   *
   * @returns A promise which resolves with the new file content model when the file is renamed.
   */
  async rename(oldPath: string, newPath: string): Promise<Contents.IModel> {
    const path = decodeURIComponent(oldPath);
    const file = await this.get(path, { content: true });
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
      let child: Contents.IModel;
      for (child of file.content) {
        await this.rename(
          URLExt.join(oldPath, child.name),
          URLExt.join(oldPath, child.name)
        );
      }
    }

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
    options?: Partial<Contents.IModel>
  ): Promise<Contents.IModel> {
    path = decodeURIComponent(path);

    // process the file if coming from an upload
    const ext = PathExt.extname(options?.name ?? '');
    const chunk = options?.chunk;

    // retrieve the content if it is a later chunk or the last one
    // the new content will then be appended to the existing one
    const chunked = chunk ? chunk > 1 || chunk === -1 : false;
    let item: Contents.IModel | null = await this.get(path, {
      content: chunked
    });

    if (!item) {
      item = await this.newUntitled({ path, ext, type: 'file' });
    }

    if (!item) {
      throw Error('Could not create the file');
    }

    // keep a reference to the original content
    const originalContent = item.content;

    const modified = new Date().toISOString();
    // override with the new values
    item = {
      ...item,
      ...options,
      last_modified: modified
    };

    if (options?.content && options?.format === 'base64') {
      const lastChunk = chunk ? chunk === -1 : true;

      if (ext === '.ipynb') {
        const content = this._handleChunk(
          options.content,
          originalContent,
          chunked
        );
        item = {
          ...item,
          content: lastChunk ? JSON.parse(content) : content,
          format: 'json',
          type: 'notebook',
          size: content.length
        };
      } else if (FILE.hasFormat(ext, 'json')) {
        const content = this._handleChunk(
          options.content,
          originalContent,
          chunked
        );
        item = {
          ...item,
          content: lastChunk ? JSON.parse(content) : content,
          format: 'json',
          type: 'file',
          size: content.length
        };
      } else if (FILE.hasFormat(ext, 'text')) {
        const content = this._handleChunk(
          options.content,
          originalContent,
          chunked
        );
        item = {
          ...item,
          content,
          format: 'text',
          type: 'file',
          size: content.length
        };
      } else {
        const content = options.content;
        item = {
          ...item,
          content,
          size: atob(content).length
        };
      }
    }

    await this._storage.setItem(path, item);
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
  async copy(path: string, toLocalDir: string): Promise<Contents.IModel> {
    let name = PathExt.basename(path);
    toLocalDir = toLocalDir === '' ? '' : `${toLocalDir.slice(1)}/`;
    // TODO: better handle naming collisions with existing files
    while (await this.get(`${toLocalDir}${name}`, { content: true })) {
      const ext = PathExt.extname(name);
      const base = name.replace(ext, '');
      name = `${base} (copy)${ext}`;
    }
    const toPath = `${toLocalDir}${name}`;
    let item = await this.get(path, { content: true });
    if (!item) {
      throw Error(`Could not find file with path ${path}`);
    }
    item = {
      ...item,
      name,
      path: toPath
    };
    await this._storage.setItem(toPath, item);
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
    const item = await this.get(path, { content: true });
    if (!item) {
      throw Error(`Could not find file with path ${path}`);
    }
    const copies = (
      ((await checkpoints.getItem(path)) as Contents.IModel[]) ?? []
    ).filter(Boolean);
    copies.push(item);
    // keep only a certain amount of checkpoints per file
    if (copies.length > N_CHECKPOINTS) {
      copies.splice(0, copies.length - N_CHECKPOINTS);
    }
    await checkpoints.setItem(path, copies);
    const id = `${copies.length - 1}`;
    return { id, last_modified: (item as Contents.IModel).last_modified };
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
    const copies: Contents.IModel[] =
      (await this._checkpoints.getItem(path)) || [];
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
    const copies = ((await this._checkpoints.getItem(path)) ||
      []) as Contents.IModel[];
    const id = parseInt(checkpointID);
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
    const copies = ((await this._checkpoints.getItem(path)) ||
      []) as Contents.IModel[];
    const id = parseInt(checkpointID);
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
    model: Contents.IModel,
    id: number
  ): Contents.ICheckpointModel {
    return { id: id.toString(), last_modified: model.last_modified };
  }

  /**
   * Retrieve the contents for this path from the local storage
   * @param path - The contents path to retrieve
   *
   * @returns A promise which resolves with a Map of contents, keyed by local file name
   */
  private async _getFolder(path: string): Promise<Contents.IModel> {
    const content = new Map<string, Contents.IModel>();
    const storage = this._storage;
    await storage.iterate<Contents.IModel, void>((file, key) => {
      if (key.includes('/')) {
        return;
      }
      content.set(file.path, file);
    });

    // TODO: handle this?
    // if (path && content.size === 0) {
    //   return null;
    // }

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
   * Handle a chunk of a file.
   * Decode and unescape a base64-encoded string.
   * @param content the content to process
   *
   * @returns the decoded string, appended to the original content if chunked
   * /
   */
  private _handleChunk(
    newContent: string,
    originalContent: string,
    chunked?: boolean
  ): string {
    const escaped = decodeURIComponent(escape(atob(newContent)));
    const content = chunked ? originalContent + escaped : escaped;
    return content;
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
    storageName?: string;
    /**
     * The storage drivers to use.
     */
    storageDrivers?: string[] | null;
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
    nbformat_minor: 4,
    nbformat: 4,
    cells: []
  };
}
