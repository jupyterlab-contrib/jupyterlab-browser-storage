import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import {
  createToolbarFactory,
  setToolbar,
  IToolbarWidgetRegistry
} from '@jupyterlab/apputils';

import {
  IFileBrowserFactory,
  FileBrowser,
  Uploader
} from '@jupyterlab/filebrowser';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { listIcon, IScore, FilenameSearcher } from '@jupyterlab/ui-components';

import localforage from 'localforage';

import { DRIVE_NAME, BrowserStorageDrive } from './drive';
import { FILE, IFileTypeDefinition } from './file';

/**
 * The class name added to the filebrowser filterbox node.
 */
const FILTERBOX_CLASS = 'jp-FileBrowser-filterBox';

/**
 * Initialization data for the jupyterlab-browser-storage extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-storage:plugin',
  requires: [IFileBrowserFactory, ITranslator],
  optional: [ISettingRegistry, IToolbarWidgetRegistry],
  autoStart: true,
  activate: async (
    app: JupyterFrontEnd,
    browser: IFileBrowserFactory,
    translator: ITranslator,
    settingRegistry: ISettingRegistry | null,
    toolbarRegistry: IToolbarWidgetRegistry | null
  ) => {
    const { serviceManager } = app;
    const { createFileBrowser } = browser;

    const trans = translator.load('jupyterlab-filesystem-access');

    // Create the toolbar factory first to register the schema transformer.
    // This must happen before settingRegistry.load() because the schema
    // has "jupyter.lab.transform": true.
    let toolbarFactory: ReturnType<typeof createToolbarFactory> | null = null;
    if (toolbarRegistry && settingRegistry) {
      toolbarFactory = createToolbarFactory(
        toolbarRegistry,
        settingRegistry,
        DRIVE_NAME,
        plugin.id,
        translator ?? nullTranslator
      );
    }

    let settings: ISettingRegistry.ISettings | null = null;
    if (settingRegistry) {
      try {
        settings = await settingRegistry.load(plugin.id);
      } catch (e) {
        console.warn('jupyterlab-browser-storage: Failed to load settings.', e);
      }
    }

    const drive = new BrowserStorageDrive({ localforage });

    serviceManager.contents.addDrive(drive);

    const widget = createFileBrowser('jp-filesystem-browser', {
      driveName: drive.name
    });

    const onSettingsChanged = (settings: ISettingRegistry.ISettings) => {
      const storageName =
        (settings.get('storageName').composite as string) || undefined;
      if (storageName && storageName !== drive.storageName) {
        drive.storageName = storageName;
        widget.model.refresh();
      }

      const additionalFileTypes =
        (settings.get('additionalFileTypes').composite as unknown as IFileTypeDefinition[]) || [];
      FILE.setAdditionalFileTypes(additionalFileTypes);
    };

    if (settings) {
      settings.changed.connect(onSettingsChanged);
      onSettingsChanged(settings);
    }
    widget.title.caption = trans.__('Browser Storage');
    widget.title.icon = listIcon;

    const toolbar = widget.toolbar;
    toolbar.id = 'jp-browserstorage-toolbar';

    if (toolbarFactory && toolbarRegistry && settingRegistry) {
      setToolbar(toolbar, toolbarFactory, toolbar);

      toolbarRegistry.addFactory(
        DRIVE_NAME,
        'uploader',
        (browser: FileBrowser) =>
          new Uploader({
            model: widget.model,
            translator
          })
      );

      toolbarRegistry.addFactory(
        DRIVE_NAME,
        'filename-searcher',
        (browser: FileBrowser) => {
          const searcher = FilenameSearcher({
            updateFilter: (
              filterFn: (item: string) => Partial<IScore> | null,
              query?: string
            ) => {
              widget.model.setFilter(value => {
                return filterFn(value.name.toLowerCase());
              });
            },
            useFuzzyFilter: true,
            placeholder: trans.__('Filter files by name'),
            forceRefresh: false
          });
          searcher.addClass(FILTERBOX_CLASS);
          return searcher;
        }
      );
    }

    app.shell.add(widget, 'left', { type: 'BrowserStorage' });
  }
};

export { BrowserStorageDrive, DRIVE_NAME } from './drive';
export { FILE, MIME, IFileTypeDefinition } from './file';

export default plugin;
