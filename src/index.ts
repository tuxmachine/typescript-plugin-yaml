import path from 'path';
import fs from 'fs';
import jsYaml from 'js-yaml';
import { VALID_VARIABLE_NAME_REGEX } from './constants';
import type tsModule from 'typescript/lib/tsserverlibrary';

const init: tsModule.server.PluginModuleFactory = ({ typescript: ts }) => {
  function create(
    info: tsModule.server.PluginCreateInfo,
  ): tsModule.LanguageService {
    const logger = info.project.projectService.logger;
    const languageServiceHost = {} as Partial<tsModule.LanguageServiceHost>;

    const languageServiceHostProxy = new Proxy(info.languageServiceHost, {
      get(target, key: keyof tsModule.LanguageServiceHost) {
        return languageServiceHost[key]
          ? languageServiceHost[key]
          : target[key];
      },
    });

    const languageService = ts.createLanguageService(languageServiceHostProxy);

    languageServiceHost.getScriptKind = (filename) => {
      if (!info.languageServiceHost.getScriptKind) {
        return ts.ScriptKind.Unknown;
      }

      if (isYaml(filename)) {
        return ts.ScriptKind.TS;
      }

      return info.languageServiceHost.getScriptKind(filename);
    };

    languageServiceHost.getScriptSnapshot = (filename) => {
      if (isYaml(filename)) {
        return ts.ScriptSnapshot.fromString(createDts(filename, logger));
      }
      return info.languageServiceHost.getScriptSnapshot(filename);
    };

    const createModuleResolver =
      (containingFile: string) =>
      (
        moduleName: string,
        resolveModule: () =>
          | tsModule.ResolvedModuleWithFailedLookupLocations
          | undefined,
      ): tsModule.ResolvedModuleFull | undefined => {
        if (isYaml(moduleName)) {
          logger.info(
            `[typescript-plugin-yaml] resolve ${moduleName} in ${containingFile}`,
          );

          if (isRelativePath(moduleName)) {
            return {
              extension: ts.Extension.Dts,
              isExternalLibraryImport: false,
              resolvedFileName: path.resolve(
                path.dirname(containingFile),
                moduleName,
              ),
            };
          }

          const resolvedModule = resolveModule();
          if (!resolvedModule) return;

          const baseUrl = info.project.getCompilerOptions().baseUrl;
          const match = '/index.ts';

          // An array of paths TypeScript searched for the module. All include .ts, .tsx, .d.ts, or .json extensions.
          const failedLocations =
            ((resolvedModule as any)?.failedLookupLocations as string[]) ?? [];

          if (failedLocations.length) {
            const locations = failedLocations.reduce<string[]>(
              (locations, location) => {
                if (
                  (baseUrl ? location.includes(baseUrl) : true) &&
                  location.endsWith(match)
                ) {
                  locations = [
                    ...locations,
                    location.substring(0, location.lastIndexOf(match)),
                  ];
                }
                return locations;
              },
              [],
            );

            const resolvedLocation = locations.find((location) =>
              fs.existsSync(location),
            );

            logger.info(
              `[typescript-plugin-yaml] resolved ${moduleName} in failedLocations: ${resolvedLocation}`,
            );

            if (resolvedLocation) {
              return {
                extension: ts.Extension.Dts,
                isExternalLibraryImport: false,
                resolvedFileName: resolvedLocation,
              };
            }
          }
        }
      };

    // TypeScript 5.x
    if (info.languageServiceHost.resolveModuleNameLiterals) {
      const _resolveModuleNameLiterals =
        info.languageServiceHost.resolveModuleNameLiterals.bind(
          info.languageServiceHost,
        );
      languageServiceHost.resolveModuleNameLiterals = (
        moduleNames,
        containingFile,
        ...rest
      ) => {
        const resolvedModules = _resolveModuleNameLiterals(
          moduleNames,
          containingFile,
          ...rest,
        );

        const moduleResolver = createModuleResolver(containingFile);

        return moduleNames.map(({ text: moduleName }, index) => {
          try {
            const resolvedModule = moduleResolver(
              moduleName,
              () => resolvedModules[index],
            );
            if (resolvedModule) return { resolvedModule };
          } catch (e) {
            return resolvedModules[index];
          }
          return resolvedModules[index];
        });
      };
      // TypeScript 4.x
    } else if (info.languageServiceHost.resolveModuleNames) {
      const _resolveModuleNames =
        info.languageServiceHost.resolveModuleNames.bind(
          info.languageServiceHost,
        );
      languageServiceHost.resolveModuleNames = (
        moduleNames,
        containingFile,
        ...rest
      ) => {
        const resolvedModules = _resolveModuleNames(
          moduleNames,
          containingFile,
          ...rest,
        );

        const moduleResolver = createModuleResolver(containingFile);

        return moduleNames.map((moduleName, index) => {
          try {
            const resolvedModule = moduleResolver(moduleName, () =>
              languageServiceHost.getResolvedModuleWithFailedLookupLocationsFromCache?.(
                moduleName,
                containingFile,
              ),
            );
            if (resolvedModule) return resolvedModule;
          } catch (e) {
            return resolvedModules[index];
          }
          return resolvedModules[index];
        });
      };
    }

    return languageService;
  }

  function getExternalFiles(proj: tsModule.server.ConfiguredProject) {
    return proj.getFileNames().filter((filename) => isYaml(filename));
  }

  return { create, getExternalFiles };
};

function isYaml(filepath: string) {
  return /\.ya?ml$/.test(filepath);
}

function isRelativePath(filepath: string) {
  return /^\.\.?(\/|$)/.test(filepath);
}

function createDts(filepath: string, logger: tsModule.server.Logger) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    if (!content.trim().length) {
      return `export { }`;
    }

    const doc = jsYaml.load(content) as any;
    let dts = '';

    if (Object.prototype.toString.call(doc) === '[object Object]') {
      dts += Object.keys(doc)
        .filter((key) => VALID_VARIABLE_NAME_REGEX.test(key))
        .map((key) => `export let ${key} = ${JSON.stringify(doc[key])}`)
        .join('\n');
    }

    dts += `\nexport default ${JSON.stringify(doc)}`;

    return dts;
  } catch (err) {
    logger.info(`[typescript-plugin-yaml] Create dts Error: ${err}`);
    return `export { }`;
  }
}

export = init;
