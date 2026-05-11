import { realpathSync } from 'fs';
import { getPackageRoot } from '../config/user-paths.js';
import { getPackageName, getCurrentVersion, checkForUpdates } from '../utils/update-checker.js';
import { logger } from './compact-logger.js';

/**
 * Check if package is installed via npm link (development mode)
 */
export function isNpmLink(): boolean {
  try {
    const packageRoot = getPackageRoot();
    const realPath = realpathSync(packageRoot);
    // If realPath differs from packageRoot, it's a symlink (npm link)
    return realPath !== packageRoot;
  } catch {
    return false;
  }
}

export async function performUpdate(): Promise<boolean> {
  const packageName = getPackageName();
  const currentVersion = getCurrentVersion();

  logger.info('🔍 Checking for updates...\n');

  const updateInfo = await checkForUpdates({ force: true });

  if (!updateInfo) {
    logger.info('❌ Unable to check for updates. Please try again later.');
    return false;
  }

  if (!updateInfo.updateAvailable) {
    logger.info(`✅ You're already running the latest version (${currentVersion})`);
    return true;
  }

  logger.info(`📦 Current version: ${currentVersion}`);
  logger.info(`📦 Latest version:  ${updateInfo.latestVersion}\n`);

  if (isNpmLink()) {
    logger.info('⚠️  Warning: It looks like you\'re using npm link (development mode).');
    logger.info('   To update, navigate to your development directory and run:');
    logger.info('   git pull && npm install && npm run build\n');
    return true;
  }

  logger.info('Update manually with:');
  logger.info(`   npm install -g ${packageName}@latest\n`);
  logger.info('If you run with npx, use:');
  logger.info(`   npx ${packageName}@latest\n`);
  return true;
}

/**
 * Show current version
 */
export function showVersion(): void {
  const currentVersion = getCurrentVersion();
  const packageName = getPackageName();
  const installMethod = isNpmLink() ? 'npm-link (development mode)' : 'installed';

  logger.info(`\n📦 ${packageName}`);
  logger.info(`   Version: ${currentVersion}`);
  logger.info(`   Install method: ${installMethod}\n`);
}
