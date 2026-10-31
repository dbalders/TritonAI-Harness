"use strict";

// Add the Harness logo catalog and actool phase to ExpoWidgetsTarget.
// Register BEFORE expo-widgets: Expo runs same-type mods in reverse order, so our
// mods must run after its target creation and destructive directory regeneration.

const path = require("path");
const fs = require("fs");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const { addWidgetAssetCatalog } = require("./lib/addWidgetAssetCatalog.cjs");

const TARGET_NAME = "ExpoWidgetsTarget";
const CATALOG_NAME = "Assets.xcassets";
const IMAGE_SET = "HarnessMark.imageset";
const IMAGE_NAME = "HarnessMark.png";

const CATALOG_CONTENTS = JSON.stringify({ info: { author: "expo", version: 1 } }, null, 2) + "\n";
const IMAGE_SET_CONTENTS =
  JSON.stringify(
    {
      images: [{ idiom: "universal", filename: IMAGE_NAME }],
      info: { author: "expo", version: 1 },
    },
    null,
    2,
  ) + "\n";

function withAssetFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const source = path.resolve(
        cfg.modRequest.projectRoot,
        "../../assets/prod/tritonai-logo.png",
      );
      const catalogDir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME, CATALOG_NAME);
      const imageSetDir = path.join(catalogDir, IMAGE_SET);
      fs.mkdirSync(imageSetDir, { recursive: true });
      fs.writeFileSync(path.join(catalogDir, "Contents.json"), CATALOG_CONTENTS);
      fs.writeFileSync(path.join(imageSetDir, "Contents.json"), IMAGE_SET_CONTENTS);
      fs.copyFileSync(source, path.join(imageSetDir, IMAGE_NAME));
      return cfg;
    },
  ]);
}

function withAssetWiring(config) {
  return withXcodeProject(config, (cfg) => {
    addWidgetAssetCatalog(cfg.modResults, { targetName: TARGET_NAME });
    return cfg;
  });
}

module.exports = function withWidgetLogoAsset(config) {
  return withAssetWiring(withAssetFiles(config));
};
