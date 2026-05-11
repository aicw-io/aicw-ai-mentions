#!/usr/bin/env node

// Check Node.js version compatibility first
const nodeVersion = process.version;
const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);

if (major < 18) {
  console.error(`\x1b[31m❌ Node.js ${nodeVersion} is too old.\x1b[0m`);
  console.error('\x1b[33m💡 aicw-ai-mentions requires Node.js 18 or newer.\x1b[0m');
  console.error('\x1b[36m📥 Download the latest version from: https://nodejs.org/\x1b[0m\n');
  process.exit(1);
}

// No upper bound check - we support all modern Node.js versions

// Core Node.js imports - these don't depend on user-paths
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { appendFileSync, mkdirSync, existsSync } from 'fs';

// Load local env files from CWD if they exist - MUST happen before importing
// user-paths.js. Shell-provided environment variables still take precedence.
const dotenv = await import('dotenv');
for (const envFile of ['.env.local', '.env']) {
  const envPath = resolve(process.cwd(), envFile);
  if (!existsSync(envPath)) {
    continue;
  }
  dotenv.config({ path: envPath });
}

// Now safe to import modules that depend on user-paths.js
const { getUserDataDir } = await import('../dist/config/user-paths.js');

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set up error logging to file - intercept console.error to also write to log
const originalConsoleError = console.error;
console.error = function(...args) {
  // Call original console.error first
  originalConsoleError.apply(console, args);

  // Also log to file (but don't crash if it fails)
  try {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        // Handle Error objects specially to get stack traces
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');

    const logLine = `[${timestamp}] [ERROR] ${message}\n`;
    const logDir = getUserDataDir();
    const logFile = join(logDir, 'error.log');

    // Ensure directory exists
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Directory might already exist or we can't create it
    }

    appendFileSync(logFile, logLine);
  } catch {
    // Silently ignore file write errors - we don't want logging to cause crashes
  }
};

// Global crash protection with user-friendly messages
process.on('uncaughtException', (error) => {
  console.error('\n❌ Oops! Something went wrong.');
  console.error('💡 Try running the command again.');

  // Only show technical details if in debug mode
  if (process.env.AICW_DEBUG === 'true') {
    console.error('\nTechnical details:', error.message || error);
  } else {
    console.error('\nFor more details, set AICW_DEBUG=true and try again.');
  }

  console.error('\nIf this keeps happening, please report it:');
  console.error('📧 https://github.com/aicw-io/aicw-ai-mentions/issues\n');

  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Oops! Something went wrong.');
  console.error('💡 Details: ' + reason);

  process.exit(1);
});

// API keys are now loaded from encrypted storage via loadEnvFile() in run.js
// Environment variables like AICW_DATA_FOLDER can be set via .env file or shell

// Detect if running via npx (for welcome message)
const isNpx = process.env.npm_config_user_agent?.includes('npx') ||
              process.env.npm_execpath?.includes('npx') ||
              process.env.npm_lifecycle_event === 'npx';
if (isNpx) {
  process.env.AICW_RUNNING_VIA_NPX = 'true';
}

// Show development mode notice if applicable
if (process.env.AICW_DEV_MODE === 'true') {
  console.log('\x1b[33m[DEV MODE]\x1b[0m Auto-rebuild is active\n');
}

// Silent background check for update notices only. This never installs
// anything; it only warms a cache so the CLI can display manual update
// instructions on the next interactive run.
// Skip it for redirected/noninteractive commands so automation and package
// smoke tests never wait on registry/network behavior.
const shouldCheckForUpdates =
  process.env.AICW_SKIP_UPDATE_CHECK !== 'true' &&
  process.stdin.isTTY &&
  process.stdout.isTTY;
if (shouldCheckForUpdates) {
  const { silentUpdateCheck } = await import('../dist/utils/update-checker.js');
  silentUpdateCheck().catch(() => {
    // Completely silent - no errors
  });
}

// Import and run the main CLI
await import('../dist/run.js');
