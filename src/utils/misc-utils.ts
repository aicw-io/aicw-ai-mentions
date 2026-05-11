import { promises as fs } from 'fs';
import path, { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { getPackageRoot, isDevMode, getUserDataDir } from '../config/user-paths.js';
import { decryptCredentialsFile, isEncryptedCredentials } from './crypto-utils.js';
import { output } from './output-manager.js';
import { USER_CONFIG_CREDENTIALS_FILE } from  '../config/user-paths.js';
import { PipelineCriticalError } from './pipeline-errors.js';
import { logger } from './compact-logger.js';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { MIN_VALID_OUTPUT_DATA_SIZE } from '../config/user-paths.js';
import { homedir } from 'os';


const MAX_TEMPLATE_PREVIEW_LENGTH_FOR_ERROR_MESSAGES = 400;
const warnedCredentialsFiles = new Set<string>();

export const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

export function getEntityTypeFromSectionName(arrayType: string): string {
  // simply turning "links" into "link"
  // check MAIN_SECTIONS for array types
  return arrayType.slice(0, -1);
}

export async function openInDefaultBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  let openCmd: string;

  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'win32') {
    // Windows requires special handling for the 'start' command
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      shell: false
    }).unref();
  } else {
    // Linux and other Unix-like systems
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
  logger.success(`Browser opened at ${url}`);
  return true;
}

  /**
   * Get absolute path to a script file
   */
export function getScriptPath(scriptName: string): string {
    const COMPILED_JS_SUBFOLDER = 'dist';
    const packageRoot = getPackageRoot();
    return path.join(packageRoot, COMPILED_JS_SUBFOLDER, `${scriptName}.js`);
}


export function getModuleNameFromUrl(url: string): string {
  return url.match(/\/([^/]+)\.(js|ts)$/)?.[1] || 'default';
}

export function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

/**
 * Clear any pending data from stdin buffer to prevent input accumulation
 * between readline operations
 */
export function clearStdinBuffer(): void {
  if (process.stdin.isTTY) {
    // Pause stdin to prevent further input buffering
    process.stdin.pause();

    // Remove all existing data listeners temporarily to drain the buffer
    const dataListeners = process.stdin.listeners('data');
    process.stdin.removeAllListeners('data');

    // Set stdin to raw mode temporarily to read any buffered input
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      // Read and discard any buffered data
      process.stdin.read();
      process.stdin.setRawMode(false);
    }

    // Restore data listeners
    dataListeners.forEach(listener => process.stdin.on('data', listener as any));
  }
}

/**
 * Create a clean readline interface with stdin buffer cleared
 * This prevents input accumulation issues between prompts
 */
export function createCleanReadline() {
  // Clear any pending stdin data before creating the interface
  clearStdinBuffer();

  // Resume stdin for the readline interface
  process.stdin.resume();

  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

export interface BoxOptions {
  borderColor?: keyof typeof COLORS;
  padding?: number;
  width?: number;
  align?: 'left' | 'center' | 'right';
}

export function drawBox(lines: string[], options: BoxOptions = {}): string {
  const {
    borderColor = 'green',
    padding = 1,
    width,
    align = 'left'
  } = options;

  // Find the longest line to determine border width
  let maxLength = 0;
  for (const line of lines) {
    const strippedLine = line.replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI codes for length calculation
    if (strippedLine.length > maxLength) {
      maxLength = strippedLine.length;
    }
  }

  // Use specified width or auto-size to longest line
  const borderWidth = width || Math.max(maxLength, 30); // Minimum 30 chars
  const border = colorize('═', borderColor);
  const borderLine = border.repeat(borderWidth);

  const result: string[] = [];

  // Add top border
  result.push(borderLine);

  // Add top padding (empty lines)
  for (let i = 0; i < padding; i++) {
    result.push('');
  }

  // Add content lines - just display them as-is, optionally with alignment
  for (const line of lines) {
    if (align === 'center') {
      const strippedLine = line.replace(/\x1b\[[0-9;]*m/g, '');
      const lineLength = strippedLine.length;
      if (lineLength < borderWidth) {
        const leftPadding = Math.floor((borderWidth - lineLength) / 2);
        result.push(' '.repeat(leftPadding) + line);
      } else {
        result.push(line);
      }
    } else if (align === 'right') {
      const strippedLine = line.replace(/\x1b\[[0-9;]*m/g, '');
      const lineLength = strippedLine.length;
      if (lineLength < borderWidth) {
        const leftPadding = borderWidth - lineLength;
        result.push(' '.repeat(leftPadding) + line);
      } else {
        result.push(line);
      }
    } else {
      // Default: left align or as-is
      result.push(line);
    }
  }

  // Add bottom padding (empty lines)
  for (let i = 0; i < padding; i++) {
    result.push('');
  }

  // Add bottom border
  result.push(borderLine);

  return result.join('\n');
}

// formatLine function removed - no longer needed with the simplified box design

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}


// Load encrypted API keys from user config directory
export async function loadEnvFile(): Promise<void> {
  try {
    const credentialsPath = USER_CONFIG_CREDENTIALS_FILE;
    const credContent = await fs.readFile(credentialsPath, 'utf8');
    const credData = JSON.parse(credContent);

    if (isEncryptedCredentials(credData)) {
      // Decrypt and load API keys
      const decrypted = decryptCredentialsFile(credData);
      const encryptedKeyCount = Object.keys(credData.credentials).length;
      const decryptedKeyCount = Object.keys(decrypted).length;
      if (encryptedKeyCount > decryptedKeyCount && !warnedCredentialsFiles.has(credentialsPath)) {
        warnedCredentialsFiles.add(credentialsPath);
        logger.warnImmediate(
          `Credentials file exists but could not be decrypted: ${credentialsPath}. ` +
          'Run "aicw-ai-mentions setup-api-key" to replace it on this machine.'
        );
      }
      for (const [key, value] of Object.entries(decrypted)) {
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // No credentials file found - user needs to run setup
    logger.warn(`No credentials file found - user needs to run setup`);
  }
}

export async function replaceMacrosInTemplate(
  template: string,
  macrosAndValues: Record<string, string>,
  verify: boolean = true
) {

  if (!template || template.trim() === '') {
    throw new PipelineCriticalError(
      `Template is empty`,
      'replaceMacrosInTemplate',
      'verifyTemplateHasNoMacrosInside'
    );
  }

  // go through all macros and values and replace them in the template
  for (const [macro, value] of Object.entries(macrosAndValues)) {

    if(!macro || macro.trim() === '') {
      throw new PipelineCriticalError(
        `Macro is empty`,
        'replaceMacrosInTemplate',
        'verifyTemplateHasNoMacrosInside'
      );
    }


    // Allow empty strings as valid values (e.g., for optional content sections)
    if(typeof value !== 'string') {
      throw new PipelineCriticalError(
        `Value for macro '${macro}' is not a string: "${JSON.stringify(value)}" (type: ${typeof value})`,
        'replaceMacrosInTemplate',
        'verifyTemplateHasNoMacrosInside'
      );
    }

      const templateBefore = template;
      template = template.replaceAll(macro, value);      
      if(verify && template === templateBefore) {
        throw new PipelineCriticalError(
          `Macro ${macro} was NOT replaced in template! templateBefore:\n\n${templateBefore.trim().substring(0, MAX_TEMPLATE_PREVIEW_LENGTH_FOR_ERROR_MESSAGES)}...\n\n`,
          'replaceMacrosInTemplate',
          'verifyTemplateHasNoMacrosInside'
        );
      }
  }

  // verify again ANY {{..}} unreplaced macros if need to!
  if(verify) {
    await verifyTemplateHasUnreplacedMustachioMacrosInside(template);
  }

  return template;
}

async function verifyTemplateHasUnreplacedMustachioMacrosInside(prompt:string){
  if (!prompt) {
    return;
  }
  if(prompt.indexOf('{{') === -1 && prompt.indexOf('}}') === -1)  {
    return;
  }

  // gather macros that were not replaced!
  const REGEX_MACROS = /{{[A-Z0-9_]+}}/g;
  const macros = prompt.match(REGEX_MACROS);

  throw new PipelineCriticalError(
    `!! Input string has macros that are not replaced:\n\n${macros.join('\n')}\n. Template was:\n\n${prompt.trim().substring(0, MAX_TEMPLATE_PREVIEW_LENGTH_FOR_ERROR_MESSAGES)}...`,
    'verifyTemplateHasUnreplacedMustachioMacrosInside'
  );
}

/**
 * Format a single bot answer using the shared template.
 * Template is loaded once and cached for performance.
 *
 * @param botId - The bot/model identifier (e.g., "perplexity_with_search_latest")
 * @param answerContent - The answer text content from the bot
 * @returns Formatted answer string with separators and bot identifier
 */
let singleAnswerTemplateCache: string | null = null;

export async function formatSingleAnswer(botId: string, answerContent: string): Promise<string> {
  // Load template on first call and cache it
  if (singleAnswerTemplateCache === null) {
    const { SINGLE_ANSWER_TEMPLATE_PATH } = await import('../config/paths.js');
    singleAnswerTemplateCache = await fs.readFile(SINGLE_ANSWER_TEMPLATE_PATH, 'utf-8');
  }

  // Replace placeholders
  return await replaceMacrosInTemplate(
    singleAnswerTemplateCache,
    {
      '{{MODEL_ID}}': botId,
      '{{ANSWER_CONTENT}}': answerContent
    },
    false // Don't verify macros since the template is static and trusted
  );
}

/**
 * Atomically write data to a file by writing to a temp file first and then renaming.
 * This prevents partial writes and data corruption if the process crashes during write.
 *
 * In dev mode (npm link, running from source), automatically creates a backup of existing files
 * before overwriting them. Backups are named: BACKUP-{ISO-timestamp}-{original-filename}
 *
 * @param filePath - The destination file path
 * @param data - The data to write (string or Buffer)
 * @param options - Optional encoding (defaults to 'utf8')
 * @returns Promise that resolves when write is complete
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: { encoding?: BufferEncoding; mode?: number } = {}
): Promise<void> {
  const { encoding = 'utf8', mode } = options;

  // Generate a unique temp file name in the same directory as the target file
  const dir = dirname(filePath);
  const tempFileName = `.${randomBytes(16).toString('hex')}.tmp`;
  const tempPath = join(dir, tempFileName);

  try {
    // Ensure the directory exists
    await fs.mkdir(dir, { recursive: true });

    // In dev mode, create backup of existing file before overwriting
    if (isDevMode()) {
      try {
        await fs.access(filePath);
        // File exists, create backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'unknown';
        const backupName = `BACKUP-${timestamp}-${fileName}`;
        const backupPath = join(dir, backupName);
        await fs.copyFile(filePath, backupPath);
      } catch {
        // File doesn't exist yet, no backup needed
        logger.info(`File ${filePath} does not exist yet, no backup needed`);
      }
    }

    // Write to temp file
    await fs.writeFile(tempPath, data, encoding);

    // Set file permissions if specified
    if (mode !== undefined) {
      await fs.chmod(tempPath, mode);
    }

    // Atomically rename temp file to final destination
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Check if a file or folder entry is a backup that should be preserved
 *
 * @param entryName - Name of the file or directory entry
 * @param isDirectory - Whether this entry is a directory
 * @returns true if this is a backup entry and should be skipped during cleanup
 */
export function isBackupFileOrFolder(entryName: string, isDirectory: boolean): boolean {
  // Skip backups directory
  if (isDirectory && entryName === 'backups') {
    return true;
  }

  // Skip BACKUP- prefixed files (created by writeFileAtomic in dev mode)
  if (!isDirectory && entryName.startsWith('BACKUP-')) {
    return true;
  }

  return false;
}

/**
 * Validate that a path is safe for file operations and within USER_DATA_DIR boundary.
 * This critical security function prevents accidental operations on system files or outside the app's data folder.
 *
 * SECURITY CHECKS:
 * 1. Rejects system directories (/System, /Windows, /usr, /etc, etc.)
 * 2. Rejects root directory and home directory root
 * 3. Resolves symlinks to prevent escape attacks
 * 4. REQUIRES path to be inside USER_DATA_DIR
 * 5. Checks for suspicious patterns (.git, node_modules, ..)
 *
 * @param targetPath - Path to validate (can be relative or absolute)
 * @param operationDescription - Description of operation for error messages
 * @throws PipelineCriticalError if path is dangerous or outside USER_DATA_DIR boundary
 *
 * @example
 * await validatePathIsSafe(path.join(USER_DATA_DIR, 'projects', 'foo'), 'project dir');
 * // PASS - inside USER_DATA_DIR
 *
 * await validatePathIsSafe('/etc/passwd', 'project dir');
 * // THROW - system directory
 *
 * await validatePathIsSafe(path.resolve(USER_DATA_DIR, '..', '..', 'outside'), 'project dir');
 * // THROW - outside USER_DATA_DIR boundary
 */
export async function validatePathIsSafe(
  targetPath: string,
  operationDescription: string
): Promise<void> {
  const { USER_DATA_DIR } = await import('../config/user-paths.js');

  // Normalize path for checking
  const normalizedPath = path.normalize(targetPath);

  // CHECK 1: Dangerous system directories
  const dangerousPatterns = {
    darwin: [
      '/System', '/Library', '/Applications', '/usr', '/etc', '/bin',
      '/sbin', '/var', '/private', '/dev', '/cores'
    ],
    win32: [
      'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
      'C:\\ProgramData', 'C:\\System32'
    ],
    linux: [
      '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot',
      '/sys', '/proc', '/dev', '/run', '/root'
    ]
  };

  const platform = process.platform;
  const systemDirs = dangerousPatterns[platform as keyof typeof dangerousPatterns] || dangerousPatterns.linux;

  for (const sysDir of systemDirs) {
    const normalizedSysDir = path.normalize(sysDir);
    if (normalizedPath === normalizedSysDir || normalizedPath.startsWith(normalizedSysDir + path.sep)) {
      throw new PipelineCriticalError(
        `SECURITY: Cannot operate on system directory!\n` +
        `  Operation: ${operationDescription}\n` +
        `  Target path: ${normalizedPath}\n` +
        `  Detected system directory: ${normalizedSysDir}\n` +
        `  This operation is BLOCKED to prevent system damage.`,
        'validatePathIsSafe'
      );
    }
  }

  // CHECK 2: Root directory or home directory root  
  const homeDir = homedir();
  if (normalizedPath === '/' || normalizedPath === 'C:\\' || normalizedPath === homeDir) {
    throw new PipelineCriticalError(
      `SECURITY: Cannot operate on root/home directory!\n` +
      `  Operation: ${operationDescription}\n` +
      `  Target path: ${normalizedPath}\n` +
      `  This operation is BLOCKED to prevent data loss.`,
      'validatePathIsSafe'
    );
  }

  // CHECK 3 & 4: Resolve real paths and validate boundary
  try {
    // Resolve target path - handle non-existent paths by resolving parent
    let resolvedTarget: string;
    try {
      resolvedTarget = await fs.realpath(targetPath);
    } catch (error) {
      // Path doesn't exist yet - resolve parent and append basename
      const parentPath = path.dirname(targetPath);
      const baseName = path.basename(targetPath);
      try {
        const resolvedParent = await fs.realpath(parentPath);
        resolvedTarget = path.join(resolvedParent, baseName);
      } catch {
        // Parent doesn't exist either - use normalized absolute path
        resolvedTarget = path.resolve(normalizedPath);
      }
    }

    // Resolve USER_DATA_DIR boundary
    const resolvedBoundary = await fs.realpath(USER_DATA_DIR);

    // Normalize both paths
    const normalizedTarget = path.normalize(resolvedTarget);
    const normalizedBoundary = path.normalize(resolvedBoundary);

    // Check if target is inside boundary
    const boundaryWithSep = normalizedBoundary.endsWith(path.sep)
      ? normalizedBoundary
      : normalizedBoundary + path.sep;

    const isInside = normalizedTarget === normalizedBoundary ||
                     normalizedTarget.startsWith(boundaryWithSep);

    if (!isInside) {
      throw new PipelineCriticalError(
        `SECURITY: Path is outside allowed boundary!\n` +
        `  Operation: ${operationDescription}\n` +
        `  Target path: ${normalizedTarget}\n` +
        `  Required boundary: ${normalizedBoundary}\n` +
        `  ALL operations must be inside: <userdatapath>/aicw/<username>/data/\n` +
        `  This operation is BLOCKED to prevent accidental data loss outside app folder.`,
        'validatePathIsSafe'
      );
    }

  } catch (error) {
    if (error instanceof PipelineCriticalError) {
      throw error;
    }
    // If we can't resolve paths, fail safe
    throw new PipelineCriticalError(
      `Failed to validate path safety: ${error instanceof Error ? error.message : String(error)}\n` +
      `  Operation: ${operationDescription}\n` +
      `  Target path: ${targetPath}\n` +
      `  Cannot verify path is safe - operation BLOCKED.`,
      'validatePathIsSafe'
    );
  }

  // CHECK 5: Suspicious patterns
  const suspiciousPatterns = ['.git', 'node_modules', '..'];
  for (const pattern of suspiciousPatterns) {
    if (normalizedPath.includes(path.sep + pattern + path.sep) ||
        normalizedPath.endsWith(path.sep + pattern)) {
      logger.warn(`Path contains suspicious pattern "${pattern}": ${normalizedPath} for operation: ${operationDescription}`);
    }
  }

  logger.debug(`Path validation PASSED: ${normalizedPath} is safe for ${operationDescription}`);
}

/**
 * Convert Node.js file system error codes into user-friendly explanations.
 * Provides platform-specific troubleshooting guidance.
 *
 * @param error - The error object from fs operations
 * @param operationDescription - Description of what was being attempted
 * @returns Formatted error message with explanation and fix suggestions
 *
 * @example
 * try {
 *   mkdirSync('/restricted/path');
 * } catch (error) {
 *   console.error(explainFileSystemError(error, 'creating directory'));
 * }
 * // Output:
 * // ❌ Permission denied when creating directory
 * //    Error Code: EACCES
 * //    Cause: You don't have write access to this location
 * //    Fix (macOS): Check permissions...
 */
export function explainFileSystemError(
  error: any,
  operationDescription: string
): string {
  const errorCode = error.code || error.errno || 'UNKNOWN';
  const errorMessage = error.message || String(error);
  const platform = process.platform;

  // Error code explanations with platform-specific fixes
  const errorExplanations: Record<string, {
    message: string;
    cause: string;
    fix: Record<string, string>;
  }> = {
    EACCES: {
      message: 'Permission denied',
      cause: "You don't have write/read access to this location",
      fix: {
        darwin: 'Check permissions: ls -la "$(dirname <path>)" or use chmod/chown to fix permissions',
        win32: 'Run terminal as Administrator or check folder Properties > Security tab',
        linux: 'Check permissions: ls -la "$(dirname <path>)" or use sudo/chmod to fix'
      }
    },
    EPERM: {
      message: 'Operation not permitted',
      cause: 'Insufficient privileges, file is locked, or protected by system',
      fix: {
        darwin: 'File may be locked or require admin access. Try: sudo or check System Preferences > Security',
        win32: 'Run as Administrator or check if file is in use by another program',
        linux: 'Try with sudo or check if file is immutable (lsattr/chattr)'
      }
    },
    ENOENT: {
      message: 'File or directory not found',
      cause: 'Path does not exist, or parent directory is missing',
      fix: {
        darwin: 'Verify path exists: ls -la "$(dirname <path>)"',
        win32: 'Verify path exists in File Explorer',
        linux: 'Verify path exists: ls -la "$(dirname <path>)"'
      }
    },
    ENOSPC: {
      message: 'No space left on device',
      cause: 'Disk is full - insufficient storage space',
      fix: {
        darwin: 'Free up space: Check storage in  > About This Mac > Storage',
        win32: 'Free up space: Check C:\\ drive in File Explorer',
        linux: 'Free up space: df -h to check disk usage, rm unnecessary files'
      }
    },
    EROFS: {
      message: 'Read-only file system',
      cause: 'Cannot write to read-only mounted filesystem',
      fix: {
        darwin: 'Check if volume is mounted read-only: mount | grep <path>',
        win32: 'Check drive properties and ensure it\'s not write-protected',
        linux: 'Remount with write permissions: sudo mount -o remount,rw <path>'
      }
    },
    ENOTDIR: {
      message: 'Not a directory',
      cause: 'Expected a directory but found a file at this path',
      fix: {
        darwin: 'Check path: file <path> to see what it is',
        win32: 'Verify path in File Explorer',
        linux: 'Check path: file <path> or ls -la <path>'
      }
    },
    EISDIR: {
      message: 'Is a directory',
      cause: 'Expected a file but found a directory at this path',
      fix: {
        darwin: 'Check if you need to operate on directory instead: ls -la <path>',
        win32: 'Verify path in File Explorer points to a file',
        linux: 'Check path: ls -ld <path>'
      }
    },
    EEXIST: {
      message: 'File already exists',
      cause: 'Cannot create file/directory - already exists at this location',
      fix: {
        darwin: 'Remove existing file first or choose different name',
        win32: 'Delete existing file in File Explorer or choose different name',
        linux: 'Remove existing file: rm <path> or choose different name'
      }
    },
    EMFILE: {
      message: 'Too many open files',
      cause: 'Process has opened too many files simultaneously',
      fix: {
        darwin: 'Close some files or increase limit: ulimit -n',
        win32: 'Close some applications or restart the program',
        linux: 'Close files or increase limit: ulimit -n <number>'
      }
    }
  };

  const explanation = errorExplanations[errorCode] || {
    message: 'Unknown file system error',
    cause: `Unexpected error: ${errorMessage}`,
    fix: {
      darwin: 'Check system logs: Console.app or contact support',
      win32: 'Check Event Viewer or contact support',
      linux: 'Check system logs: journalctl or dmesg'
    }
  };

  const platformFix = explanation.fix[platform as keyof typeof explanation.fix] ||
                      explanation.fix.linux ||
                      'Contact system administrator';

  // Format the error message
  const formattedMessage = [
    `❌ ${explanation.message} when ${operationDescription}`,
    `   Error Code: ${errorCode}`,
    `   Cause: ${explanation.cause}`,
    `   Fix: ${platformFix}`
  ];

  return formattedMessage.join('\n');
}

export enum WaitForEnterMessageType {
  PRESS_ENTER_TO_THE_MENU = 'PRESS ENTER TO RETURN TO THE MENU',
  PRESS_ENTER_TO_CONTINUE = 'PRESS ENTER TO CONTINUE OR PRESS 0 OR CTRL+C TO CANCEL',  
}

// Function to wait for Enter key in interactive mode
export async function waitForEnterInInteractiveMode(
  messageType: WaitForEnterMessageType = WaitForEnterMessageType.PRESS_ENTER_TO_THE_MENU,
  forceShow: boolean = false
): Promise<boolean> {
  // Only show prompt if running from interactive mode AND not part of a pipeline
  // When running as part of a pipeline, we want to continue to the next step automatically
  const shouldPrompt = (process.env.AICW_INTERACTIVE_MODE === 'true' && !process.env.AICW_PIPELINE_STEP) || forceShow;
  if (shouldPrompt && process.stdin.isTTY && process.stdout.isTTY) {
    output.writeLine(colorize(`\n${messageType}`, 'dim'));
    const rl = createCleanReadline();

    const input = await new Promise<string>(resolve => {
      let resolved = false;

      // Handle CTRL+C (SIGINT)
      const sigintHandler = () => {
        if (!resolved) {
          resolved = true;
          rl.close();
          process.stdin.pause();
          process.off('SIGINT', sigintHandler); // Remove handler to avoid memory leaks
          resolve('^C');
        }
      };

      process.on('SIGINT', sigintHandler);

      rl.question('', (answer) => {
        if (!resolved) {
          resolved = true;
          rl.close();
          process.stdin.pause();
          process.off('SIGINT', sigintHandler); // Clean up handler
          resolve(answer);
        }
      });
    });

    if (input && (input.trim().toLowerCase() === '0' || input === '^C')) {
      return false;
    }
    return true;
  }
  // Not interactive, just continue
  return true;
}

/**
 * Check if an output file exists and meets minimum size requirements.
 * In force mode, deletes the file first to ensure rebuild.
 * @param filePath - Path to the file to check
 * @param minSize - Minimum required file size in bytes
 * @param forceRebuild - If true, deletes the file and returns false
 * @returns true if file exists and meets size requirements, false otherwise
 */
export async function isValidOutputFile(
  filePath: string,
  minSize: number = MIN_VALID_OUTPUT_DATA_SIZE,
  forceRebuild: boolean = false
): Promise<boolean> {
  // In force mode, delete the file first so check fails naturally
  if (forceRebuild) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // File doesn't exist, that's ok
    }
    return false; // Always rebuild in force mode
  }

  try {
    const stats = await fs.stat(filePath);
    return stats.size >= minSize;
  } catch (error) {
    return false; // File doesn't exist
  }
}

/**
 * Load optional custom footer code from user templates folder.
 * Used to inject custom HTML/JS (like analytics trackers) into report pages.
 *
 * @param templateName - Name of template (e.g., 'mention-page', 'source-page', 'index-project')
 * @returns Custom HTML content or empty string if not found/empty
 */
export async function loadCustomFooterCode(templateName: string): Promise<string> {
  const userDataDir = getUserDataDir();
  const customTemplatePath = path.join(userDataDir, 'templates', 'footer_custom_code', `${templateName}.html`);

  try {
    const stats = await fs.stat(customTemplatePath);
    if (stats.isFile()) {
      const content = await fs.readFile(customTemplatePath, 'utf-8');
      // Only inject if there's actual content (not just comments/whitespace)
      const trimmedContent = content.trim();
      // Check if it's only an HTML comment (our default template)
      const isOnlyComment = /^<!--[\s\S]*-->$/.test(trimmedContent);
      if (trimmedContent && !isOnlyComment) {
        logger.warn(`Custom footer code injected from: ${customTemplatePath}`);
        return content;
      }
    }
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      logger.warn(`Unable to read footer template ${customTemplatePath}: ${fileError.message}`);
    }
  }

  return '';
}
