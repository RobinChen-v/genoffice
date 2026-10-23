const fs = require('fs');

const originalRmdirSync = fs.rmdirSync;
fs.rmdirSync = function rmdirSyncCompat(targetPath, options) {
  if (options && typeof options === 'object' && options.recursive) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (e) {
      return;
    }
    return;
  }
  return originalRmdirSync.apply(fs, arguments);
};