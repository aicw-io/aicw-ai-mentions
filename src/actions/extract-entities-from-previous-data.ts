/**
 * Extract Entities from Previous Data
 *
 * This action recovers missing entities by scanning previous dates with complete model coverage.
 * It merges entities that existed in previous dates but are missing from the current date,
 * preventing entity loss due to AI inconsistencies or temporary disappearances.
 *
 * Key Features:
 * - Only uses dates with complete answers from ALL models
 * - Configurable lookback window (MAX_PREVIOUS_DATES)
 * - Case-insensitive deduplication
 * - Transparent merge (no metadata added)
 * - Processes both individual questions and aggregated data
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DirentLike } from '../config/types.js';
import { QUESTIONS_DIR, QUESTION_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME, MAX_PREVIOUS_DATES } from '../config/constants.js';
import { MAIN_SECTIONS } from '../config/constants-entities.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { isInterrupted } from '../utils/delay.js';
import {
  loadDataJs,
  saveDataJs,
  getProjectNameFromCommandLine,
  getTargetDateFromProjectOrEnvironment,
  validateAndLoadProject
} from '../utils/project-utils.js';
import { PipelineCriticalError } from '../utils/pipeline-errors.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

/**
 * Find valid previous dates with complete model coverage.
 * Uses the existing getDatesWithCompleteAnswers function to ensure
 * only dates with full data are included.
 *
 * @param project - Project name
 * @param targetDate - Current target date
 * @returns Array of valid previous dates (descending order)
 */
async function findValidPreviousDates(
  project: string,
  targetDate: string
): Promise<string[]> {
  // Import here to avoid circular dependencies
  const { getDatesWithCompleteAnswers } = await import('../utils/project-utils.js');

  try {
    // Get all dates with complete answers (already sorted descending)
    const allCompleteDates = await getDatesWithCompleteAnswers(project);

    if (!allCompleteDates || allCompleteDates.length === 0) {
      logger.debug('No complete dates found in project');
      return [];
    }

    // Filter to dates before target date and take first MAX_PREVIOUS_DATES
    const previousDates = allCompleteDates
      .filter(date => date < targetDate)
      .slice(0, MAX_PREVIOUS_DATES);

    logger.debug(`Found ${previousDates.length} valid previous dates to scan (max: ${MAX_PREVIOUS_DATES})`);
    return previousDates;

  } catch (error: any) {
    logger.warn(`Could not get complete dates: ${error.message}`);
    return [];
  }
}

/**
 * Normalize entity value for case-insensitive comparison.
 *
 * @param value - Entity value (string or object with value property)
 * @returns Normalized lowercase trimmed string
 */
function normalizeEntityValue(value: string | any): string {
  const str = typeof value === 'string' ? value : (value?.value || '');
  return str.toLowerCase().trim();
}

/**
 * Merge missing entities from previous dates into current data.
 * Only adds entities that don't already exist (case-insensitive).
 *
 * @param currentData - Current date's data object
 * @param previousFiles - Array of previous data.js file paths (newest to oldest)
 * @returns Statistics about added entities
 */
async function mergeEntitiesFromPrevious(
  currentData: any,
  previousFiles: string[]
): Promise<{ added: number; sectionsProcessed: number }> {
  let totalAdded = 0;
  let sectionsProcessed = 0;

  // Process each MAIN_SECTION (products, organizations, etc.)
  for (const section of MAIN_SECTIONS) {
    if (!Array.isArray(currentData[section])) {
      logger.debug(`Skipping non-array section: ${section}`);
      continue;
    }

    sectionsProcessed++;

    // Build Set of existing normalized values for deduplication
    const existingNormalized = new Set<string>();
    for (const item of currentData[section]) {
      const normalized = normalizeEntityValue(item);
      if (normalized) {
        existingNormalized.add(normalized);
      }
    }

    logger.debug(`Section ${section}: ${currentData[section].length} existing entities`);

    // Scan previous dates (newest to oldest)
    for (const prevFile of previousFiles) {
      try {
        // Check if file exists before attempting to load
        await fs.access(prevFile);

        const { data: prevData } = await loadDataJs(prevFile);

        if (!Array.isArray(prevData[section])) {
          continue;
        }

        // Find missing entities from this previous date
        for (const prevItem of prevData[section]) {
          const prevValue = prevItem.value || prevItem;

          // Skip empty values
          if (!prevValue || typeof prevValue !== 'string') {
            continue;
          }

          const normalized = normalizeEntityValue(prevValue);

          // Add if not already present
          if (normalized && !existingNormalized.has(normalized)) {
            // Add as normalized object format, preserving type from previous data
            currentData[section].push({
              value: prevValue,
              type: prevItem.type || 'unknown'
            });

            existingNormalized.add(normalized);
            totalAdded++;
          }
        }

      } catch (error: any) {
        // Silently skip files that don't exist or can't be loaded
        logger.debug(`Could not load previous file ${prevFile}: ${error.message}`);
      }
    }
  }

  return { added: totalAdded, sectionsProcessed };
}

/**
 * Main function: Extract entities from previous dates and merge into current date.
 * Processes all question directories including aggregated data.
 *
 * @param project - Project name
 * @param targetDate - Current target date
 */
export async function extractEntitiesFromPreviousData(
  project: string,
  targetDate: string
): Promise<void> {
  logger.info(`Starting entity recovery from previous dates for project: ${project}`);

  // 1. Get valid previous dates (with complete model coverage)
  const previousDates = await findValidPreviousDates(project, targetDate);

  if (previousDates.length === 0) {
    logger.info(`No previous complete dates found to scan (this is normal for new projects)`);
    await logger.showSummary();
    return;
  }

  logger.info(`Will scan ${previousDates.length} previous complete dates: ${previousDates.slice(0, 3).join(', ')}${previousDates.length > 3 ? '...' : ''}`);

  // 2. Get all question directories
  const baseQ: string = QUESTIONS_DIR(project);

  try {
    const questionDirs: DirentLike[] = await fs.readdir(baseQ, { withFileTypes: true }) as DirentLike[];
    logger.debug(`Found ${questionDirs.length} items in questions directory`);

    // Include both regular questions and aggregated directory
    const directories = questionDirs.filter(dirent => dirent.isDirectory());
    logger.info(`Found ${directories.length} directories to process (including aggregated)`);

    // Start progress tracking
    logger.startProgress(directories.length, 'questions');

    let processedCount = 0;
    let totalAdded = 0;
    let currentIndex = 0;

    // 3. Process each question directory
    for (const dirent of directories) {
      // Check for interruption at the start of each iteration
      if (isInterrupted()) {
        logger.info('Operation cancelled by user, stopping batch processing...');
        throw new Error('Operation cancelled');
      }

      if (!dirent.isDirectory()) {
        logger.warn(`Skipping non-directory item: ${dirent.name}`);
        continue;
      }

      currentIndex++;
      logger.updateProgress(currentIndex, `Processing ${dirent.name}...`);

      try {
        // Get current date's data file
        const compiledDir: string = QUESTION_DATA_COMPILED_DATE_DIR(project, dirent.name, targetDate);
        const currentFile = path.join(compiledDir, `${targetDate}-data.js`);

        // Check if current file exists
        try {
          await fs.access(currentFile);
        } catch (error) {
          logger.debug(`No data file for ${dirent.name} at ${currentFile}, skipping`);
          continue;
        }

        logger.debug(`Loading current data from: ${currentFile}`);

        // Load current data
        const { data: currentData, dataKey } = await loadDataJs(currentFile);

        // Build list of previous data.js files for this question
        const previousFiles: string[] = [];
        for (const date of previousDates) {
          const prevCompiledDir = QUESTION_DATA_COMPILED_DATE_DIR(project, dirent.name, date);
          const prevFile = path.join(prevCompiledDir, `${date}-data.js`);
          previousFiles.push(prevFile);
        }

        logger.debug(`Looking for ${previousFiles.length} previous data files for ${dirent.name}`);

        // Merge missing entities from previous dates
        const { added, sectionsProcessed } = await mergeEntitiesFromPrevious(
          currentData,
          previousFiles
        );

        if (added > 0) {
          // Save updated data
          logger.debug(`Saving updated data with ${added} previous date entities merged to: ${currentFile}`);
          await saveDataJs(currentFile, dataKey, currentData);

          logger.updateProgress(currentIndex, `${dirent.name} - Added ${added} entities ✓`);
          logger.info(`Successfully merged ${added} previous date entities for "${dirent.name}"`);
          totalAdded += added;
        } else {
          logger.updateProgress(currentIndex, `${dirent.name} - No missing entities ✓`);
          logger.debug(`No missing entities found for "${dirent.name}"`);
        }

        processedCount++;

      } catch (error) {
        // Check if operation was cancelled by user
        if (error instanceof Error && error.message === 'Operation cancelled') {
          throw error; // Re-throw to stop the entire batch
        }

        logger.error(`Error processing ${dirent.name}: ${error instanceof Error ? error.message : String(error)}`);
        throw new PipelineCriticalError(
          `Error processing ${dirent.name}: ${error instanceof Error ? error.message : String(error)}`,
          CURRENT_MODULE_NAME,
          dirent.name
        );
      }
    }

    // Complete progress
    logger.completeProgress(`Merged ${totalAdded} previous date entities from ${previousDates.length} previous dates`);

    // Add summary stats
    logger.addStat('Directories Processed', processedCount);
    logger.addStat('Entities Recovered', totalAdded);
    logger.addStat('Previous Dates Scanned', previousDates.length);

    logger.info(`Entity recovery complete. Total recovered: ${totalAdded}`);
    await logger.showSummary();

  } catch (error) {
    logger.error(`Failed to read questions directory: ${error instanceof Error ? error.message : String(error)}`);
    throw new PipelineCriticalError(
      `Failed to read questions directory: ${error instanceof Error ? error.message : String(error)}`,
      CURRENT_MODULE_NAME,
      project
    );
  }
}

/**
 * Main entry point when run as standalone script
 */
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  // Initialize logger
  await logger.initialize(import.meta.url, project);

  await extractEntitiesFromPreviousData(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
