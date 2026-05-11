import { promises as fs } from 'fs';
import path from 'path';
import { QuestionEntry } from '../config/types.js';
import { ModelConfig } from '../utils/model-config.js';
import { formatFileSize, colorize, writeFileAtomic, waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { CAPTURE_DIR } from '../config/paths.js';
import { USER_SYSTEM_PROMPT_FILE_PATH, MIN_VALID_ANSWER_SIZE } from '../config/user-paths.js';
import { callAIWithRetry, createAiClientInstance } from '../utils/ai-caller.js';
import { interruptibleDelay as delay, isInterrupted } from '../utils/delay.js';
import { readQuestions, loadProjectModelConfigs, validateModelsAIPresetForProject } from '../utils/project-utils.js';
import { getTargetDateFromProjectOrEnvironment, getProjectNameFromCommandLine, validateAndLoadProject } from '../utils/project-utils.js';
import { logger } from '../utils/compact-logger.js';
import { ProgressTracker } from '../utils/compact-logger.js';
import { PipelineCriticalError, MissingConfigError } from '../utils/pipeline-errors.js';
// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
import { getCfgShortInfo } from '../utils/model-config.js';
import { ModelType } from '../utils/project-utils.js';

const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

// Configuration for concurrent requests and timeouts
const CONCURRENT_REQUESTS = 2; // Max number of parallel requests
const DEFAULT_REQUEST_DELAY_MS = 300; // Default delay between requests

// You can override these with environment variables
const getConcurrentRequests = () => {
  const envValue = process.env.AICW_CONCURRENT_REQUESTS;
  if (envValue) {
    const parsed = parseInt(envValue);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return CONCURRENT_REQUESTS;
};

const getDefaultRequestDelay = () => {
  const envValue = process.env.AICW_REQUEST_DELAY_MS;
  if (envValue) {
    const parsed = parseInt(envValue);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_REQUEST_DELAY_MS;
};

async function loadSystemPrompt(): Promise<string> {
  try {
    const systemPrompt = await fs.readFile(USER_SYSTEM_PROMPT_FILE_PATH, 'utf-8');
    return systemPrompt.trim();
  } catch (error) {
    // If system prompt file doesn't exist, return empty string
    logger.warn('System prompt file not found. Proceeding without system prompt.');
    return '';
  }
}

function isConfigurationError(error: any): boolean {
  // Check both the error and any wrapped original error
  const errorsToCheck = [error, error?.originalError].filter(Boolean);
  
  for (const err of errorsToCheck) {
    // Check for errors that indicate model configuration issues
    if (err?.status === 400 && err?.message) {
      // Invalid model ID error
      if (err.message.includes('is not a valid model ID')) {
        return true;
      }
    }
    
    if (err?.status === 429 && err?.message) {
      // Rate limit with specific messages about daily limits or free tier
      if (err.message.includes('Daily limit reached') || 
          err.message.includes('limit_rpd') ||
          err.message.includes(':free')) {
        return true;
      }
    }
    
    if (err?.status === 404 && err?.message) {
      // No endpoints found for model
      if (err.message.includes('No endpoints found')) {
        return true;
      }
    }
  }
  
  // Also check if the wrapped error message contains configuration error indicators
  if (error?.message) {
    if (error.message.includes('404 No endpoints found') ||
        error.message.includes('400') && error.message.includes('is not a valid model ID') ||
        error.message.includes('429') && (error.message.includes('Daily limit reached') || error.message.includes('limit_rpd'))) {
      return true;
    }
  }
  
  return false;
}

function getConfigurationErrorMessage(cfg: ModelConfig, error: any): string {
  const errorMsg = error?.message || error?.toString() || 'Unknown error';
  
  if (error?.status === 400 && errorMsg.includes('is not a valid model ID')) {
    return `\n❌ Configuration Error: ${getCfgShortInfo(cfg)} uses an invalid model ID.\n` +
           `   Error: ${errorMsg}\n` +
           `   Fix: Update the model ID in src/config/ai_models.json\n` +
           `   (for Open Router) See valid models at: https://openrouter.ai/models`;
  }
  
  if (error?.status === 429 && (errorMsg.includes('Daily limit reached') || errorMsg.includes('limit_rpd'))) {
    return `\n❌ Configuration Error: ${getCfgShortInfo(cfg)} has reached its daily limit.\n` +
           `   Error: ${errorMsg}\n` +
           `   Fix: Either:\n` +
           `     1. (for OpenRouter) Remove ':free' from the model ID in src/config/ai_models.json to use paid tier\n` +
           `     2. Add your own API keys as suggested in the error message\n`;
  }
  
  if (error?.status === 404 && errorMsg.includes('No endpoints found')) {
    return `\n❌ Configuration Error: ${getCfgShortInfo(cfg)} has no available endpoints.\n` +
           `   Error: ${errorMsg}\n` +
           `   Fix: Update to a valid model ID in src/config/ai_models.json\n` +
           `   For OpenRouter see valid models at: https://openrouter.ai/models`;
  }
  
  return `\n❌ Configuration Error for ${getCfgShortInfo(cfg)}:\n` +
         `   Error: ${errorMsg}\n` +
         `   Fix: Check the model configuration in src/config.ts`;
}

// Process items with concurrency control
async function processWithConcurrency<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  maxConcurrent: number
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const inProgress: Promise<void>[] = [];
  
  while (queue.length > 0 || inProgress.length > 0) {
    // Check for interruption before starting new tasks
    if (isInterrupted()) {
      throw new Error('Operation cancelled');
    }

    // Start new tasks up to the limit
    while (inProgress.length < maxConcurrent && queue.length > 0) {
      const item = queue.shift()!;
      const task = processor(item).then(result => {
        results.push(result);
      });
      inProgress.push(task);
    }
    
    // Wait for at least one task to complete
    if (inProgress.length > 0) {
      await Promise.race(inProgress);
      // Remove completed tasks
      for (let i = inProgress.length - 1; i >= 0; i--) {
        if (await Promise.race([inProgress[i], Promise.resolve('pending')]) !== 'pending') {
          inProgress.splice(i, 1);
        }
      }
    }
  }
  
  return results;
}


async function answerAlreadyExists(answerFile: string): Promise<{ exists: boolean; size?: number }> {
  try {
    const stats = await fs.stat(answerFile);
    // Check if file size meets minimum requirement
    if (stats.size >= MIN_VALID_ANSWER_SIZE) {
      const content = await fs.readFile(answerFile, 'utf-8');
      // Double-check content length after trimming
      if (content.trim().length >= MIN_VALID_ANSWER_SIZE) {
        // Also check if the JSON file exists
        const jsonFile = answerFile.replace(/\.md$/, '.json');
        try {
          await fs.stat(jsonFile);
          // Both files exist with valid content
          return { exists: true, size: stats.size };
        } catch {
          // MD exists but JSON doesn't - need to re-fetch to get JSON
          return { exists: false, size: stats.size };
        }
      }
    }
    // File exists but is too small
    return { exists: false, size: stats.size };
  } catch (error) {
    // File doesn't exist or can't be read
    return { exists: false };
  }
}

// Interface for the return value of fetchAnswer
interface FetchAnswerResult {
  success: boolean;  // The raw answer text content
  fullResponse: any;  // The complete API response object
}

async function fetchAnswer(cfg: ModelConfig, question: string, systemPrompt: string, tracker?: ProgressTracker): Promise<FetchAnswerResult> {

  if (!question) {
    throw new Error('Question is empty');
  }

  const aiClientInstance = createAiClientInstance(cfg);

  const messages: any[] = [];

  // Add system prompt if available
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  messages.push({ role: 'user', content: question });

  // Create a custom logger that updates the progress tracker
  const originalLogInfo = logger.info;
  const originalLogWarn = logger.warn;
  const originalLogDebug = logger.debug;

  // Temporarily override logger methods to update progress tracker
  if (tracker) {
    logger.info = (msg: string) => {
      tracker.logToFile('INFO', msg);
      // Extract retry delay from message for progress bar
      const delayMatch = msg.match(/Waiting (\d+)ms before retry/);
      if (delayMatch) {
        const delayMs = parseInt(delayMatch[1]);
        const briefMessage = `Rate limit - retry in ${(delayMs / 1000).toFixed(0)}s`;
        tracker.setStatus(briefMessage, delayMs + 1000);
      }
      originalLogInfo.call(logger, msg);
    };

    logger.warn = (msg: string) => {
      tracker.logToFile('WARN', msg);
      originalLogWarn.call(logger, msg);
    };

    logger.debug = (msg: string) => {
      tracker.logToFile('DEBUG', msg);
      originalLogDebug.call(logger, msg);
    };
  }

  try {
    // Use centralized retry logic
    const response = await callAIWithRetry(
      aiClientInstance,
      cfg,
      { model: cfg.model, messages },
      {
        cacheNamePrefix: CURRENT_MODULE_NAME,
        contextInfo: `Fetching answer from ${cfg.id} (model: ${cfg.model})`
      }
    );

    // Extract raw content - citation processing will be done by transform-answers-to-md step
    const nonEmptyAnswer: boolean = response.choices[0]?.message?.content !== undefined && 
      response.choices[0]?.message?.content !== null &&
      response.choices[0]?.message?.content !== '';

    return {
      success: nonEmptyAnswer,
      fullResponse: response
    };

  } finally {
    // Restore original logger methods
    if (tracker) {
      logger.info = originalLogInfo;
      logger.warn = originalLogWarn;
      logger.debug = originalLogDebug;
    }
  }
}

// Define task type for processing
interface FetchTask {
  question: QuestionEntry;
  model: ModelConfig;
  index: number;
  retryCount?: number;
}

// Track failed tasks for retry
interface FailedTask {
  task: FetchTask;
  error: any;
}

// Model-specific last request time tracking
const modelLastRequestTime = new Map<string, number>();

// Get the required delay for a specific model
function getModelDelay(model: ModelConfig): number {
  // Use default delay
  return getDefaultRequestDelay();
}

// Wait for model-specific rate limiting
async function waitForModelRateLimit(model: ModelConfig): Promise<void> {
  const requiredDelay = getModelDelay(model);
  if (requiredDelay <= 0) return;
  
  const lastRequestTime = modelLastRequestTime.get(model.id) || 0;
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < requiredDelay) {
    const waitTime = requiredDelay - timeSinceLastRequest;
    await delay(waitTime);
  }
  
  modelLastRequestTime.set(model.id, Date.now());
}

async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project); 
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);
  // Validate that all required API keys are configured
  await validateModelsAIPresetForProject(project, ModelType.GET_ANSWER);

  // Initialize logger
  await logger.initialize(import.meta.url, project);


  const date: string = new Date().toISOString().split('T')[0];
  const questions: QuestionEntry[] = await readQuestions(project);
  
  if (questions.length === 0) {
    logger.warn('No questions found. Please run "prepare" command first.');
    return;
  }

  // Load project-specific models or use defaults
  const aiModelsForAnswer = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);      

  // Load system prompt for including sources
  const systemPrompt = await loadSystemPrompt();
  
  const totalOperations = questions.length * aiModelsForAnswer.length;
  // Use compact mode for better visual feedback when not in verbose mode
  const useCompactProgress = process.env.AICW_VERBOSE !== 'true' && !process.env.CI;
  const tracker = new ProgressTracker(totalOperations, 'answers', useCompactProgress);
  const concurrentRequests = getConcurrentRequests();
  const defaultDelay = getDefaultRequestDelay();
  
  let startMessage = `Fetching answers for project "${project}" on ${date} (${concurrentRequests} concurrent requests`;
  if (defaultDelay > 0) {
    startMessage += `, ${defaultDelay}ms default delay`;
  }
  startMessage += ')';
  tracker.start(startMessage);
  const fileLogger = logger.getFileLogger();
  if (fileLogger) {
    tracker.setFileLogger(fileLogger);
  }
    
  let operationCount = 0;
  let successCount = 0;
  let skipCount = 0;
  let failureCount = 0;
  const configurationErrors: Map<string, string> = new Map();
  const failedTasks: FailedTask[] = [];

  // Create all tasks
  const tasks: FetchTask[] = [];
  let taskIndex = 0;
  for (const question of questions) {
    for (const model of aiModelsForAnswer) {
      tasks.push({ question, model, index: taskIndex++, retryCount: 0 });
    }
  }

  // Process tasks with concurrency control
  const processTask = async (task: FetchTask, isRetry: boolean = false): Promise<void> => {
    const { question: q, model: cfg, index } = task;
    const base: string = path.join(CAPTURE_DIR(project), q.folder, 'answers', date);
    await fs.mkdir(base, { recursive: true });
    
    if (!isRetry) {
      operationCount++;
    }
    
    // Skip this model if we've already detected a configuration error
    if (configurationErrors.has(cfg.id)) {
      tracker.update(operationCount, `${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - ${colorize('Skipped (Config Error)', 'red')}`);
      return;
    }
    
    const botFolder: string = path.join(base, cfg.id);
    await fs.mkdir(botFolder, { recursive: true });
    
    try {
      const answerFile = path.join(botFolder, 'answer.md');
      const answerCheck = await answerAlreadyExists(answerFile);
      
      if (answerCheck.exists) {
        tracker.update(operationCount, `${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - Already exists (${formatFileSize(answerCheck.size || 0)})`);
        skipCount++;
        return;
      } else if (answerCheck.size !== undefined && answerCheck.size > 0) {
        // File exists but is too small, log it and re-fetch
        logger.warn(`Answer file for ${q.folder}/${cfg.id} exists but is too small (${answerCheck.size} bytes < ${MIN_VALID_ANSWER_SIZE} bytes). Re-fetching...`);
      }
      
      // Apply model-specific rate limiting
      await waitForModelRateLimit(cfg);

      const statusPrefix = isRetry ? `${colorize('[RETRY]', 'yellow')} ` : '';
      tracker.update(operationCount, `${statusPrefix}${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - ${colorize('Fetching...', 'yellow')}`);

      // Start heartbeat timer to show progress during long API calls
      const fetchStartTime = Date.now();
      const heartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - fetchStartTime) / 1000);
        tracker.update(operationCount, `${statusPrefix}${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - ${colorize('Fetching...', 'yellow')} (${elapsed}s)`);
      }, 3000);

      let result;
      try {
        result = await fetchAnswer(cfg, q.question, systemPrompt, tracker);
      } finally {
        // Always clear the heartbeat timer
        clearInterval(heartbeat);
      }

      // Save the markdown answer with citations
      if(!result.success) {
        const msgEmptyResponse = `Empty response from ${q.folder}/${cfg.id}: ${result.fullResponse.choices[0]?.message?.content}`;
        logger.error(msgEmptyResponse);
        // throw new error to retry the task
        throw new Error(msgEmptyResponse);
      }

      // Save the full JSON response
      const jsonFile = path.join(botFolder, 'answer.json');
      await writeFileAtomic(jsonFile, JSON.stringify(result.fullResponse, null, 2));

      // Get stats for the JSON file we just saved (answer.md is created by transform step)
      const stats = await fs.stat(jsonFile);

      tracker.clearStatus(); // Clear any lingering status messages
      tracker.update(operationCount, `${statusPrefix}${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - Saved (${formatFileSize(stats.size)})`);
      successCount++;
    } catch (error: any) {
      // Check if this is a configuration error
      if (isConfigurationError(error)) {
        const errorMessage = getConfigurationErrorMessage(cfg, error);
        configurationErrors.set(cfg.id, errorMessage);
        tracker.update(operationCount, `${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - ${colorize('Config Error', 'red')}`);
        
        // Stop the tracker to show the error message
        tracker.stop();
        logger.error(errorMessage);

        // If we have configuration errors, stop execution
        logger.error(`\n${colorize('⛔ Execution stopped due to configuration errors.', 'red')}`);
        logger.error(`${colorize('Please fix the issues in src/config.ts and try again.', 'yellow')}\n`);
        throw new Error('Configuration errors detected');
      } else {
        // otherwise any other error falls here to try again
        // Extract brief error message for progress display
        const errorBrief = (error?.message || error?.toString() || 'Unknown error').substring(0, 60);
        tracker.update(operationCount, `${colorize(q.folder, 'dim')} / ${colorize(cfg.id, 'cyan')} - ${colorize('Failed', 'red')}: ${errorBrief}`);

        // Log the full error immediately so it's visible
        logger.error(`${q.folder}/${cfg.id}: ${error.message || error}`);

        // Track failed tasks for retry (but not if this is already a retry)
        if (!isRetry && task.retryCount === 0) {
          failedTasks.push({ task, error });
        } else {
          failureCount++;
        }
      }
    }
  };

  // Process all tasks with concurrency control
  await processWithConcurrency(tasks, processTask, concurrentRequests);

  // Retry failed tasks if any
  if (failedTasks.length > 0) {
    // Analyze common error patterns
    const errorCounts = new Map<string, number>();
    for (const { error } of failedTasks) {
      const errorKey = error?.message?.substring(0, 80) || 'Unknown error';
      errorCounts.set(errorKey, (errorCounts.get(errorKey) || 0) + 1);
    }

    // Show most common errors
    const topErrors = Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    logger.info(`\nRetrying ${failedTasks.length} failed tasks...`);
    if (topErrors.length > 0) {
      logger.info('Common errors:');
      for (const [errorMsg, count] of topErrors) {
        logger.info(`  • [${count}x] ${errorMsg}`);
      }
    }

    // Update tracker for retry phase
    tracker.stop();
    const retryTracker = new ProgressTracker(failedTasks.length, 'retry attempts');
    retryTracker.start(`Retrying ${failedTasks.length} failed answers`);
    
    let retryCount = 0;
    for (const { task, error } of failedTasks) {
      retryCount++;
      task.retryCount = (task.retryCount || 0) + 1;
      
      retryTracker.update(retryCount, `${colorize(task.question.folder, 'dim')} / ${colorize(task.model.id, 'cyan')} - ${colorize('Retrying...', 'yellow')}`);
      
      // Add extra delay before retry
      await delay(5000);
      
      try {
        await processTask(task, true);
        retryTracker.update(retryCount, `${colorize(task.question.folder, 'dim')} / ${colorize(task.model.id, 'cyan')} - ${colorize('Success on retry', 'green')}`);
      } catch (retryError: any) {
        failureCount++;
        const errorBrief = (retryError?.message || retryError?.toString() || 'Unknown error').substring(0, 60);
        retryTracker.update(retryCount, `${colorize(task.question.folder, 'dim')} / ${colorize(task.model.id, 'cyan')} - ${colorize('Failed on retry', 'red')}: ${errorBrief}`);
        logger.error(`Retry failed for ${task.question.folder} using ${task.model.id}: ${retryError}`);
      }
    }
    
    retryTracker.complete(`Retry complete: ${successCount - (totalOperations - skipCount - failureCount)} recovered`);
  }
  
  const finalFailureCount = totalOperations - successCount - skipCount;
  const summary = `Fetched ${successCount} answers, skipped ${skipCount} existing (>=${MIN_VALID_ANSWER_SIZE} bytes), ${finalFailureCount} failed`;
  
  if (failedTasks.length === 0) {
    tracker.complete(summary);
  } else {
    logger.success(summary);
  }
  
  if (skipCount > 0) {
    logger.success(`Skipped ${skipCount} existing answers that already meet the minimum size requirement (${MIN_VALID_ANSWER_SIZE} bytes)`);
  }
  
  if (finalFailureCount > 0) {
    logger.error(`\n⚠️  ${finalFailureCount} answers failed to fetch. You may want to:`);
    logger.info('  1. Check your API keys and rate limits');
    logger.info('  2. Adjust AICW_CONCURRENT_REQUESTS environment variable');
    logger.info('  3. Add model-specific delays in the configuration');
    logger.info('  4. Run the fetch command again to retry failed answers');
  }
  
  // Close file logger and inform user
  logger.info('Fetch process completed');
  // Show summary at the end
  await logger.showSummary();

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  if (err instanceof MissingConfigError) {
    logger.error('\n❌ Configuration Error:\n');
    logger.error(err.message);
    logger.error('\n💡 To fix this issue, please run:');
    logger.error('   aicw-ai-mentions setup-api-key\n');
    process.exit(2); // Exit code 2 = MissingConfigError
  } else if (err instanceof PipelineCriticalError) {
    logger.error(`\n❌ Pipeline Error in ${err.stepName}:`);
    logger.error(err.message);
    process.exit(1);
  } else {
    logger.error(err.message || err.toString());
    process.exit(1);
  }
});
