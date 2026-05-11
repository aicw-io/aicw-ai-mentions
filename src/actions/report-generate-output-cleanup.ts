/**
 * Cleanup Report Output - Removes old report files from target date only
 *
 * This action prepares for report generation by cleaning output files for the target date.
 * It ensures a clean slate for each report generation cycle.
 *
 * What gets deleted:
 * - OUTPUT/<target-date>/*.html files
 * - OUTPUT/<target-date>/*.js files (data, app, answers)
 * - OUTPUT/<target-date>/question-folders/ (all subdirectories)
 * - Backup/temp files (*.bak, *~, .DS_Store)
 *
 * What is PRESERVED:
 * - OUTPUT/<other-dates>/ (reports for other dates)
 * - OUTPUT/index.html (project-level navigation)
 * - OUTPUT/.navigation-meta.json
 * - data-compiled/ folders (source data)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { OUTPUT_DIR } from '../config/paths.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { getProjectNameFromCommandLine, getTargetDateFromProjectOrEnvironment, validateAndLoadProject } from '../utils/project-utils.js';
import { PipelineCriticalError } from '../utils/pipeline-errors.js';
// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

/**
 * Check if file should be preserved (not deleted)
 */
function shouldPreserveFile(filename: string): boolean {
  // Preserve navigation metadata
  if (filename === '.navigation-meta.json') {
    return true;
  }

  return false;
}

/**
 * Recursively delete directory contents
 */
async function deleteDirectoryContents(dirPath: string): Promise<number> {
  let deletedCount = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively delete subdirectory
        deletedCount += await deleteDirectoryContents(fullPath);
        await fs.rmdir(fullPath);
        deletedCount++;
        logger.debug(`Deleted directory: ${entry.name}`);
      } else {
        // Delete file
        await fs.unlink(fullPath);
        deletedCount++;
        logger.debug(`Deleted file: ${entry.name}`);
      }
    }
  } catch (error) {
    logger.warn(`Could not delete contents of ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return deletedCount;
}

/**
 * Clean the output directory for the target date
 */
async function cleanOutputDirectory(project: string, targetDate: string): Promise<void> {
  const { validatePathIsSafe } = await import('../utils/misc-utils.js');
  const outputDir = OUTPUT_DIR(project);

  logger.info(`Cleaning report output directory: ${outputDir}`);

  // SECURITY: Validate path is safe and inside USER_DATA_DIR before ANY deletion
  await validatePathIsSafe(outputDir, `report cleanup for project: ${project}, date: ${targetDate}`);

  try {
    // Check if output directory exists
    const dirExists = await fs.access(outputDir).then(() => true).catch(() => false);

    if (!dirExists) {
      logger.info(`Output directory does not exist yet: ${outputDir}`);
      logger.info(`This is normal for first-time report generation.`);
      return;
    }

    let deletedFiles = 0;
    let deletedDirs = 0;
    let preservedFiles = 0;

    // Read all entries in the output directory
    const entries = await fs.readdir(outputDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(outputDir, entry.name);

      // Check if file should be preserved
      if (shouldPreserveFile(entry.name)) {
        preservedFiles++;
        logger.debug(`Preserving: ${entry.name}`);
        continue;
      }

      try {
        if (entry.isDirectory()) {
          // Delete entire subdirectory (question folders)
          const deleted = await deleteDirectoryContents(fullPath);
          await fs.rmdir(fullPath);
          deletedDirs++;
          deletedFiles += deleted;
          logger.debug(`Removed directory and ${deleted} files: ${entry.name}`);
        } else {
          // Delete file (HTML, JS, backups, etc.)
          await fs.unlink(fullPath);
          deletedFiles++;
          logger.debug(`Deleted file: ${entry.name}`);
        }
      } catch (error) {
        logger.warn(`Could not delete ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    logger.info(`Cleanup complete:`);
    logger.info(`  Files deleted: ${deletedFiles}`);
    logger.info(`  Directories deleted: ${deletedDirs}`);
    if (preservedFiles > 0) {
      logger.info(`  Files preserved: ${preservedFiles}`);
    }

  } catch (error) {
    throw new PipelineCriticalError(
      `Failed to clean output directory: ${error instanceof Error ? error.message : String(error)}`,
      CURRENT_MODULE_NAME,
      project
    );
  }
}

async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  // Initialize logger
  await logger.initialize(import.meta.url, project);

  logger.info(`Starting report output cleanup for project: ${project}, date: ${targetDate}`);

  await cleanOutputDirectory(project, targetDate);

  await logger.showSummary();
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
