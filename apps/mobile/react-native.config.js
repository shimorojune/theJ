// Native modules pulled in by other packages that the app never uses (see metro.config.js).
module.exports = {
  dependencies: {
    "react-native-worklets": { platforms: { android: null, ios: null } },
    "react-native-reanimated": { platforms: { android: null, ios: null } },
  },
};
