import { promises as fs } from 'fs';
import { DirentLike } from '../config/types.js';
import { QUESTIONS_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { logger } from '../utils/compact-logger.js';
import { isInterrupted } from '../utils/delay.js';
import { ENRICHMENT_SECTIONS } from '../config/constants-entities.js';
import { PipelineCriticalError, createMissingFileError } from '../utils/pipeline-errors.js';
import {
  loadProjectModelConfigs,
  loadDataJs,
  saveDataJs
} from '../utils/project-utils.js';
import {
  EnrichedItem,
  prepareStepFiles
} from '../utils/enrich-data-utils.js';


import {
  normalizeModelWeights,
  calculateShareOfVoice,
  calculateInfluenceByModel,
  calculateProminence
} from '../utils/influence-calculator.js';
import { getTargetDateFromProjectOrEnvironment, validateAndLoadProject } from '../utils/project-utils.js';
import { getProjectNameFromCommandLine } from '../utils/project-utils.js';
import { ModelType } from '../utils/project-utils.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


/**
 * Calculate Share of Voice (influence) scores for items
 */
function calculateInfluence(items: EnrichedItem[], models: any[]): void {
  if (!Array.isArray(items)) return;

  // Normalize model weights
  const normalizedWeights = normalizeModelWeights(models);

  // STEP 1: Find global max prominence across all items
  let maxProminence = 0;

  for (const item of items) {
    if (!item.mentions || item.mentions === 0) continue;

    // Calculate total prominence for this item
    let totalProminence = 0;
    for (const [modelId, mentions] of Object.entries(item.mentionsByModel || {})) {
      const appearanceOrder = (item.appearanceOrderByModel || {})[modelId] || 999;
      const prominence = calculateProminence(mentions as number, appearanceOrder);
      totalProminence += prominence;
    }

    if (totalProminence > maxProminence) {
      maxProminence = totalProminence;
    }
  }

  // STEP 2: Calculate Share of Voice for each item using the global max prominence
  for (const item of items) {
    if (!item.mentions || item.mentions === 0) {
      item.influence = 0;
      item.influenceByModel = {};
      item.weightedInfluence = 0; // Keep for backward compatibility
      continue;
    }

    // Calculate Share of Voice using the new formula
    item.influence = calculateShareOfVoice(
      item.mentionsByModel || {},
      item.appearanceOrderByModel || {},
      normalizedWeights,
      maxProminence
    );

    // Calculate per-model share of voice
    item.influenceByModel = calculateInfluenceByModel(
      item.mentionsByModel || {},
      item.appearanceOrderByModel || {},
      normalizedWeights,
      maxProminence
    );

    // Keep weightedInfluence for backward compatibility
    item.weightedInfluence = item.influence;
  }

  // No need for normalizeInfluences() - Share of Voice is already 0-1 scale
}

/**
 * Main function to calculate influence for enriched data
 */
export async function enrichCalculateInfluence(project: string, targetDate: string): Promise<void> {
  // Initialize logger
  await logger.initialize(import.meta.url, project);
  logger.info(`Starting influence calculation for project: ${project}${targetDate ? ` for date: ${targetDate}` : ''}`);

  // Load project models
  const aiModelsForAnswerInProject = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);  

  // Get questions
  const questionsDir = QUESTIONS_DIR(project);
  const questionDirs = await fs.readdir(questionsDir, { withFileTypes: true }) as DirentLike[];
  const actualQuestions = questionDirs.filter(d => d.isDirectory());

  // Start progress tracking
  logger.startProgress(actualQuestions.length, 'questions');

  let processedCount = 0;
  let skippedCount = 0;
  let currentIndex = 0;

  for (const dir of actualQuestions) {
    if (isInterrupted()) {
      logger.info('Operation cancelled by user');
      throw new Error('Operation cancelled');
    }

    currentIndex++;
    logger.updateProgress(currentIndex, `Processing ${dir.name}...`);

    const files = await prepareStepFiles({
      project,
      questionFolder: dir.name,
      date: targetDate,
      stepName: CURRENT_MODULE_NAME
    });

    if (!files.exists) {
      throw createMissingFileError(dir.name, files.inputPath, 'enrich-calculate-influence');
    }

    try {


      const { data, dataKey } = await loadDataJs(files.inputPath);

      // calculate
      for (const arrayType of ENRICHMENT_SECTIONS) {
        if (data[arrayType] && Array.isArray(data[arrayType])) {
          calculateInfluence(data[arrayType], aiModelsForAnswerInProject);
        }
      }

      // Save enriched data back to same file
      const comment = `// Influence calculated on ${new Date().toISOString()}`;
      await saveDataJs(files.outputPath, dataKey, data, comment);

      processedCount++;
      logger.updateProgress(currentIndex, `${dir.name} - ✓`);
    } catch (error) {
      // Re-throw critical errors to stop pipeline
      if (error instanceof PipelineCriticalError) {
        logger.error(`Pipeline-stopping error in ${error.questionFolder}: ${error.message}`);
        throw error;
      }

      // Log and continue for other errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error processing ${dir.name}: ${errorMsg}`);
      throw new PipelineCriticalError(
        `Error processing ${dir.name}: ${errorMsg}`, 
        CURRENT_MODULE_NAME, 
        project
      );
    }
  }

  // Complete progress
  logger.completeProgress(`Processed ${processedCount} questions`);
  logger.info(`Influence calculation complete. Processed: ${processedCount}, Skipped: ${skippedCount}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project);  
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);


  await enrichCalculateInfluence(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
