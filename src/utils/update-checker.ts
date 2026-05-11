import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { get } from 'https';
import { USER_CACHE_DIR } from '../config/user-paths.js';
import { getPackageRoot } from '../config/user-paths.js';
import { logger } from './compact-logger.js';


const UPDATE_CHECK_CACHE_FILE = join(USER_CACHE_DIR, 'update-check.json');
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds

export interface UpdateInfo {
  lastCheck: number;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  packageName: string;
}

/**
 * Package info cache to avoid multiple file reads
 */
interface PackageInfo {
  name: string;
  version: string;
  binary: string;
}

let packageInfoCache: PackageInfo | null = null;

/**
 * Get package info from package.json (cached)
 */
function getPackageInfo(): PackageInfo {
  if (packageInfoCache) {
    return packageInfoCache;
  }

  try {
    const packageJsonPath = join(getPackageRoot(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    // Get binary name
    let binary = 'aicw-ai-mentions';
    if (packageJson.bin) {
      if (typeof packageJson.bin === 'object') {
        const binNames = Object.keys(packageJson.bin);
        // Filter out dev binaries and get the first one
        const mainBin = binNames.find(name => !name.includes('-dev'));
        binary = mainBin || 'aicw-ai-mentions';
      }
    }

    packageInfoCache = {
      name: packageJson.name || 'aicw-ai-mentions',
      version: packageJson.version || '0.0.0',
      binary
    };

    return packageInfoCache;
  } catch (error) {
    return {
      name: 'aicw-ai-mentions',
      version: '0.0.0',
      binary: 'aicw-ai-mentions'
    };
  }
}

/**
 * Get current package version from package.json
 */
export function getCurrentVersion(): string {
  return getPackageInfo().version;
}

/**
 * Get package name from package.json
 */
export function getPackageName(): string {
  return getPackageInfo().name;
}

/**
 * Get binary name from package.json
 */
export function getBinaryName(): string {
  return getPackageInfo().binary;
}

/**
 * Fetch latest version from npm registry
 */
function fetchLatestVersion(packageName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encodedPackageName = packageName.replace('/', '%2F');
    const url = `https://registry.npmjs.org/${encodedPackageName}`;

    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('Request timeout'));
    }, REQUEST_TIMEOUT_MS);

    const req = get(url, { headers: { 'User-Agent': 'aicw-update-checker' } }, (res) => {
      clearTimeout(timeout);

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const latestVersion = json['dist-tags']?.latest;
          if (latestVersion) {
            resolve(latestVersion);
          } else {
            reject(new Error('No latest version found'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Read cached update info
 */
export function getCachedUpdateInfo(): UpdateInfo | null {
  try {
    if (!existsSync(UPDATE_CHECK_CACHE_FILE)) {
      return null;
    }

    const data = readFileSync(UPDATE_CHECK_CACHE_FILE, 'utf-8');
    const info: UpdateInfo = JSON.parse(data);

    // Check if cache is still valid
    const now = Date.now();
    if (now - info.lastCheck > CACHE_DURATION_MS) {
      return null;
    }

    return info;
  } catch (error) {
    return null;
  }
}

/**
 * Save update info to cache
 */
export function cacheUpdateInfo(info: UpdateInfo): void {
  try {
    // Ensure cache directory exists
    if (!existsSync(USER_CACHE_DIR)) {
      mkdirSync(USER_CACHE_DIR, { recursive: true });
    }

    writeFileSync(UPDATE_CHECK_CACHE_FILE, JSON.stringify(info, null, 2), 'utf-8');
  } catch (error) {
    // Silently ignore write errors
  }
}

/**
 * Compare versions (simple semantic version comparison)
 */
function isNewerVersion(current: string, latest: string): boolean {
  // Remove leading 'v' if present
  const cleanCurrent = current.replace(/^v/, '');
  const cleanLatest = latest.replace(/^v/, '');

  const currentParts = cleanCurrent.split('.').map(Number);
  const latestParts = cleanLatest.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const curr = currentParts[i] || 0;
    const lat = latestParts[i] || 0;
    if (lat > curr) return true;
    if (lat < curr) return false;
  }

  return false;
}

/**
 * Check if running in CI or dev mode (skip update checks)
 */
function shouldSkipUpdateCheck(): boolean {
  // Skip in CI environments
  if (process.env.CI === 'true' || process.env.CONTINUOUS_INTEGRATION === 'true') {
    return true;
  }

  // Skip in dev mode
  if (process.env.AICW_DEV_MODE === 'true') {
    return true;
  }

  // Skip if explicitly disabled
  if (process.env.AICW_SKIP_UPDATE_CHECK === 'true') {
    return true;
  }

  return false;
}

/**
 * Check for updates (with caching and error handling)
 */
export async function checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateInfo | null> {
  try {
    // Skip in CI/dev mode
    if (!options.force && shouldSkipUpdateCheck()) {
      return null;
    }

    // Check cache first (unless forced)
    if (!options.force) {
      const cached = getCachedUpdateInfo();
      if (cached) {
        return cached;
      }
    }

    const currentVersion = getCurrentVersion();
    const packageName = getPackageName();

    // Fetch latest version from npm registry
    const latestVersion = await fetchLatestVersion(packageName);

    const updateAvailable = isNewerVersion(currentVersion, latestVersion);

    const info: UpdateInfo = {
      lastCheck: Date.now(),
      currentVersion,
      latestVersion,
      updateAvailable,
      packageName
    };

    // Cache the result
    cacheUpdateInfo(info);

    return info;
  } catch (error) {
    // Silently ignore errors - update checks should never break the CLI
    return null;
  }
}

/**
 * Silent background check for updates (for startup)
 */
export async function silentUpdateCheck(): Promise<void> {
  try {
    await checkForUpdates({ force: false });
  } catch (error) {
    logger.debug(`Error checking for updates: ${error}`);
    // Completely silent - no errors
  }
}

/**
 * Get update notification message (if available)
 */
export function getUpdateNotification(): string | null {
  const cached = getCachedUpdateInfo();
  if (!cached || !cached.updateAvailable) {
    return null;
  }

  // Skip notification if current version is 0.0.0
  // (indicates fresh install, dev mode, or error)
  if (cached.currentVersion === '0.0.0') {
    return null;
  }  

  const binaryName = getBinaryName();
  return `ℹ️  Update available: ${cached.currentVersion} → ${cached.latestVersion}\n   Update with: npm install -g ${cached.packageName}@latest`;
}
