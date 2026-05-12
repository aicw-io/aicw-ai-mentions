import { spawn, ChildProcess } from 'child_process';
import { readFileSync, promises as fs } from 'fs';
import path from 'path';
import { getPackageRoot } from './config/user-paths.js';
import * as readline from 'readline';
import { loadEnvFile, drawBox, waitForEnterInInteractiveMode, getModuleNameFromUrl, createCleanReadline } from './utils/misc-utils.js';
import { logger } from './utils/compact-logger.js';
import { output } from './utils/output-manager.js';
import { getUpdateNotification, getCurrentVersion } from './utils/update-checker.js';
import { performUpdate, showVersion } from './utils/update-installer.js';
import { getCliMenuItems, getActionByCommand, CliMenuItem, getPipeline, getCategoriesInOrder, getCategory } from './config/pipelines-and-actions.js';
import { PipelineExecutor, ExecutionOptions, ExecutionResult } from './utils/pipeline-executor.js';
import { stopServer, isServerRunning, getServerPort } from './actions/utils/report-serve.js';
import { initializeUserDirectories } from './config/user-paths.js';
import { PipelineCriticalError } from './utils/pipeline-errors.js';
import { COLORS } from './utils/misc-utils.js';
import { AICW_GITHUB_URL } from './config/constants.js';
import { WaitForEnterMessageType } from './utils/misc-utils.js';
import { getTargetDateArg, resolveCommandAlias } from './utils/cli-commands.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);
const SUPPORTED_API_KEY_ENV_NAMES = [
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PERPLEXITY_API_KEY',
];

function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

// Menu state management to avoid recursive calls
enum MenuState {
  MAIN = 'main',
  ADVANCED = 'advanced',
  EXIT = 'exit',
  CONTINUE = 'continue'
}

// Track current child process for interrupt handling
let currentChildProcess: ChildProcess | null = null;

// Helper function for interruptible command execution
async function runInterruptible(
  args: string[],
  showHint: boolean = true,
  pipelineContext?: { currentStep: number, totalSteps: number }
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // Show interrupt hint unless disabled
    if (showHint) {
      output.writeLine(colorize('\n💡 Press Ctrl+C to cancel operation and return to menu', 'dim'));
    }

    // Set environment variable to indicate we're running from interactive mode
    const env: any = { ...process.env, AICW_INTERACTIVE_MODE: 'true' };

    // Add pipeline context if provided
    if (pipelineContext) {
      env.AICW_PIPELINE_STEP = String(pipelineContext.currentStep);
      env.AICW_PIPELINE_TOTAL_STEPS = String(pipelineContext.totalSteps);
    }

    currentChildProcess = spawn('node', args, { stdio: 'inherit', env });

    currentChildProcess.on('exit', (code) => {
      currentChildProcess = null;
      if (code === 0) {
        resolve(true);
      } else if (code === null) {
        // Process was killed (SIGINT)
        reject(new Error('Operation cancelled'));
      } else {
        resolve(false);
      }
    });

    currentChildProcess.on('error', (err) => {
      currentChildProcess = null;
      reject(err);
    });
  });
}

// Helper function to stop the web server
function stopWebServer(): boolean {
  if (!isServerRunning()) {
    return false;
  }

  stopServer(); // Call real server stop function
  output.success('Server stopped');
  return true;
}

function printHeader(): void {
  const version = getCurrentVersion();
  output.writeLine(colorize(`\n🤖 aicw-ai-mentions ${version} - https://github.com/aicw-io/aicw-ai-mentions `, 'bright'));

  // Show update notification if available
  const updateNotification = getUpdateNotification();
  if (updateNotification) {
    output.writeLine(colorize('   ' + updateNotification + '\n', 'yellow'));
  }
}

async function printHelp(): Promise<void> {
  printHeader();
  // output content of QUICK-START.md
  const quickStartPath = path.join(getPackageRoot(), 'README.md');
  const quickStartContent = readFileSync(quickStartPath, 'utf8');
  output.writeLine(quickStartContent);

  // now also write the list of available pipelines
  output.writeLine(colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim'));
  output.writeLine(colorize('Common commands:\n', 'yellow'));
  output.writeLine(`  ${colorize('aicw-ai-mentions scan "Stripe"', 'bright')} - create and run a perception scan`);
  output.writeLine(`  ${colorize('aicw-ai-mentions serve', 'bright')} - open the local reports server`);
  output.writeLine(`  ${colorize('aicw-ai-mentions mcp', 'bright')} - start the local MCP server over stdio`);
  output.writeLine('');

  const allPipelines = getCliMenuItems(false);
  output.writeLine(colorize('Available pipelines:\n', 'yellow'));
  
  // Group pipelines by category
  const grouped = new Map<string, typeof allPipelines>();
  for (const pipeline of allPipelines) {
    const category = pipeline.category;
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category)!.push(pipeline);
  }

  // Display pipelines grouped by category
  for (const [category, pipelines] of grouped) {
    output.writeLine(colorize(`➡ ${category.toUpperCase()}:`, 'cyan'));
    for (const pipeline of pipelines) {
      output.writeLine(`  ${colorize(`[${pipeline.id}] ${pipeline.name} - ${pipeline.description}`, 'dim')}`);
      const usage = pipeline.requiresProject
        ? `aicw-ai-mentions ${pipeline.id} <project-name>`
        : `aicw-ai-mentions ${pipeline.id}`;
      output.writeLine(`  To run use: ${colorize(usage, 'bright')}`);
      output.writeLine('');
    }
  }
  output.writeLine(colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim'));

    // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode(WaitForEnterMessageType.PRESS_ENTER_TO_THE_MENU, true);
}

async function printLicense(): Promise<void> {
  printHeader();
  const licensePath = path.join(getPackageRoot(), 'LICENSE');
  const licenseContent = readFileSync(licensePath, 'utf8');  // eslint-disable-line @typescript-eslint/no-unsafe-call
  output.writeLine(licenseContent);

  output.writeLine(colorize('For more information:', 'dim'));
  output.writeLine(`${colorize(AICW_GITHUB_URL, 'blue')}\n`);
  await waitForEnterInInteractiveMode(WaitForEnterMessageType.PRESS_ENTER_TO_THE_MENU, true);
}

async function checkApiKeysArePresent(): Promise<boolean> {
  // Load environment to check API key
  await loadEnvFile();
  const hasApiKey = SUPPORTED_API_KEY_ENV_NAMES.some((key) => Boolean(process.env[key]));

  if (!hasApiKey) {
    output.writeLine('----!!!!!!!-------------------------');
    output.writeLine(colorize('⚠️  No API keys were set! Please run "aicw-ai-mentions setup-api-key" first and then try again.', 'red'));
    output.writeLine(colorize(`Supported environment keys: ${SUPPORTED_API_KEY_ENV_NAMES.join(', ')}\n`, 'dim'));
    output.writeLine('----!!!!!!!------------------------');
    return false;
  }  
  else { 
    return true
  };

}

async function showInteractiveMenu(showHeader: boolean = true, showAdvanced: boolean = false): Promise<MenuState> {
  if (showHeader) {
    printHeader();
  }
  // Show update notification if available
  const updateNotification = getUpdateNotification();
  if (updateNotification) {
    output.writeLine('\n' + colorize(updateNotification, 'yellow'));
    output.writeLine(colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim'));
  }

  // Get all CLI menu items dynamically
  const allMenuItems = getCliMenuItems(showAdvanced);

  // Separate normal and advanced pipelines
  const normalPipelines = allMenuItems.filter(p => p.type !== 'advanced');
  const advancedPipelines = allMenuItems.filter(p => p.type === 'advanced');

  // Build menu items map with smart numbering
  const menuMap = new Map<string, CliMenuItem>();
  const usedIds = new Set<number>();
  let autoNumberCounter = 1;

  // First pass: assign items with menuItemId
  for (const item of normalPipelines) {
    if (item.menuItemId) {
      if (usedIds.has(item.menuItemId)) {
        output.writeLine(colorize(`Warning: Duplicate menuItemId ${item.menuItemId} for ${item.id}`, 'yellow'));
        continue;
      }
      menuMap.set(String(item.menuItemId), item);
      usedIds.add(item.menuItemId);
    }
  }

  // Second pass: auto-assign remaining items
  const itemsNeedingNumbers: CliMenuItem[] = [];
  for (const item of normalPipelines) {
    if (!item.menuItemId) {
      itemsNeedingNumbers.push(item);
    }
  }

  // Assign auto numbers to items without menuItemId
  for (const item of itemsNeedingNumbers) {
    // Find next available number (skip reserved IDs)
    while (usedIds.has(autoNumberCounter) && autoNumberCounter < 900) {
      autoNumberCounter++;
    }
    menuMap.set(String(autoNumberCounter), item);
    usedIds.add(autoNumberCounter);
    autoNumberCounter++;
  }

  // Display menu grouped by category
  const categories = getCategoriesInOrder();
  const pipelinesByCategory = new Map<string, Array<{id: string, item: CliMenuItem}>>();

  // Group items by category with their menu IDs
  for (const [menuId, item] of menuMap.entries()) {
    const categoryId = item.category;
    if (!pipelinesByCategory.has(categoryId)) {
      pipelinesByCategory.set(categoryId, []);
    }
    pipelinesByCategory.get(categoryId)!.push({id: menuId, item});
  }

  // Display pipelines by category in defined order
  for (const category of categories) {
    const pipelines = pipelinesByCategory.get(category.id);
    if (pipelines && pipelines.length > 0) {
      // Sort by menu ID within category
      pipelines.sort((a, b) => Number(a.id) - Number(b.id));

      output.writeLine('\n' + colorize(`${category.icon} ${category.name}:`, 'yellow'));
      for (const {id, item} of pipelines) {
        output.writeLine(`[${id}] ` + colorize(item.name, 'cyan') + ` - ${item.description}`);
      }
    }
  }

  // Display Advanced Pipelines
  if (advancedPipelines.length > 0 && showAdvanced) {
    output.writeLine('\n' + colorize('🔧 ADVANCED PIPELINES:', 'yellow'));
    let advancedCounter = 1000;
    for (const pipeline of advancedPipelines) {
      const numStr = String(pipeline.menuItemId || advancedCounter++);
      menuMap.set(numStr, pipeline);
      output.writeLine(`[${numStr}] ` + colorize(pipeline.name, 'cyan') + ` - ${pipeline.description}`);
    }
  }

  output.writeLine('[0] ' + colorize('Exit', 'cyan') + ' - Exit\n');

  // Display server status if running
  if (isServerRunning()) {
    const serverPort = getServerPort() || 8080;
    output.writeLine(colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim'));
    output.writeLine(colorize('📍 AI Mentions server running at: ', 'green') + colorize(`http://localhost:${serverPort}/`, 'bright'));
    output.writeLine(colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim') + '\n');
  }

  // Calculate max choice from menu map
  const maxChoice = Math.max(...Array.from(menuMap.keys()).map(k => Number(k)));
  const rl = createCleanReadline();

  return new Promise((resolve) => {
    rl.question(`Enter your choice and press Enter (0-${maxChoice}): `, async (choice) => {
      rl.close();
      process.stdin.pause();

      const choiceStr = choice.trim();

      // Handle exit
      if (choiceStr === '0') {
        if (isServerRunning()) {
          output.writeLine(colorize('\nStopping web server...', 'dim'));
          stopWebServer();
        }
        const version = getCurrentVersion();
        output.writeLine(colorize(`\nBye! 👋 Thanks for using aicw-ai-mentions! ${version}`, 'green'));
        resolve(MenuState.EXIT);
        return;
      }

      // Handle dynamic menu items
      const menuItem = menuMap.get(choiceStr);

      if (menuItem) {
        try {
          // Handle special meta-commands that don't run pipelines
          if (menuItem.id === 'help') {
            await printHelp();
            resolve(MenuState.CONTINUE);
            return;
          }

          if (menuItem.id === 'license') {
            await printLicense();
            resolve(MenuState.CONTINUE);
            return;
          }

          // Handle regular pipelines
          output.writeLine(colorize(`\n🚀 ${menuItem.name}`, 'green'));
          output.writeLine(colorize(`📋 ${menuItem.description}\n`, 'dim'));

          await executePipelineForMenuItem(menuItem.id);

          await waitForEnterInInteractiveMode(WaitForEnterMessageType.PRESS_ENTER_TO_THE_MENU, true);

        } catch (error: any) {
          output.writeLine(colorize(`\n✗ Error: ${error.message}`, 'red'));
        }

        resolve(MenuState.CONTINUE);
        return;
      }

      // Invalid choice
      console.error(colorize('\n✗ Invalid choice\n', 'red'));
      resolve(MenuState.CONTINUE);
    });
  });
}

async function executePipelineForMenuItem(pipelineId: string, project?: string): Promise<ExecutionResult> {

  // Initialize user directories on first run (moved from post-install)
  try {
    initializeUserDirectories();  
  } catch (error) {
    logger.error(`Warning: Could not create user directories: ${error.message}`);
    throw new PipelineCriticalError('Could not create user directories', 
      CURRENT_MODULE_NAME,
      error
    );
  }

  const pipeline = getPipeline(pipelineId);

  const executor = new PipelineExecutor(''); // empty project means it will show project selector if needed
  const executionOptions: ExecutionOptions = { project: project || '' };
  // run the pipeline
  const executionResult: ExecutionResult = await executor.execute(pipelineId, executionOptions);

  // only run next pipeline if the current pipeline was successful
  let runNextPipeline = executionResult.success && pipeline.nextPipeline && pipeline.nextPipeline.length > 0;

  if (runNextPipeline) {

      const nextPipeline = getPipeline(pipeline.nextPipeline);
      // run the next pipeline
      logger.log('--------------------------------');
      logger.log(`IMPORTANT: Next we will run the pipeline "${pipeline.nextPipeline}" (parent: "${pipelineId}") for the project "${executionResult.project}"
        \nDescription of the next pipeline: ${nextPipeline.description}`);
      logger.log('--------------------------------');
      runNextPipeline = await waitForEnterInInteractiveMode(WaitForEnterMessageType.PRESS_ENTER_TO_CONTINUE, true);
  }
  if (runNextPipeline) {
      const ExecutionResultNext: ExecutionResult = await executePipelineForMenuItem(pipeline.nextPipeline, executionResult.project);
      if (!ExecutionResultNext.success) {
        logger.error(`Failed to run the pipeline "${pipeline.nextPipeline}" (parent: "${pipelineId}") for project "${executionResult.project}"
        \nPlease try again by selecting the pipeline "${pipeline.nextPipeline}" from the main menu.
          `);
      }
      return ExecutionResultNext;
  }
  else {
    // if no pipeline to run next, wait for user input and return back to the caller
    return executionResult;
  }
}

function pipelineChainRequiresApiKeys(pipelineId: string, seen = new Set<string>()): boolean {
  if (seen.has(pipelineId)) {
    return false;
  }

  seen.add(pipelineId);
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) {
    return false;
  }

  return Boolean(
    pipeline.requiresApiKeys ||
    (pipeline.nextPipeline && pipelineChainRequiresApiKeys(pipeline.nextPipeline, seen))
  );
}

async function executePipelineChain(
  pipelineId: string,
  executor: PipelineExecutor,
  options: ExecutionOptions
): Promise<ExecutionResult> {
  let currentPipeline = getPipeline(pipelineId);
  if (!currentPipeline) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  let result = await executor.execute(currentPipeline.id, options);

  while (result.success && currentPipeline.nextPipeline) {
    const nextPipeline = getPipeline(currentPipeline.nextPipeline);
    if (!nextPipeline) {
      throw new Error(`Pipeline not found: ${currentPipeline.nextPipeline}`);
    }

    output.writeLine(colorize(`\n→ Continuing with ${nextPipeline.name}`, 'green'));
    output.writeLine(colorize(`📋 ${nextPipeline.description}\n`, 'dim'));

    result = await executor.execute(nextPipeline.id, options);
    currentPipeline = nextPipeline;
  }

  return result;
}

// Main menu loop - runs continuously until user chooses to exit
async function runMenuLoop(showAdvanced: boolean = false): Promise<void> {
  // Load encrypted credentials into process.env before showing menu
  await loadEnvFile();

  let currentState = MenuState.MAIN;
  let isFirstRun = true;

  while (currentState !== MenuState.EXIT) {
    try {
      switch (currentState) {
        case MenuState.MAIN:
        case MenuState.CONTINUE:
          currentState = await showInteractiveMenu(isFirstRun, showAdvanced);
          isFirstRun = false;
          break;
        default:
          currentState = MenuState.MAIN;
      }
    } catch (error) {
      // This is our safety net - log error and continue
      console.error('\n❌ An error occurred:', error instanceof Error ? error.message : error);
      output.writeLine('\n↩️  Returning to menu...\n');
      await waitForEnterInInteractiveMode(WaitForEnterMessageType.PRESS_ENTER_TO_THE_MENU, true);
      currentState = MenuState.MAIN;
      isFirstRun = false; // Don't show header after errors
    }
  }

  process.exit(0);
}

/**
 * Show npx welcome message if running via npx
 */
function showNpxWelcomeIfNeeded(): void {
  if (process.env.AICW_RUNNING_VIA_NPX === 'true') {
    output.writeLine('');
    output.writeLine(colorize('💡 Thanks for trying aicw-ai-mentions!', 'cyan'));
    output.writeLine(colorize('   To install globally: npm install -g aicw-ai-mentions', 'dim'));
    output.writeLine('');
  }
}

// Main execution
async function main(): Promise<void> {
  // Setup interrupt handler for graceful cancellation
  process.on('SIGINT', () => {
    if (currentChildProcess) {
      // Kill child process, which will trigger the rejection in runInterruptible
      currentChildProcess.kill('SIGINT');
      // Don't exit - let the error handling return to menu
    } else if (isServerRunning()) {
      // Stop the server if it's running
      stopWebServer();
      output.writeLine(colorize('\n↩️ Server stopped, returning to menu...', 'yellow'));
      // Don't exit - return to menu
    } else {
      // No operation running, exit normally
      process.exit(0);
    }
  });

  const allArgs = process.argv.slice(2);
  const showAdvanced = allArgs.includes('--advanced');

  const [command, projectArg, ...args]: string[] = allArgs;
  let project = projectArg;

  // Start MCP before normal CLI output/env loading so stdio transport remains
  // clean JSON-RPC for MCP clients.
  if (command === 'mcp' || command === 'mcp-server') {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer([projectArg, ...args].filter((arg): arg is string => Boolean(arg)));
    return;
  }

  // Show interactive menu if no command or --advanced flag only
  if (!command || command === '--advanced') {
    await runMenuLoop(showAdvanced);
    return;
  }
  
  // Show help if requested
  if (command === 'help' || command === '--help' || command === '-h') {
    await printHelp();
    showNpxWelcomeIfNeeded();
    return;
  }

  // Show license information
  if (command === 'license' || command === '--license') {
    await printLicense();
    showNpxWelcomeIfNeeded();
    return;
  }

  // Show version information
  if (command === 'version' || command === '--version' || command === '-v') {
    showVersion();
    showNpxWelcomeIfNeeded();
    return;
  }

  // Handle update command
  if (command === 'update' || command === 'u') {
    printHeader();
    await performUpdate();
    showNpxWelcomeIfNeeded();
    return;
  }
  // Load environment variables before checking environment
  await loadEnvFile();
  // Resolve command alias
  const resolvedCommand = resolveCommandAlias(command);

  // Check if command is a pipeline
  const pipeline = getPipeline(resolvedCommand);
  if (pipeline) {
    printHeader();
    output.writeLine(colorize(`\n🚀 ${pipeline.name}`, 'green'));
    output.writeLine(colorize(`📋 ${pipeline.description}\n`, 'dim'));

    // Extract --date argument if provided and pass it via environment variable
    const targetDate = getTargetDateArg(args);

    const executorOptions: ExecutionOptions = {  };
    if (targetDate) {
      executorOptions.env = { AICW_TARGET_DATE: targetDate };
    }
    if (pipeline.id === 'new') {
      executorOptions.actionArgs = { 'project-new': args };
    }

    // for command line mode before executing a pipeline always check for api keys
    // check if requried API keys are set
    if (pipelineChainRequiresApiKeys(pipeline.id) && !await checkApiKeysArePresent()) {
      console.error(colorize(`\n✗ Oops! API keys are not set. Please run "aicw-ai-mentions setup-api-key" to set the API keys.`, 'red'));
      console.error(colorize(`Try "aicw-ai-mentions help" to see what I can do.`, 'dim'));
      process.exit(1);
    }

    const executor = new PipelineExecutor(project);
    const result = await executePipelineChain(pipeline.id, executor, executorOptions);
    showNpxWelcomeIfNeeded();
    process.exit(result.success ? 0 : 1);
  }

  // SPECIAL COMMANDS
  switch (resolvedCommand) {
    default:
      console.error(colorize(`\n✗ Oops! I don't know the command or a pipeline "${command}"`, 'red'));
      console.error(colorize(`Try "aicw-ai-mentions help" to see what I can do.`, 'dim'));
      process.exit(1);
  }
}

main().catch(err => {
  console.error(colorize('\n✗ Unexpected error:', 'red'), err);
  // Don't exit - let global error handlers deal with it
});
