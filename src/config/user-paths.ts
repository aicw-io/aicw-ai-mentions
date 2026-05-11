import path, { dirname } from 'path';
import { homedir, platform } from 'os';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'fs-extra';
const { copySync } = pkg;
import { AGGREGATED_DIR_NAME, USE_PACKAGE_CONFIG } from './constants.js';
import { logger } from '../utils/compact-logger.js';
import { validatePathIsSafe } from '../utils/misc-utils.js';
import { explainFileSystemError } from '../utils/misc-utils.js';

// Define __dirname for ES modules FIRST - needed by getPackageRoot()
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File size constraints
export const MIN_VALID_ANSWER_SIZE = 200; // Minimum size in bytes for a valid answer
export const MIN_VALID_OUTPUT_DATA_SIZE = 200; // Minimum size in bytes for PROMPT.md, COMPILED.js, data.js files

// User data directory (delegate to user-paths for consistency)
// User data subdirectories
export const USER_DATA_DIR = getUserDataDir();
export const USER_PROJECTS_DIR = path.join(USER_DATA_DIR, 'projects');
export const USER_REPORTS_DIR = path.join(USER_DATA_DIR, 'reports');
export const USER_CACHE_DIR = path.join(USER_DATA_DIR, 'cache');
export const USER_CONFIG_CREDENTIALS_DIR = path.join(USER_DATA_DIR, 'config', '.credentials');
export const USER_CONFIG_CREDENTIALS_FILE = path.join(USER_CONFIG_CREDENTIALS_DIR, 'credentials.json');
export const USER_LOGS_DIR = path.join(USER_DATA_DIR, 'logs');
export const USER_INVALID_OUTPUTS_DIR = path.join(USER_LOGS_DIR, 'invalid');


// Default data directory for user config files (defined here to avoid circular dependency)

// dynamic path resolution functions that respect USE_PACKAGE_CONFIG
export const USER_CONFIG_PROMPTS_DIR: string = path.join(getPackageConfigDataDir(), 'prompts');
export const USER_CONFIG_TEMPLATES_DIR: string = path.join(getPackageConfigDataDir(), 'templates');
// ai models
export const USER_MODELS_JSON_FILE: string = path.join(getPackageConfigDataDir(), 'models', 'ai_models.json');
// presets with ai models
export const USER_AI_PRESETS_DIR: string = path.join(getPackageConfigDataDir(), 'models', 'ai_presets');
export const USER_QUESTION_TEMPLATES_DIR: string = path.join(getPackageConfigDataDir(), 'templates', 'questions');
export const USER_SYSTEM_PROMPT_FILE_PATH: string = path.join(getPackageConfigDataDir(), 'prompts', 'answers', 'system-prompt.md');
export const USER_PIPELINES_JSON_FILE: string = path.join(getPackageConfigDataDir(), 'pipelines.json');
//============

export const DEFAULT_INDEX_FILE = 'index.html';

const QUESTION_FILE_NAME = 'question.md';
const QUESTIONS_FILE_NAME = 'questions.md';

// Get the base user data directory based on platform
export function getUserDataDir(): string {
  // If AICW_DATA_FOLDER is set, use it directly as the complete path
  // Supports relative paths (resolved from cwd) and absolute paths
  // Example: AICW_DATA_FOLDER=../aicw-data/aicw.io/data or AICW_DATA_FOLDER=/path/to/data
  if (process.env.AICW_DATA_FOLDER) {
    const customPath = process.env.AICW_DATA_FOLDER;
    // Always use path.resolve() to normalize the path (handles both absolute and relative, removes ..)
    const resolvedPath = path.resolve(customPath);

    // Fail-fast: data folder MUST exist
    if (!existsSync(resolvedPath)) {
      console.error(`\n\x1b[31mFATAL ERROR: AICW_DATA_FOLDER path does not exist!\x1b[0m`);
      console.error(`\x1b[33mExpected path: ${resolvedPath}\x1b[0m`);
      console.error(`\x1b[36mPlease create this directory or update AICW_DATA_FOLDER.\x1b[0m\n`);
      process.exit(1);
    }

    if (process.env.AICW_DEV_MODE === 'true') {
      console.log(`AICW_DATA_FOLDER: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  // Platform-specific defaults (no user subfolder, just ~/...Support/aicw/)
  const homeDir = homedir();
  const plat = platform();
  let outputPath: string;

  switch (plat) {
    case 'win32':
      // Windows: Use %APPDATA%/aicw or fallback to home directory
      outputPath = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'aicw')
        : path.join(homeDir, 'AppData', 'Roaming', 'aicw');
      break;

    case 'darwin':
      // macOS: Use ~/Library/Application Support/aicw
      outputPath = path.join(homeDir, 'Library', 'Application Support', 'aicw');
      break;

    default:
      // Linux and others: Use ~/.config/aicw (XDG Base Directory)
      outputPath = process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'aicw')
        : path.join(homeDir, '.config', 'aicw');
      break;
  }

  if (process.env.AICW_DEV_MODE === 'true') {
    console.log(`AICW_DEV_MODE is true, data path: ${outputPath}`);
  }

  return outputPath;
}

export function getCurrentDateTimeAsStringISO(): string {
  return new Date().toISOString();
}

// returns current datetime as string in format "2025 Oct 04 12:01:01"
export function getCurrentDateTimeAsString(): string {
  return new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
}



// Project-specific paths
export function getUserProjectDir(projectName: string): string {

  const projectPath = path.join(USER_PROJECTS_DIR, projectName);

  // SECURITY: Validate that project path is safe and inside USER_DATA_DIR
  validatePathIsSafe(projectPath, `project directory for: ${projectName}`);

  return projectPath;
}

/**
 * Normalize a website URL into a simple domain name for directory naming
 * Examples:
 *   https://www.aicw.io -> aicw.io
 *   http://example.com/path -> example.com
 *   www.test.org -> test.org
 */
export function getUserProjectQuestionsFile(projectName: string): string {
  return path.join(getUserProjectDir(projectName), QUESTIONS_FILE_NAME);
}

export function getUserProjectConfigFile(projectName: string): string {
  return path.join(getUserProjectDir(projectName), 'project.json');
}

export function getUserProjectAnswersDirForQuestion(projectName: string, question: string): string {
  return path.join(getUserProjectQuestionsDir(projectName), question, 'answers');
}

export function getUserProjectQuestionsDir(projectName: string): string {
  return path.join(getUserProjectDir(projectName), 'questions');
}

export function getUserProjectQuestionFilePath(projectName: string, questionId: string): string {
  return path.join(getUserProjectQuestionsDir(projectName), questionId, QUESTION_FILE_NAME);
}

export function getUserProjectQuestionFileContent(projectName: string, questionId: string): string {
  return readFileSync(getUserProjectQuestionFilePath(projectName, questionId), 'utf-8');
}

export function getUserProjectReportsDir(projectName: string): string {
  return path.join(getUserProjectDir(projectName), 'reports');
}

export function getUserProjectOutputDir(projectName: string): string {
  return path.join(USER_REPORTS_DIR, projectName);
}

// Question-specific paths
export function getUserQuestionDir(projectName: string, questionId: string): string {
  return path.join(getUserProjectQuestionsDir(projectName), questionId);
}

export function getUserQuestionDataCompiledDir(projectName: string, questionId: string): string {
  return path.join(getUserQuestionDir(projectName, questionId), 'data-compiled');
}

export function getUserQuestionDataCompiledDateDir(projectName: string, questionId: string, date: string): string {
  return path.join(getUserQuestionDataCompiledDir(projectName, questionId), date);
}

export function getUserAggregatedDataDir(projectName: string): string {
  return path.join(getUserProjectQuestionsDir(projectName), AGGREGATED_DIR_NAME);
}

export function getUserAggregatedDataCompiledDir(projectName: string): string {
  return path.join(getUserAggregatedDataDir(projectName), 'data-compiled');
}

export function getUserAggregatedDataCompiledDateDir(projectName: string, date: string): string {
  return path.join(getUserAggregatedDataCompiledDir(projectName), date);
}

// Helper functions for displaying paths to users
export function getProjectDisplayPath(projectName: string): string {
  const fullPath = getUserProjectDir(projectName);
  const home = homedir();
  // Contract home directory to ~ for display
  return fullPath.startsWith(home)
    ? fullPath.replace(home, '~')
    : fullPath;
}

export function getReportsDisplayPath(projectName: string): string {
  // Get the base OUTPUT directory
  const reportsPath = path.join(USER_REPORTS_DIR, projectName);
  const home = homedir();
  return reportsPath.startsWith(home)
    ? reportsPath.replace(home, '~')
    : reportsPath;
}

export function getActualReportsPath(projectName: string): string {
  // Get the actual full path for OUTPUT directory
  return path.join(USER_REPORTS_DIR, projectName);
}

// Initialize user directories (creates them if they don't exist)
export async function initializeUserDirectories(): Promise<void> {

  logger.info(`Initializing user data directories...`);
  // project and reports directories
  const directories = [
    USER_DATA_DIR,
    USER_PROJECTS_DIR,
    USER_REPORTS_DIR,
    USER_CACHE_DIR,
    USER_LOGS_DIR,
    USER_INVALID_OUTPUTS_DIR,
    path.join(USER_REPORTS_DIR, 'projects'),
    USER_CONFIG_CREDENTIALS_DIR  // for encrypted credentials
  ];

  for (const dir of directories) {
    if (!existsSync(dir)) {
      try {
        // SECURITY: Validate path is safe before creating directory
        await validatePathIsSafe(dir, `creating user data directory: ${dir}`);

        mkdirSync(dir, { recursive: true });
        logger.debug(`Created directory: ${dir}`);
      } catch (error: any) {
        // Check if it's a security error (PipelineCriticalError)
        if (error.name === 'PipelineCriticalError') {
          console.error(`\n${error.message}`);
          process.exit(1);
        }

        // File system error - explain it to user
        console.error(`\n${explainFileSystemError(error, `creating directory: ${dir}`)}`);
        console.error(`\nPath: ${dir}`);
        console.error(`\nAICW cannot continue without user data directories.`);
        process.exit(1);
      }
    }
  }
}



// Check if running in development mode (has src directory)
export function isDevMode(): boolean {
  // Check if we're running from source (has src directory as sibling to dist)
  const srcDir = path.join(__dirname, '..', 'src');
  return existsSync(srcDir);
}

// Get package root directory (for accessing bundled resources)
export function getPackageRoot(): string {
  // Move from dist/config back to the package root in both dev and npm installs.
  return path.join(__dirname, '..', '..');
}

export function getPackageDistDir(): string {
  return path.join(getPackageRoot(), 'dist');
}

export function getProjectNameFromProjectFolder(project: string): string {
  return project.replace(/_/g, ' ').trim();
}


export function getPackageConfigDataGeneratedDir(): string {
  return path.join(getPackageConfigDir(), 'data-generated');
}


export function getPackageConfigDataDir(): string {
  return path.join(getPackageConfigDir(), 'data');
}

// Get source config directory (from package)
export function getPackageConfigDir(subFolder: string = ''): string {
  // Try src first (dev mode), then fallback to bundled location
  const distConfig = path.join(getPackageDistDir(), 'config');

  if (existsSync(distConfig)) {
    return path.join(distConfig, subFolder);
  }
  else {
    throw new Error(`Config directory not found: ${distConfig}`);
  }
}


/**
 * Config path resolution functions
 * These functions return either user data folder paths or package paths
 * based on the USE_PACKAGE_CONFIG constant
 */
