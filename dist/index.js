"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const constants_1 = require("./constants");
const init = ({ typescript: ts }) => {
    function create(info) {
        const logger = info.project.projectService.logger;
        const languageServiceHost = {};
        const languageServiceHostProxy = new Proxy(info.languageServiceHost, {
            get(target, key) {
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
        const createModuleResolver = (containingFile) => (moduleName, resolveModule) => {
            var _a;
            if (isYaml(moduleName)) {
                logger.info(`[typescript-plugin-yaml] resolve ${moduleName} in ${containingFile}`);
                if (isRelativePath(moduleName)) {
                    return {
                        extension: ts.Extension.Dts,
                        isExternalLibraryImport: false,
                        resolvedFileName: path_1.default.resolve(path_1.default.dirname(containingFile), moduleName),
                    };
                }
                const resolvedModule = resolveModule();
                if (!resolvedModule)
                    return;
                const baseUrl = info.project.getCompilerOptions().baseUrl;
                const match = '/index.ts';
                // An array of paths TypeScript searched for the module. All include .ts, .tsx, .d.ts, or .json extensions.
                const failedLocations = (_a = resolvedModule === null || resolvedModule === void 0 ? void 0 : resolvedModule.failedLookupLocations) !== null && _a !== void 0 ? _a : [];
                if (failedLocations.length) {
                    const locations = failedLocations.reduce((locations, location) => {
                        if ((baseUrl ? location.includes(baseUrl) : true) &&
                            location.endsWith(match)) {
                            locations = [
                                ...locations,
                                location.substring(0, location.lastIndexOf(match)),
                            ];
                        }
                        return locations;
                    }, []);
                    const resolvedLocation = locations.find((location) => fs_1.default.existsSync(location));
                    logger.info(`[typescript-plugin-yaml] resolved ${moduleName} in failedLocations: ${resolvedLocation}`);
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
            const _resolveModuleNameLiterals = info.languageServiceHost.resolveModuleNameLiterals.bind(info.languageServiceHost);
            languageServiceHost.resolveModuleNameLiterals = (moduleNames, containingFile, ...rest) => {
                const resolvedModules = _resolveModuleNameLiterals(moduleNames, containingFile, ...rest);
                const moduleResolver = createModuleResolver(containingFile);
                return moduleNames.map(({ text: moduleName }, index) => {
                    try {
                        const resolvedModule = moduleResolver(moduleName, () => resolvedModules[index]);
                        if (resolvedModule)
                            return { resolvedModule };
                    }
                    catch (e) {
                        return resolvedModules[index];
                    }
                    return resolvedModules[index];
                });
            };
            // TypeScript 4.x
        }
        else if (info.languageServiceHost.resolveModuleNames) {
            const _resolveModuleNames = info.languageServiceHost.resolveModuleNames.bind(info.languageServiceHost);
            languageServiceHost.resolveModuleNames = (moduleNames, containingFile, ...rest) => {
                const resolvedModules = _resolveModuleNames(moduleNames, containingFile, ...rest);
                const moduleResolver = createModuleResolver(containingFile);
                return moduleNames.map((moduleName, index) => {
                    try {
                        const resolvedModule = moduleResolver(moduleName, () => {
                            var _a;
                            return (_a = languageServiceHost.getResolvedModuleWithFailedLookupLocationsFromCache) === null || _a === void 0 ? void 0 : _a.call(languageServiceHost, moduleName, containingFile);
                        });
                        if (resolvedModule)
                            return resolvedModule;
                    }
                    catch (e) {
                        return resolvedModules[index];
                    }
                    return resolvedModules[index];
                });
            };
        }
        return languageService;
    }
    function getExternalFiles(proj) {
        return proj.getFileNames().filter((filename) => isYaml(filename));
    }
    return { create, getExternalFiles };
};
function isYaml(filepath) {
    return /\.ya?ml$/.test(filepath);
}
function isRelativePath(filepath) {
    return /^\.\.?(\/|$)/.test(filepath);
}
function createDts(filepath, logger) {
    try {
        const content = fs_1.default.readFileSync(filepath, 'utf8');
        if (!content.trim().length) {
            return `export { }`;
        }
        const doc = js_yaml_1.default.load(content);
        let dts = '';
        if (Object.prototype.toString.call(doc) === '[object Object]') {
            dts += Object.keys(doc)
                .filter((key) => constants_1.VALID_VARIABLE_NAME_REGEX.test(key))
                .map((key) => `export let ${key} = ${JSON.stringify(doc[key])}`)
                .join('\n');
        }
        dts += `\nexport default ${JSON.stringify(doc)}`;
        return dts;
    }
    catch (err) {
        logger.info(`[typescript-plugin-yaml] Create dts Error: ${err}`);
        return `export { }`;
    }
}
module.exports = init;
