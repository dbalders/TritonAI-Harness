const { prepareMobileNative } = require("./prepare-mobile-native.cjs");
function prepareNightlyMobileNative(options) {
  return prepareMobileNative({ ...options, variant: "preview" });
}
module.exports = { prepareNightlyMobileNative };
if (require.main === module) {
  const [root, tag, sourceSha, generatorSha] = process.argv.slice(2);
  console.log(prepareNightlyMobileNative({ root, tag, sourceSha, generatorSha }));
}
