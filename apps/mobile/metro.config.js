const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// react-native-audio-api loads react-native-worklets when it is installed; we use no worklets,
// and the worklets runtime crashed Hermes on device, so it is resolved to nothing here and
// left out of the native build (react-native.config.js).
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native-worklets" || moduleName.startsWith("react-native-worklets/")) {
    return { type: "empty" };
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
