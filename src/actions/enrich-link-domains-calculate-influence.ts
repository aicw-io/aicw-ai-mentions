import { promises as fs } from 'fs';
import path from 'path';
import vm from 'node:vm';
import { DirentLike } from '../config/types.js';
import { QuestionEntry } from '../config/types.js';
import { QUESTIONS_DIR, QUESTION_DATA_COMPILED_DATE_DIR, PROJECT_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { waitForEnterInInteractiveMode, writeFileAtomic } from '../utils/misc-utils.js';
import { logger } from '../utils/compact-logger.js';
import { cleanContentFromAI } from '../utils/content-cleaner.js';
import {   getTargetDateFromProjectOrEnvironment, getProjectNameFromCommandLine, validateAndLoadProject  } from '../utils/project-utils.js';
import { loadDataJs, saveDataJs, readQuestions } from '../utils/project-utils.js';
import { PipelineCriticalError, createMissingFileError, createMissingDataError } from '../utils/pipeline-errors.js';
import { prepareStepFiles, normalizeAggregatedInfluences } from '../utils/enrich-data-utils.js';
import { ModelType } from '../utils/project-utils.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


/**
 * Calculate influence statistics for linkDomains
 * Calculates influence statistics for source domains.
 */
function calculateInfluenceForLinkDomains(linkDomains: any[]): void {
  logger.debug('Calculating influence for linkDomains');

  // Calculate influence for each linkDomain
  linkDomains.forEach(item => {
    // Initialize influence properties
    item.influence = 0;
    item.influenceByModel = {};
    item.weightedInfluence = 0;

    // Aggregate influence from individual sources
    if (item.sources && Array.isArray(item.sources)) {
      for (const source of item.sources) {
        // Aggregate influence
        item.influence += source.influence || 0;
        item.weightedInfluence += source.weightedInfluence || source.influence || 0;

        // Aggregate influence by model
        if (source.influenceByModel) {
          for (const [modelId, influence] of Object.entries(source.influenceByModel)) {
            item.influenceByModel[modelId] = (item.influenceByModel[modelId] || 0) + (influence as number);
          }
        }
      }
    }
  });

  // Normalize influences so they sum to 1.0 (market share distribution)
  normalizeAggregatedInfluences(linkDomains);

  // Sort by influence (descending) for display purposes
  linkDomains.sort((a, b) => (b.influence || 0) - (a.influence || 0));

  logger.debug(`Calculated influence for ${linkDomains.length} link domains`);
}

/**
 * Main function to calculate influence for linkDomains
 */
export async function enrichLinkDomainsCalculateInfluence(project: string, targetDate: string): Promise<void> {
  // Initialize logger
  await logger.initialize(import.meta.url, project);

  logger.info(`Starting linkDomains influence calculation for project: ${project}`);

  const questions = await readQuestions(project);

  // Add aggregate as a synthetic question entry (will be processed last due to underscore prefix)
  questions.push({
    folder: AGGREGATED_DIR_NAME,
    question: `${project} - Aggregate Report`,

  });

  logger.info(`Processing ${questions.length} questions for date: ${targetDate}`);

  // Start progress tracking
  logger.startProgress(questions.length, 'questions');

  let processedCount = 0;
  let skippedCount = 0;

  for (const [index, question] of questions.entries()) {
    const currentIndex = index + 1;
    logger.updateProgress(currentIndex, `Calculating influence for ${question.folder}...`);

    const files = await prepareStepFiles({
      project,
      questionFolder: question.folder,
      date: targetDate,
      stepName: CURRENT_MODULE_NAME
    });

    if (!files.exists) {
      throw createMissingFileError(question.folder, files.inputPath, 'enrich-link-domains-calculate-influence');
    }

    try {


      const { data, dataKey } = await loadDataJs(files.inputPath);

      // Check if linkDomains exist - CRITICAL: must be created by previous modules
      if (!data.linkDomains || !Array.isArray(data.linkDomains) || data.linkDomains.length === 0) {
        throw createMissingDataError(question.folder, 'linkDomains', 'previous link-domains step', 'enrich-link-domains-calculate-influence');
      }

      // Calculate influence for linkDomains
      calculateInfluenceForLinkDomains(data.linkDomains);

      // Save updated data
      await saveDataJs(files.outputPath, dataKey, data);

      processedCount++;

      logger.updateProgress(currentIndex, `${question.folder} - ✓ ${data.linkDomains.length} domains`);
      logger.info(`Calculated influence for ${data.linkDomains.length} link domains for ${question.folder}`);

    } catch (error) {
      // Re-throw critical errors to stop pipeline
      if (error instanceof PipelineCriticalError) {
        logger.error(`Pipeline-stopping error in ${error.questionFolder}: ${error.message}`);
        throw error;
      }

      // Log and continue for other errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to process ${question.folder}: ${errorMsg}`);
      throw new PipelineCriticalError(
        `Error processing ${question.folder}: ${errorMsg}`,
        CURRENT_MODULE_NAME,
        project
      );
    }
  }

  // Complete progress
  logger.completeProgress(`Processed ${processedCount} questions`);

  // Add summary stats
  logger.addStat('Processed', processedCount);
  logger.addStat('Skipped', skippedCount);

  logger.info(`LinkDomains influence calculation complete. Processed: ${processedCount}, Skipped: ${skippedCount}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  await enrichLinkDomainsCalculateInfluence(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
