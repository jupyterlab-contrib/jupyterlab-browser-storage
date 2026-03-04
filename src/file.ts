import { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { PageConfig } from '@jupyterlab/coreutils';

import mime from 'mime';

/**
 * Commonly-used mimetypes
 */
export namespace MIME {
  export const JSON = 'application/json';
  export const PLAIN_TEXT = 'text/plain';
  export const OCTET_STREAM = 'octet/stream';
}

/**
 * The definition of a file type for user settings.
 */
export interface IFileTypeDefinition {
  /**
   * The name of the file type.
   */
  name: string;
  /**
   * The file extensions (e.g. ['.py', '.pyw']).
   */
  extensions: string[];
  /**
   * The MIME types associated with this file type.
   */
  mimeTypes?: string[];
  /**
   * The file format: 'text', 'json', or 'base64'.
   */
  fileFormat: 'text' | 'json' | 'base64';
}

/**
 * A namespace for file constructs.
 */
export namespace FILE {
  /**
   * Default file types with their associated formats.
   *
   * These provide sensible defaults so that `hasFormat` and `getType`
   * work out of the box without relying on PageConfig (which is only
   * populated in JupyterLite).
   */
  const DEFAULT_TYPES: Record<string, Partial<IRenderMime.IFileType>> = {
    text: {
      extensions: [
        '.txt',
        '.csv',
        '.tsv',
        '.md',
        '.markdown',
        '.py',
        '.pyw',
        '.r',
        '.jl',
        '.lua',
        '.js',
        '.ts',
        '.jsx',
        '.tsx',
        '.mjs',
        '.cjs',
        '.css',
        '.less',
        '.scss',
        '.sass',
        '.html',
        '.htm',
        '.xml',
        '.svg',
        '.yml',
        '.yaml',
        '.toml',
        '.ini',
        '.cfg',
        '.sh',
        '.bash',
        '.zsh',
        '.c',
        '.cpp',
        '.h',
        '.hpp',
        '.cxx',
        '.java',
        '.scala',
        '.kt',
        '.go',
        '.rs',
        '.rb',
        '.php',
        '.pl',
        '.pm',
        '.swift',
        '.cs',
        '.vb',
        '.sql',
        '.tex',
        '.bib',
        '.log',
        '.diff',
        '.patch'
      ],
      fileFormat: 'text'
    },
    json: {
      extensions: ['.json', '.geojson', '.topojson'],
      mimeTypes: ['application/json'],
      fileFormat: 'json'
    },
    base64: {
      extensions: [
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.bmp',
        '.ico',
        '.tiff',
        '.tif',
        '.webp',
        '.pdf',
        '.zip',
        '.gz',
        '.tar',
        '.bz2',
        '.xz',
        '.7z',
        '.whl',
        '.wasm',
        '.mp3',
        '.mp4',
        '.wav',
        '.ogg',
        '.webm',
        '.ttf',
        '.otf',
        '.woff',
        '.woff2'
      ],
      fileFormat: 'base64'
    }
  };

  /**
   * Build-time configured file types from PageConfig (e.g. from JupyterLite).
   */
  const PAGE_CONFIG_TYPES: Record<
    string,
    Partial<IRenderMime.IFileType>
  > = JSON.parse(PageConfig.getOption('fileTypes') || '{}');

  /**
   * All active file types. Starts with defaults merged with PageConfig types,
   * and can be extended via user settings.
   */
  let TYPES: Record<string, Partial<IRenderMime.IFileType>> = {
    ...DEFAULT_TYPES,
    ...PAGE_CONFIG_TYPES
  };

  /**
   * Set additional file types from user settings.
   * These are merged on top of the defaults and PageConfig types.
   */
  export function setAdditionalFileTypes(
    fileTypes: IFileTypeDefinition[]
  ): void {
    const additional: Record<string, Partial<IRenderMime.IFileType>> = {};
    for (const ft of fileTypes) {
      if (ft.name) {
        additional[ft.name] = {
          extensions: ft.extensions,
          mimeTypes: ft.mimeTypes,
          fileFormat: ft.fileFormat
        };
      }
    }
    TYPES = { ...DEFAULT_TYPES, ...PAGE_CONFIG_TYPES, ...additional };
  }

  /**
   * Get a mimetype (or fallback).
   */
  export function getType(
    ext: string,
    defaultType: string | null = null
  ): string {
    ext = ext.toLowerCase();
    for (const fileType of Object.values(TYPES)) {
      for (const fileExt of fileType.extensions || []) {
        if (
          fileExt === ext &&
          fileType.mimeTypes &&
          fileType.mimeTypes.length
        ) {
          return fileType.mimeTypes[0];
        }
      }
    }

    return mime.getType(ext) || defaultType || MIME.OCTET_STREAM;
  }

  /**
   * Determine whether the given extension matches a given fileFormat.
   */
  export function hasFormat(
    ext: string,
    fileFormat: 'base64' | 'text' | 'json'
  ): boolean {
    ext = ext.toLowerCase();
    for (const fileType of Object.values(TYPES)) {
      if (fileType.fileFormat !== fileFormat) {
        continue;
      }
      for (const fileExt of fileType.extensions || []) {
        if (fileExt === ext) {
          return true;
        }
      }
    }
    return false;
  }
}
