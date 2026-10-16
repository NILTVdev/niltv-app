const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

/**
 * obscenity (the comment filter, shared via @niltv/types/comment-filter)
 * ships a CommonJS build plus an ESM wrapper, `index.mjs`, that does
 * `import mod from "./index.js"; export const DataSet = mod.DataSet`. Metro's
 * default-import interop returns `undefined` for a CJS module flagged
 * `__esModule`, so on web (and the static-render pass of `expo export`) that
 * wrapper throws "Cannot read properties of undefined (reading 'DataSet')".
 * Native already resolves the CJS build through the package's `react-native`
 * export condition. Pin every platform to it so web matches.
 */
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "obscenity") {
    return { type: "sourceFile", filePath: require.resolve("obscenity") };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
