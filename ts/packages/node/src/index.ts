// @nhgw/node: the desktop host of the New Horizons Gateway.
export * from './hostApi';
export {
  runGateway,
  hostPlatform,
  refusingInstaller,
  readGatewayPid,
  STREAM_DATAGRAM_BYTES,
  FINDME_DATAGRAM_BYTES,
  type RunGatewayOptions,
  type NodeGatewayHost,
} from './host';
export { resolveRuntimePaths, defaultRoot, consoleStatusFile, legacyImportFile, type ResolvePathsOptions } from './paths';
export {
  importLegacyConfig,
  readLegacyImportRecord,
  legacyConfigCandidates,
  type LegacyImportRecord,
  type LegacyImportOptions,
} from './legacyImport';
export { GatewayWebServer, renderWebuiFile, flaskJson, publicConfig, WEBUI_ASSET_TYPES, type GatewayWebServerOptions } from './web/server';
export {
  readAsset,
  webAssetSources,
  webuiDir,
  tokensCssPath,
  setWebuiDir,
  seaModule,
  isSea,
  WEBUI_FILES,
  TOKENS_CSS,
  SEA_ASSET_PREFIX,
  type AssetName,
} from './assets';
export { GATEWAY_VERSION, PACKAGE_VERSION } from './version';
export { pyJsonDumps, CONFIG_FLOAT_KEYS, type PyJsonOptions } from './pyJson';
export * from './adapters';
