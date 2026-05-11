import { promises as fs } from 'fs';
import { DirentLike } from '../config/types.js';
import { QUESTIONS_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { isInterrupted } from '../utils/delay.js';
import { ENRICHMENT_SECTIONS } from '../config/constants-entities.js';
import { PipelineCriticalError, createMissingFileError } from '../utils/pipeline-errors.js';
import {
  EnrichedItem,
  prepareStepFiles
} from '../utils/enrich-data-utils.js';
import { loadDataJs, saveDataJs, loadProjectModelConfigs, validateAndLoadProject } from '../utils/project-utils.js';
import { getTargetDateFromProjectOrEnvironment, getProjectNameFromCommandLine } from '../utils/project-utils.js';
import { ModelType } from '../utils/project-utils.js';
import { normalizeModelWeights } from '../utils/influence-calculator.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


/**
 * Calculate appearance order for items
 * This converts character positions to ordinal positions (1st, 2nd, 3rd, etc.)
 *
 * The overall appearanceOrder uses WEIGHTED AVERAGE based on model importance (MAU).
 * Individual per-model positions are preserved in appearanceOrderByModel for filtering.
 */
function calculateAppearanceOrder(items: EnrichedItem[], models: any[]): void {
  if (!Array.isArray(items)) return;

  // Get normalized model weights for weighted average calculation
  const normalizedWeights = normalizeModelWeights(models);

  // Step 1: Collect first appearance order (character position) for each item in each model
  const firstAppearanceOrderByModel: Map<string, Map<any, number>> = new Map();

  for (const item of items) {
    // Skip items without character position data
    if (!item.firstAppearanceOrderCharByModel) continue;

    for (const [modelId, charPos] of Object.entries(item.firstAppearanceOrderCharByModel)) {
      if (charPos > 0) {
        if (!firstAppearanceOrderByModel.has(modelId)) {
          firstAppearanceOrderByModel.set(modelId, new Map());
        }
        firstAppearanceOrderByModel.get(modelId)!.set(item, charPos);
      }
    }
  }

  // Step 2: Convert character positions to ordinal positions (1st, 2nd, 3rd) for each model
  for (const [modelId, itemAppearanceOrderMap] of firstAppearanceOrderByModel) {
    // Get all items mentioned by this model with their character positions
    const itemsForModel = Array.from(itemAppearanceOrderMap.entries())
      .sort((a, b) => a[1] - b[1]); // Sort by character position

    // Assign ordinal positions (1, 2, 3...)
    itemsForModel.forEach((entry, index) => {
      const item = entry[0];
      if (!item.appearanceOrderByModel) {
        item.appearanceOrderByModel = {};
      }
      item.appearanceOrderByModel[modelId] = index + 1; // 1-based position
    });
  }

  // Step 3: Calculate WEIGHTED AVERAGE appearance order for items
  // Weight by model importance (estimated_mau) so higher-traffic models have more influence
  for (const item of items) {
    if (item.appearanceOrderByModel && Object.keys(item.appearanceOrderByModel).length > 0) {
      // Calculate weighted average across models
      let weightedSum = 0;
      let totalWeight = 0;

      for (const [modelId, position] of Object.entries(item.appearanceOrderByModel)) {
        if (typeof position === 'number' && position > 0 && position < 999) {
          const weight = normalizedWeights.get(modelId) || 0;
          weightedSum += position * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0) {
        // Weighted average appearance order
        item.appearanceOrder = Number((weightedSum / totalWeight).toFixed(2));
      } else {
        item.appearanceOrder = 999; // Not mentioned in any weighted model
      }
    } else {
      // Initialize appearanceOrderByModel if missing
      item.appearanceOrderByModel = {};

      // For items with mentions but no appearance order data, use high position
      if (item.mentions && item.mentions > 0) {
        for (const model of models) {
          if (item.mentionsByModel && item.mentionsByModel[model.id] > 0) {
            item.appearanceOrderByModel[model.id] = 999; // Unknown position
          }
        }
        item.appearanceOrder = 999;
      } else {
        item.appearanceOrder = -1; // No mentions
      }
    }
  }
}

/**
 * Main function to calculate appearance order for enriched data
 */
export async function enrichCalculateAppearanceOrder(project: string, targetDate: string): Promise<void> {
  // Initialize logger
  logger.info(`Starting appearance order calculation for project: ${project}${targetDate ? ` for date: ${targetDate}` : ''}`);

  // Load project models
  const projectModels = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);

  // Get questions
  const questionsDir = QUESTIONS_DIR(project);
  const questionDirs = await fs.readdir(questionsDir, { withFileTypes: true }) as DirentLike[];
  const actualQuestions = questionDirs.filter(d => d.isDirectory());

  // Start progress tracking
  logger.startProgress(actualQuestions.length, 'questions');

  let processedCount = 0;
  let currentIndex = 0;

  for (const dir of actualQuestions) {
    if (isInterrupted()) {
      logger.info('Operation cancelled by user');
      throw new Error('Operation cancelled');
    }

    currentIndex++;
    logger.updateProgress(currentIndex, `Processing ${dir.name}...`);

    // Prepare files using universal interface
    const files = await prepareStepFiles({
      project,
      questionFolder: dir.name,
      date: targetDate,
      stepName: CURRENT_MODULE_NAME
    });

    if (!files.exists) {
      throw createMissingFileError(dir.name, files.inputPath, CURRENT_MODULE_NAME);
    }

    try {

      // Load data
      const { data, dataKey } = await loadDataJs(files.inputPath);

      // calculate
      for (const arrayType of ENRICHMENT_SECTIONS) {
        if (data[arrayType] && Array.isArray(data[arrayType])) {
          calculateAppearanceOrder(data[arrayType], projectModels);
        }
      }

      const comment = `// Appearance order calculated on ${new Date().toISOString()}`;
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
        `Failed to process ${dir.name}: ${error instanceof Error ? error.message : String(error)}`, 
        CURRENT_MODULE_NAME, 
        project
      );
    }
  }

  // Complete progress
  logger.completeProgress(`Processed ${processedCount} questions`);
  logger.info(`Appearance order calculation complete. Processed: ${processedCount}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);  

  // Initialize logger
  await logger.initialize(import.meta.url, project);

  await enrichCalculateAppearanceOrder(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
