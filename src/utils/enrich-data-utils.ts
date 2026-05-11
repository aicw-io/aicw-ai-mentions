/**
 * Shared utilities for enrichment pipeline steps
 *
 * This module provides common functionality used by all enrichment steps,
 * including data loading, saving, and model configuration.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { ModelConfig } from './model-config.js';
import { PROJECT_DIR, QUESTIONS_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { loadDataJs } from './project-utils.js';
import { logger } from './compact-logger.js';
import { PipelineCriticalError } from './pipeline-errors.js';



/**
 * Common interface for enriched item data
 */
export interface EnrichedItem {
  value?: string;
  link?: string;
  keyword?: string;
  organization?: string;
  source?: string;
  type?: string;
  mentions?: number;
  mentionsByModel?: { [modelId: string]: number };
  appearanceOrder?: number;
  appearanceOrderByModel?: { [modelId: string]: number };
  firstAppearanceOrderCharByModel?: { [modelId: string]: number };
  excerptsByModel?: { [modelId: string]: any[] };
  bots?: string;
  botCount?: number;
  uniqueModelCount?: number;
  mentionsAsPercent?: number;
  mentionsAsPercentByModel?: { [modelId: string]: number };
  influence?: number;
  influenceByModel?: { [modelId: string]: number };
  weightedInfluence?: number;
  previous_mentions?: number;
  mentions_change?: number;
  mentionsHistory?: { date: string; mentions: number }[];
  trend?: number;
  changePercent?: number;
  volatility?: number;
  firstSeen?: string;
  lastSeen?: string;
  // Trend tracking fields
  mentionsTrend?: number;
  influenceTrend?: number;
  appearanceOrderTrend?: number;
  uniqueModelCountTrend?: number;
  mentionsTrendVals?: { date: string; value: number }[];
  influenceTrendVals?: { date: string; value: number }[];
  appearanceOrderTrendVals?: { date: string; value: number }[];
  uniqueModelCountTrendVals?: { date: string; value: number }[];
  // Per-model trend fields
  mentionsByModelTrend?: { [modelId: string]: number };
  influenceByModelTrend?: { [modelId: string]: number };
  appearanceOrderByModelTrend?: { [modelId: string]: number };
  mentionsByModelTrendVals?: { [modelId: string]: { date: string; value: number }[] };
  influenceByModelTrendVals?: { [modelId: string]: { date: string; value: number }[] };
  appearanceOrderByModelTrendVals?: { [modelId: string]: { date: string; value: number }[] };
}

/**
 * Common interface for answer data
 */
export interface AnswerData {
  text: string;
  modelId: string;
  date?: string;
  promptId?: string;  // Question folder name for answer lookup
}

/**
 * Clean AI-generated summary text by removing HTML artifacts and replacing model IDs
 * @param summary - The raw summary text from AI summary
 * @param models - Array of model configurations with id and display_name
 * @returns Cleaned summary text
 */
export function cleanAISummary(summary: string | undefined, models: ModelConfig[]): string | undefined {
  if (!summary) return summary;

  // Create model ID to display name mapping
  const modelMap = new Map<string, string>();
  for (const model of models) {
    modelMap.set(model.id, model.display_name);
  }

  let cleaned = summary;

  // 1. Remove broken HTML attributes (title="...", alt="...", data-*="...")
  // This matches patterns like: title="Click to view ... in keyword section">
  cleaned = cleaned.replace(/\s*(title|alt|data-[a-z-]+)="[^"]*">/g, '>');

  // 2. Clean up orphaned closing tags from malformed HTML
  cleaned = cleaned.replace(/"\s*>/g, '');

  // 3. Replace model IDs with display names
  // Sort by length descending to replace longer IDs first (avoid partial replacements)
  const sortedModelIds = Array.from(modelMap.keys()).sort((a, b) => b.length - a.length);
  for (const modelId of sortedModelIds) {
    const display_name = modelMap.get(modelId)!;
    // Use word boundaries to avoid partial replacements
    const regex = new RegExp(`\\b${modelId}\\b`, 'g');
    cleaned = cleaned.replace(regex, display_name);
  }

  // 4. Clean up excessive whitespace while preserving intentional line breaks
  cleaned = cleaned.replace(/[ \t]+/g, ' '); // Replace multiple spaces/tabs with single space
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n'); // Max 2 consecutive line breaks
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Check historical data completeness for a project
 * Returns dates categorized by their enrichment status
 */
export async function checkHistoricalDataCompleteness(
  project: string
): Promise<{complete: string[], incomplete: string[], missing: string[]}> {
  const result = {
    complete: [] as string[],     // Dates with fully enriched data
    incomplete: [] as string[],   // Dates with compiled but not enriched data
    missing: [] as string[]       // Dates with answers but no compiled data
  };

  const questionsDir = QUESTIONS_DIR(project);

  try {
    const questionDirs = await fs.readdir(questionsDir, { withFileTypes: true });

    // Process first non-aggregated question directory as a sample
    const firstQuestion = questionDirs
      .filter(d => d.isDirectory() && d.name !== AGGREGATED_DIR_NAME)
      .sort()[0];

    if (!firstQuestion) {
      logger.warn('No question directories found');
      return result;
    }

    const compiledBaseDir = path.join(questionsDir, '..', 'reports', firstQuestion.name, 'data-compiled');

    // Get all date directories
    const dateDirs = await fs.readdir(compiledBaseDir, { withFileTypes: true }).catch(() => []);
    const dates = dateDirs
      .filter((d: any) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d: any) => d.name)
      .sort();

    // Check each date directory
    for (const date of dates) {
      const dateDir = path.join(compiledBaseDir, date);
      const files = await fs.readdir(dateDir).catch(() => [] as string[]);

      const enrichedFile = files.find(f =>
        f === `${date}-data.js` &&
        !f.includes('PROMPT-COMPILED') &&
        !f.includes('NON-ENRICHED')
      );

      const compiledFile = files.find(f =>
        f.includes('.PROMPT-COMPILED.js') &&
        !f.includes('NON-ENRICHED')
      );

      if (enrichedFile) {
        result.complete.push(date);
      } else if (compiledFile) {
        result.incomplete.push(date);
      } else {
        result.missing.push(date);
      }
    }

    // Also check for answer directories without compiled data
    const captureDir = path.join(PROJECT_DIR(project), 'capture', firstQuestion.name, 'answers');
    const answerDates = await fs.readdir(captureDir, { withFileTypes: true }).catch(() => []);

    for (const dateDir of answerDates) {
      if ((dateDir as any).isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(dateDir.name)) {
        const date = dateDir.name;
        if (!dates.includes(date)) {
          result.missing.push(date);
        }
      }
    }

  } catch (error) {
    logger.error(`Error checking historical data: ${error}`);
  }

  return result;
}



/**
 * Universal Pipeline Step Interface
 * Provides consistent file path resolution, and completion checking
 * for all pipeline enrichment steps.
 */

export interface PipelineStepContext {
  project: string;
  questionFolder: string;
  date?: string; // Auto-detect if not provided
  stepName: string; // For backup naming (e.g., "extract-links")
  inputFile?: string; // Default: DATA_FILE_PATTERN(date)
  outputFile?: string; // Default: same as inputFile
  createBackup?: boolean; // Default: true
}

export interface StepFiles {
  inputPath: string;
  outputPath: string;
  date: string;
  exists: boolean;
}

/**
 * Prepare file paths for a pipeline step with consistent defaults
 *
 * This function centralizes all file path resolution logic:
 * - Date resolution: explicit param > env var > latest answer date > current date
 * - File defaults: inputFile defaults to {date}-data.js
 * - Output: defaults to same as input (in-place modification)
 *
 * @param context - Step configuration
 * @returns Resolved file paths and metadata
 */
export async function prepareStepFiles(context: PipelineStepContext): Promise<StepFiles> {
  const {
    DATA_FILE_PATTERN,
    BACKUP_DIR_NAME,
    BACKUP_FILE_PATTERN,
    QUESTION_DATA_COMPILED_DATE_DIR
  } = await import('../config/paths.js');

  // the date is already validated and set in the context
  const date = context.date;

  if (!date) {
    throw new PipelineCriticalError(
      `Date is not set in context`,
      'prepareStepFiles',
      context.project
    );
  }

  // 2. Resolve filenames with defaults
  const inputFile = context.inputFile || DATA_FILE_PATTERN(date);
  const outputFile = context.outputFile || inputFile;

  // 3. Build paths
  const dataDir = QUESTION_DATA_COMPILED_DATE_DIR(context.project, context.questionFolder, date);
  const inputPath = path.join(dataDir, inputFile);
  const outputPath = path.join(dataDir, outputFile);

  // 5. Check if input exists
  let exists = false;
  try {
    await fs.access(inputPath);
    exists = true;
  } catch (error) {
    throw new PipelineCriticalError(
      `Input file ${inputPath} does not exist: ${error.message}`,
      'prepareStepFiles',
      context.project
    );
  }

  return { inputPath, outputPath, date, exists };
}

/**
 * Check if a step has already been completed by checking for fields in the data
 *
 * This allows steps to be idempotent - they can safely skip if already processed.
 * Useful for resuming after failures or avoiding redundant work.
 *
 * @param dataPath - Path to data file
 * @param checkField - Field(s) to check for presence (string or array)
 * @param forceRebuild - Force rebuild even if field exists
 * @returns true if step appears completed, false otherwise
 */
export async function isStepCompleted(
  dataPath: string,
  checkField: string | string[],
  forceRebuild: boolean = false
): Promise<boolean> {  

  try {
    const { data } = await loadDataJs(dataPath);
    const fields = Array.isArray(checkField) ? checkField : [checkField];

    for (const field of fields) {
      if (data[field] !== undefined && data[field] !== null) {
        // Check if it's an array with content or a non-empty value
        if (Array.isArray(data[field])) {
          if (data[field].length > 0) return true;
        } else if (data[field]) {
          return true;
        }
      }
    }
  } catch (error) {
    console.error(`Error checking if step is completed: ${error}`);
    return false;
  }

  return false;
}

export async function markItemAsAISourced(item: any, attrName: string) {
  // Mark this field as AI-generated
  if (!item.sources) {
    item.sources = {};
  }
  item.sources[attrName] = "AI";
  return item;
}

/**
 * Normalize computed/aggregated influences using market share approach
 * Sum of all influences = 1.0 (100%)
 * Used for sections that aggregate data from multiple sources, such as linkDomains.
 *
 * Different from normalizeInfluences() which divides by MAX for relative ranking.
 * This function ensures all items' influences sum to 100% (market share semantics).
 */
export function normalizeAggregatedInfluences(items: any[]): void {
  if (!items || items.length === 0) return;

  // 1. Calculate total influence across all items
  const totalInfluence = items.reduce((sum, item) => sum + (item.influence || 0), 0);
  if (totalInfluence === 0) return;

  // 2. Calculate total influence per model (for per-model normalization)
  const totalByModel: { [key: string]: number } = {};
  items.forEach(item => {
    if (item.influenceByModel) {
      for (const [modelId, influence] of Object.entries(item.influenceByModel)) {
        totalByModel[modelId] = (totalByModel[modelId] || 0) + (influence as number);
      }
    }
  });

  // 3. Normalize each item
  items.forEach(item => {
    // Normalize overall influence (market share of total)
    if (item.influence) {
      item.influence = Number((item.influence / totalInfluence).toFixed(5));
      item.weightedInfluence = item.influence;
    }

    // Normalize per-model influences (each model's market share distribution)
    if (item.influenceByModel) {
      for (const modelId in item.influenceByModel) {
        if (totalByModel[modelId] > 0) {
          item.influenceByModel[modelId] = Number(
            (item.influenceByModel[modelId] / totalByModel[modelId]).toFixed(5)
          );
        }
      }
    }
  });
}
