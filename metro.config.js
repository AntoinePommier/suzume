const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push("epub", "zip", "sqlite", "db");

module.exports = config;
