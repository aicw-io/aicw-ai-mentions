/**
 * Centralized Output Management System
 * ALL console output must go through this module
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';

// ANSI color codes
export const LOG_COLOR = {
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

export function colorize(text: string, color: keyof typeof LOG_COLOR): string {
  return `${LOG_COLOR[color]}${text}${LOG_COLOR.reset}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Output state types
type OutputState = 'normal' | 'progress' | 'spinner';
type OutputType = 'line' | 'progress' | 'spinner' | 'none';

// Queued message for deferred output
interface QueuedMessage {
  type: 'log' | 'error' | 'warn' | 'info' | 'success' | 'debug';
  message: string;
  timestamp: number;
}

// Internal progress state
interface ProgressState {
  total: number;
  current: number;
  itemType: string;
  startTime: number;
  message: string;
}

// Internal spinner state
interface SpinnerState {
  frames: string[];
  currentFrame: number;
  message: string;
  interval: NodeJS.Timeout | null;
}

/**
 * FileLogger for detailed file logging
 */
class FileLogger {
  private logPath: string;
  private writeStream: NodeJS.WritableStream | null = null;
  private closing: boolean = false;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  async initialize(): Promise<void> {
    const dir = dirname(this.logPath);
    await fs.mkdir(dir, { recursive: true });

    const { createWriteStream } = await import('fs');
    this.writeStream = createWriteStream(this.logPath, { flags: 'a' });
  }

  log(level: string, message: string): void {
    if (!this.writeStream || this.closing) return;

    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    this.writeStream.write(logLine);
  }

  async close(): Promise<void> {
    this.closing = true;
    return new Promise((resolve) => {
      if (this.writeStream) {
        this.writeStream.end(() => {
          this.writeStream = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * Centralized Output Manager
 * This is the ONLY class that should write to stdout/stderr
 */
export class OutputManager {
  private static instance: OutputManager | null = null;

  // Output state management
  private outputState: OutputState = 'normal';
  private lastOutputType: OutputType = 'none';
  private lastLineLength: number = 0;
  private pendingNewline: boolean = false;

  // Integrated components
  private activeProgress: ProgressState | null = null;
  private activeSpinner: SpinnerState | null = null;

  // Message queue for deferred output
  private messageQueue: QueuedMessage[] = [];

  // Output coordination
  private outputLock: boolean = false;

  // Logging
  private fileLogger: FileLogger | null = null;
  private verbosityLevel: 'minimal' | 'normal' | 'verbose' = 'normal';
  private currentOperation: string = '';
  private stats: Map<string, any> = new Map();
  private warnings: string[] = [];
  private errors: string[] = [];
  private startTime: number = Date.now();

  // Singleton pattern
  private constructor() {}

  static getInstance(): OutputManager {
    if (!OutputManager.instance) {
      OutputManager.instance = new OutputManager();
    }
    return OutputManager.instance;
  }

  // ========== Initialization ==========

  async initialize(operation: string, project?: string): Promise<void> {
    this.currentOperation = operation;
    this.stats.clear();
    this.warnings = [];
    this.errors = [];
    this.startTime = Date.now();

    // Set verbosity from environment
    const verbosity = process.env.AICW_VERBOSITY || process.env.AICW_LOG_LEVEL || 'normal';
    this.setVerbosity(verbosity);

    // Create log file path inside the configured aicw data directory.
    const date = new Date().toISOString().split('T')[0];
    const { USER_LOGS_DIR } = await import('../config/user-paths.js');
    const logDir = join(USER_LOGS_DIR, date);
    const logName = project ? `${operation}-${project}.log` : `${operation}.log`;
    const logPath = join(logDir, logName);

    // Initialize file logger
    this.fileLogger = new FileLogger(logPath);
    await this.fileLogger.initialize();

    // Log initialization
    this.fileLogger.log('INFO', `Starting ${operation} operation${project ? ` for project: ${project}` : ''}`);
    this.fileLogger.log('INFO', `Verbosity level: ${this.verbosityLevel}`);

    // Show starting message (skip if running as part of a pipeline to avoid duplication)
    const isPartOfPipeline = process.env.AICW_PIPELINE_STEP !== undefined;
    if (this.verbosityLevel !== 'minimal' && !isPartOfPipeline) {
      const msg = `"${this.currentOperation}" action starting...`;
      this.writeStdout(colorize(`${"=".repeat(msg.length+3)}\n⚡️ ${msg}\n${"=".repeat(msg.length+3)}`, 'cyan') + '\n');
    }
  }

  setVerbosity(level: string): void {
    if (level === 'minimal' || level === 'normal' || level === 'verbose') {
      this.verbosityLevel = level;
    } else if (level === 'debug' || level === 'trace') {
      this.verbosityLevel = 'verbose';
    } else if (level === 'error' || level === 'warn') {
      this.verbosityLevel = 'minimal';
    }
  }

  // ========== Core Output Methods (ONLY place that writes to console) ==========

  private writeStdout(text: string): void {
    process.stdout.write(text);
    this.fileLogger?.log('OUTPUT', text.replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
  }

  private writeStderr(text: string): void {
    process.stderr.write(text);
    this.fileLogger?.log('ERROR_OUTPUT', text.replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
  }

  private clearCurrentLine(): void {
    // Clear the entire line using ANSI escape code
    this.writeStdout('\r\x1b[K');
    this.lastLineLength = 0;
  }

  private ensureNewline(): void {
    if (this.pendingNewline || this.lastOutputType === 'progress' || this.lastOutputType === 'spinner') {
      this.writeStdout('\n');
      this.pendingNewline = false;
    }
  }

  // ========== State Transitions ==========

  private transitionToNormal(): void {
    if (this.outputState === 'progress' || this.outputState === 'spinner') {
      this.clearCurrentLine();
      this.ensureNewline();
    }
    this.outputState = 'normal';
    this.lastOutputType = 'line';
    this.flushMessageQueue();
  }

  private transitionToProgress(): void {
    if (this.outputState === 'spinner') {
      this.stopSpinnerInternal();
    }
    if (this.outputState === 'normal') {
      this.ensureNewline();
    }
    this.outputState = 'progress';
    this.lastOutputType = 'progress';
  }

  private transitionToSpinner(): void {
    if (this.outputState === 'progress') {
      this.clearCurrentLine();
      this.ensureNewline();
    }
    if (this.outputState === 'normal') {
      this.ensureNewline();
    }
    this.outputState = 'spinner';
    this.lastOutputType = 'spinner';
  }

  // ========== Message Queue Management ==========

  private queueMessage(type: QueuedMessage['type'], message: string): void {
    this.messageQueue.push({ type, message, timestamp: Date.now() });
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      this.outputMessage(msg.type, msg.message);
    }
  }

  private outputMessage(type: QueuedMessage['type'], message: string): void {
    switch (type) {
      case 'log':
        this.writeStdout(message + '\n');
        break;
      case 'error':
        this.writeStderr(colorize(`✗ ${message}`, 'red') + '\n');
        break;
      case 'warn':
        this.writeStdout(colorize(`⚠️  ${message}`, 'yellow') + '\n');
        break;
      case 'info':
        this.writeStdout(colorize(`ℹ ${message}`, 'cyan') + '\n');
        break;
      case 'success':
        this.writeStdout(colorize(`✓ ${message}`, 'green') + '\n');
        break;
      case 'debug':
        if (this.verbosityLevel === 'verbose') {
          this.writeStdout(colorize(`[DEBUG] ${message}`, 'dim') + '\n');
        }
        break;
    }
  }

  // ========== Progress Management ==========

  startProgress(processingCaption: string = 'Processing', total: number, itemType: string): void {
    this.transitionToProgress();

    this.activeProgress = {
      total,
      current: 0,
      itemType,
      startTime: Date.now(),
      message: ''
    };

    if (this.verbosityLevel !== 'minimal') {
      this.writeStdout(colorize(`${processingCaption} ${total} ${itemType}`, 'dim') + '\n');
    }
  }

  updateProgress(current: number, message: string): void {
    if (!this.activeProgress || this.outputState !== 'progress') return;

    this.activeProgress.current = current;
    this.activeProgress.message = message;

    const percentage = Math.round((current / this.activeProgress.total) * 100);
    const elapsed = Date.now() - this.activeProgress.startTime;
    const eta = this.calculateETA(current, this.activeProgress.total, elapsed);

    if (this.verbosityLevel !== 'minimal') {
      // Visual progress bar
      const barLength = 30;
      const filledLength = Math.round((percentage / 100) * barLength);
      const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

      const compactLine = `${colorize(bar, 'green')} ${colorize(`${percentage}%`, 'cyan')} [${current}/${this.activeProgress.total}] ${message} ${colorize(`ETA: ${eta}`, 'dim')}`;

      // Clear previous line and write new one
      this.clearCurrentLine();
      this.writeStdout(compactLine);
      this.lastLineLength = compactLine.replace(/\x1b\[[0-9;]*m/g, '').length;

      // Mark that we need a newline after progress
      this.pendingNewline = true;

      // Add newline when progress reaches 100%
      if (percentage === 100) {
        this.writeStdout('\n');
        this.pendingNewline = false;
      }
    }

    // Log to file
    this.fileLogger?.log('PROGRESS', `${current}/${this.activeProgress.total} - ${message}`);
  }

  completeProgress(message?: string): void {
    if (!this.activeProgress) return;

    this.clearCurrentLine();

    // Only show completion message if not explicitly suppressed with empty string
    const messageShown = message !== '';
    if (messageShown) {
      const totalTime = Date.now() - this.activeProgress.startTime;
      const finalMessage = message || `Completed ${this.activeProgress.total} ${this.activeProgress.itemType}`;
      this.writeStdout(colorize(`✓ ${finalMessage} in ${formatDuration(totalTime)}`, 'green'));
    }

    this.activeProgress = null;

    // Only add newline if we actually showed a completion message
    // When message is suppressed (''), transition without extra newline
    if (messageShown) {
      this.transitionToNormal();
    } else {
      // Clear progress state without adding newline
      this.outputState = 'normal';
      this.lastOutputType = 'line';
      this.flushMessageQueue();
    }
  }

  cancelProgress(): void {
    if (!this.activeProgress) return;

    this.clearCurrentLine();
    this.ensureNewline();

    this.activeProgress = null;
    this.transitionToNormal();
  }

  // ========== Spinner Management ==========

  startSpinner(message: string): void {
    this.transitionToSpinner();

    this.activeSpinner = {
      frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      currentFrame: 0,
      message,
      interval: null
    };

    this.activeSpinner.interval = setInterval(() => {
      if (this.activeSpinner && this.outputState === 'spinner') {
        const frame = this.activeSpinner.frames[this.activeSpinner.currentFrame];
        const line = `\r${colorize(frame, 'cyan')} ${this.activeSpinner.message}`;

        this.clearCurrentLine();
        this.writeStdout(line);
        this.lastLineLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;

        this.activeSpinner.currentFrame = (this.activeSpinner.currentFrame + 1) % this.activeSpinner.frames.length;
        this.pendingNewline = true;
      }
    }, 80);
  }

  updateSpinner(message: string): void {
    if (this.activeSpinner) {
      this.activeSpinner.message = message;
    }
  }

  stopSpinner(success: boolean = true, finalMessage?: string): void {
    if (!this.activeSpinner) return;

    this.stopSpinnerInternal();

    if (finalMessage) {
      if (success) {
        this.success(finalMessage);
      } else {
        this.error(finalMessage);
      }
    }

    this.transitionToNormal();
  }

  private stopSpinnerInternal(): void {
    if (this.activeSpinner?.interval) {
      clearInterval(this.activeSpinner.interval);
      this.clearCurrentLine();
      this.ensureNewline();
    }
    this.activeSpinner = null;
  }

  // ========== Regular Output Methods ==========

  log(message: string): void {
    this.fileLogger?.log('INFO', message);

    if (this.outputState === 'normal') {
      this.outputMessage('log', message);
    } else {
      this.queueMessage('log', message);
    }
  }

  error(message: string): void {
    this.fileLogger?.log('ERROR', message);
    this.errors.push(message);

    // Always show errors immediately
    if (this.outputState !== 'normal') {
      this.clearCurrentLine();
      this.ensureNewline();
    }

    this.outputMessage('error', message);

    // Resume previous state if needed
    if (this.outputState === 'progress' && this.activeProgress) {
      this.updateProgress(this.activeProgress.current, this.activeProgress.message);
    } else if (this.outputState === 'spinner' && this.activeSpinner) {
      // Spinner will resume automatically
    }
  }

  warn(message: string): void {
    this.fileLogger?.log('WARN', message);
    this.warnings.push(message);

    if (this.outputState === 'normal') {
      if (this.verbosityLevel === 'verbose') {
        this.outputMessage('warn', message);
      }
    } else {
      this.queueMessage('warn', message);
    }
  }

  warnImmediate(message: string): void {
    this.fileLogger?.log('WARN', message);
    this.warnings.push(message);

    // Always show warnings immediately (like errors)
    if (this.outputState !== 'normal') {
      this.clearCurrentLine();
      this.ensureNewline();
    }

    this.outputMessage('warn', message);

    // Resume previous state if needed
    if (this.outputState === 'progress' && this.activeProgress) {
      this.updateProgress(this.activeProgress.current, this.activeProgress.message);
    } else if (this.outputState === 'spinner' && this.activeSpinner) {
      // Spinner will resume automatically
    }
  }

  info(message: string): void {
    this.fileLogger?.log('INFO', message);

    if (this.outputState === 'normal') {
      if (this.verbosityLevel !== 'minimal') {
        this.outputMessage('info', message);
      }
    } else {
      this.queueMessage('info', message);
    }
  }

  success(message: string): void {
    this.fileLogger?.log('SUCCESS', message);

    if (this.outputState === 'normal') {
      if (this.verbosityLevel !== 'minimal') {
        this.outputMessage('success', message);
      }
    } else {
      this.queueMessage('success', message);
    }
  }

  debug(message: string): void {
    this.fileLogger?.log('DEBUG', message);

    if (this.outputState === 'normal') {
      this.outputMessage('debug', message);
    } else if (this.verbosityLevel === 'verbose') {
      this.queueMessage('debug', message);
    }
  }

  // ========== Special Output Methods ==========

  writeLine(text: string): void {
    if (this.outputState !== 'normal') {
      this.transitionToNormal();
    }
    this.writeStdout(text + '\n');
    this.lastOutputType = 'line';
  }

  writeInline(text: string): void {
    if (this.outputState !== 'normal') {
      this.transitionToNormal();
    }
    this.writeStdout(text);
    this.pendingNewline = true;
  }

  clearLine(): void {
    this.clearCurrentLine();
  }

  newline(): void {
    this.writeStdout('\n');
    this.pendingNewline = false;
  }

  // ========== Child Process Coordination ==========

  beforeChildProcess(): void {
    // Ensure clean state before child process
    if (this.outputState === 'progress') {
      this.cancelProgress();
    } else if (this.outputState === 'spinner') {
      this.stopSpinnerInternal();
    }

    this.ensureNewline();
    this.outputState = 'normal';
    this.flushMessageQueue();
  }

  afterChildProcess(): void {
    // Ensure newline after child process
    this.ensureNewline();
    this.outputState = 'normal';
  }

  // ========== Statistics and Summary ==========

  addStat(key: string, value: any): void {
    this.stats.set(key, value);
    this.fileLogger?.log('STAT', `${key}: ${value}`);
  }

  incrementStat(key: string): void {
    const current = this.stats.get(key) || 0;
    this.stats.set(key, current + 1);
  }

  getStat(key: string): any {
    return this.stats.get(key);
  }

  async showSummary(): Promise<void> {
    // Ensure we're in normal state
    this.transitionToNormal();

    const duration = Date.now() - this.startTime;

    // Build summary message
    let summary = '';

    if (this.stats.size > 0) {
      const statsStr = Array.from(this.stats.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      summary = `"${this.currentOperation}" action complete. Stats: ${statsStr}`;
    } else {
      summary = `"${this.currentOperation}" action complete`;
    }

    // Show completion with duration
    this.writeStdout(colorize(`✅ ${summary} in ${formatDuration(duration)}`, 'green') + '\n');

    // Show warnings summary if any
    if (this.warnings.length > 0 && this.verbosityLevel !== 'minimal') {
      this.writeStdout(colorize(`⚠️  ${this.warnings.length} warnings occurred`, 'yellow') + '\n');
      if (this.verbosityLevel === 'verbose') {
        this.warnings.slice(0, 3).forEach(w => this.writeStdout(`   • ${w}\n`));
        if (this.warnings.length > 3) {
          this.writeStdout(`   • ... and ${this.warnings.length - 3} more\n`);
        }
      }
    }

    // Show errors summary if any
    if (this.errors.length > 0) {
      this.writeStdout(colorize(`❌ ${this.errors.length} errors occurred`, 'red') + '\n');
      this.errors.slice(0, 3).forEach(e => this.writeStdout(`   • ${e}\n`));
      if (this.errors.length > 3) {
        this.writeStdout(`   • ... and ${this.errors.length - 3} more\n`);
      }
    }

    // Close file logger
    await this.fileLogger?.close();
  }

  // ========== Utilities ==========

  private calculateETA(current: number, total: number, elapsed: number): string {
    if (current === 0) return 'calculating...';
    const avgTimePerItem = elapsed / current;
    const remainingItems = total - current;
    const remainingTime = avgTimePerItem * remainingItems;
    return formatDuration(remainingTime);
  }
}

// Export singleton instance with convenient name
export const output = OutputManager.getInstance();
