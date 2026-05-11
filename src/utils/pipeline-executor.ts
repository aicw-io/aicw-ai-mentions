import { PipelineDefinition, AppAction, getPipeline } from '../config/pipelines-and-actions.js';
import { getPackageDistDir } from '../config/user-paths.js';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { logger } from './compact-logger.js';
import { output } from './output-manager.js';
import { waitForEnterInInteractiveMode } from './misc-utils.js';
import { showInteractiveProjectSelector } from './interactive-project-selector.js';
import { getScriptPath } from './misc-utils.js';

export interface PipelineContext {
  currentStep: number;
  totalSteps: number;
}

export interface ExecutionOptions {
  /** Show interrupt hints */
  showHints?: boolean;
  /** Custom logger instance */
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Extra command-line args to pass to specific action IDs */
  actionArgs?: Record<string, string[]>;
  /** Project */
  project?: string;
}

export interface ExecutionResult {
  project?: string;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  duration: number;
  error?: Error;
  cancelledAt?: number;
}

// ============================================================================
// PIPELINE EXECUTOR CLASS
// ============================================================================

export class PipelineExecutor {
  private project: string;
  private currentChildProcess: ChildProcess | null = null;

  constructor(project?: string) {
    this.project = project || '';
  }

  /**
   * Execute a pipeline by ID
   */
  async execute(pipelineId: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const pipeline = getPipeline(pipelineId);

    if (!pipeline) {
      throw new Error(`Pipeline not found: ${pipelineId}`);
    }

    return this.executePipeline(pipeline, options);
  }

  /**
   * Execute a pipeline definition
   */
  async executePipeline(
    pipeline: PipelineDefinition,
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    const { showHints = true, env = {}, actionArgs = {}, project } = options;
    if(project) {
      this.project = project;
    }
    const startTime = Date.now();

    await output.initialize(pipeline.id, project || this.project);

    // Only show progress bar for multi-step pipelines (single-step would show 100% before starting)
    const showProgress = pipeline.actions.length > 1;
    if (showProgress) {
      logger.startProgress(pipeline.actions.length, `${this.project}: ${pipeline.name} (${pipeline.actions.length} steps)`);
    }

    for (let i = 0; i < pipeline.actions.length; i++) {
      const action = pipeline.actions[i];

      if (showProgress) {
        logger.updateProgress(i + 1, action.desc);
        // Ensure progress bar line is completed before spawning child process
        process.stdout.write('\n');
      }

      // Check if action needs project and we don't have one
      if (action.requiresProject && (!this.project || this.project.trim() === '')) {
        // Transition output to normal state for interactive prompt
        output.beforeChildProcess();
        // show project selector
        const selected = await showInteractiveProjectSelector();
        // Transition output to normal state for interactive prompt
        output.afterChildProcess();
        if (!selected) {
          throw new Error('Project selection required but cancelled');
        }
        this.project = selected;  // Store for subsequent actions
      }      

      try {
        let success: boolean;

        // Check if action should run directly in same process
        if (action.runDirectly) {
          success = await this.runDirectly(action, env);
        } else {
          // Normal child process execution
          const scriptPath = getScriptPath(action.cmd);
          const args = [scriptPath, this.project, ...(actionArgs[action.id] || [])];
          success = await this.runInterruptible(args, showHints, {
            currentStep: i + 1,
            totalSteps: pipeline.actions.length,
          }, env, action);
        }

        if (!success) {
          const error = new Error(`Action failed: ${action.desc}`);
          logger.error(`\n✗ Pipeline "${pipeline.name}" failed at the action "${action.id}" (${action.name}: ${action.desc})`);
          await logger.showSummary();

          return {
            project: this.project,
            success: false,
            completedSteps: i,
            totalSteps: pipeline.actions.length,
            duration: Date.now() - startTime,
            error,
          };
        }
      } catch (error: any) {
        if (error.message === 'Operation cancelled') {
          logger.info('\n↩️ Operation cancelled');
          await logger.showSummary();
          // await until enter is pressed
          await waitForEnterInInteractiveMode();

          return {
            project: this.project,
            success: false,
            completedSteps: i,
            totalSteps: pipeline.actions.length,
            duration: Date.now() - startTime,
            cancelledAt: i,
          };
        }

        if (error.message.startsWith('MissingConfigError:')) {
          logger.error(`\n❌ Pipeline "${pipeline.name}" stopped: Missing configuration`);
          logger.error('\n💡 Please run setup to configure API keys:');
          logger.error('   aicw-ai-mentions setup-api-key\n');
          await logger.showSummary();
          await waitForEnterInInteractiveMode();

          return {
            project: this.project,
            success: false,
            completedSteps: i,
            totalSteps: pipeline.actions.length,
            duration: Date.now() - startTime,
            error,
          };
        }

        logger.error(`\n✗ Pipeline "${pipeline.name}" failed at the action "${action.id}" (${action.name}: ${action.desc}) with errors: ${error.message}`);
        await logger.showSummary();

        return {
          project: this.project,
          success: false,
          completedSteps: i,
          totalSteps: pipeline.actions.length,
          duration: Date.now() - startTime,
          error,
        };
      }

      if (showProgress) {
        logger.updateProgress(i + 1, `${action.desc} - ✓`);
      }
    }

    if (showProgress) {
      logger.completeProgress(`pipeline "${pipeline.name}" completed`);
    }

    const duration = Date.now() - startTime;

    await logger.showSummary();

    // Send iTerm2 notification on successful completion
    const durationSec = (duration / 1000).toFixed(1);
    process.stdout.write(`\x1b]9;${pipeline.name} complete (${durationSec}s)\x07`);

    return {
      project: this.project,
      success: true,
      completedSteps: pipeline.actions.length,
      totalSteps: pipeline.actions.length,
      duration,
    };
  }
  /**
   * Run an action directly in the same process (for long-running services)
   */
  private async runDirectly(
    action: AppAction,
    additionalEnv: Record<string, string> = {}
  ): Promise<boolean> {
    try {
      // Set environment variables
      Object.assign(process.env, additionalEnv);

      // Dynamically import the module
      const modulePath = path.join(getPackageDistDir(), `${action.cmd}.js`);
      const module = await import(modulePath);

      // Call startServer() if it exists
      if (module.startServer && typeof module.startServer === 'function') {
        logger.info(`Running ${action.name} directly in same process...`);
        const result = await module.startServer();
        logger.success(`${action.name} completed (result: ${result})`);
        return true;
      } else {
        logger.error(`Module ${action.cmd} does not export startServer() function`);
        return false;
      }
    } catch (error: any) {
      logger.error(`Failed to run ${action.name} directly: ${error.message}`);
      return false;
    }
  }

  /**
   * Run a command in an interruptible way
   */
  private runInterruptible(
    args: string[],
    showHint: boolean,
    pipelineContext: PipelineContext,
    additionalEnv: Record<string, string> = {},
    action: AppAction
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (showHint) {
        const colorize = (text: string, color: string) => {
          const COLORS: any = {
            dim: '\x1b[2m',
            reset: '\x1b[0m',
          };
          return `${COLORS[color] || ''}${text}${COLORS.reset}`;
        };
        output.writeLine(colorize('\n💡 Running a pipeline: press Ctrl+C to interrupt the pipeline', 'dim'));
      }

      // Set environment variables
      const env: any = {
        ...process.env,
        ...additionalEnv,
        AICW_INTERACTIVE_MODE: 'true',
        AICW_PIPELINE_STEP: String(pipelineContext.currentStep),
        AICW_PIPELINE_TOTAL_STEPS: String(pipelineContext.totalSteps),
      };

      const isPipeRequired = action && action.requiresConsolePipeReturn;
      if(isPipeRequired) {
        logger.debug(`Action requires pipe (isPipeRequired: ${isPipeRequired})`);
      }

      // Use pipe for stdout if project-new, otherwise inherit
      const stdioConfig = isPipeRequired
      ? ['inherit', 'pipe', 'inherit'] as any
      : 'inherit';        

      let capturedOutput = '';

      this.currentChildProcess = spawn('node', args, { stdio: stdioConfig, env });

      // If capturing stdout, forward to terminal and capture 
      if (isPipeRequired && this.currentChildProcess.stdout) {  
        this.currentChildProcess.stdout.on('data', (data: Buffer) => {
          const text = data.toString();                       
          capturedOutput += text;                             
          process.stdout.write(text);  // Still show to user  
        });                                                   
      }                                                       
     

      this.currentChildProcess.on('exit', (code) => {
        this.currentChildProcess = null;

        if (code === 0) {
          // success

          // Extract project name if present
          if (isPipeRequired && capturedOutput) {
            // trying to parse if we have something like this:
            // AICW_OUTPUT_STRING:NewProjectName (or "best lawyer for a startup")
            const match = capturedOutput.match(/AICW_OUTPUT_STRING:(.+)/);
            if (match) {
              this.project = match[1].trim();
            }
          }

          resolve(true);
        } else if (code === 2) {
          // Exit code 2 = MissingConfigError
          reject(new Error('MissingConfigError: Setup required'));
        } else if (code === null) {
          // Process was killed (SIGINT)
          reject(new Error('Operation cancelled'));
        } else {
          resolve(false);
        }
      });

      this.currentChildProcess.on('error', (err) => {
        this.currentChildProcess = null;
        reject(err);
      });
    });
  }

  /**
   * Kill the current running process
   */
  kill(): void {
    if (this.currentChildProcess) {
      this.currentChildProcess.kill('SIGINT');
    }
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Execute a pipeline by ID (convenience function)
 */
export async function executePipeline(
  pipelineId: string,
  project: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const executor = new PipelineExecutor(project);
  return executor.execute(pipelineId, options);
}

/**
 * Execute a pipeline by definition (convenience function)
 */
export async function executePipelineDefinition(
  pipeline: PipelineDefinition,
  project: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const executor = new PipelineExecutor(project);
  return executor.executePipeline(pipeline, options);
}
