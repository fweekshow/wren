const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// jose's package exports pick the Node build when "import" is an active
// condition, and that build imports zlib. The browser build is the one
// Privy uses on device.
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'jose') {
    return context.resolveRequest(
      { ...context, unstable_conditionNames: ['browser'] },
      moduleName,
      platform,
    );
  }
  if (resolveRequest) {
    return resolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
