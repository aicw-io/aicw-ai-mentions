/**
 * Shared utilities for enrichment pipeline steps
 *
 * This module provides common functionality used by all enrichment steps,
 * including data loading, saving, and model configuration.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { ModelConfig } from './model-config.js';
import { PROJECT_DIR, QUESTIONS_DIR, GET_ANSWERS_DIR_FOR_QUESTION } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { loadDataJs } from './project-utils.js';
import { logger } from './compact-logger.js';
import { PipelineCriticalError } from './pipeline-errors.js';
import { extractDomainFromUrl } from './url-utils.js';
import { getEntityTypeFromSectionName } from './misc-utils.js';

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
 * Calculate appearance order for items
 * This converts character positions to ordinal positions (1st, 2nd, 3rd, etc.)
 */
export async function normalizeAppearanceOrderForItems(items: EnrichedItem[], models: any[]): Promise<EnrichedItem[]> {
  if (!Array.isArray(items)) {
    throw new PipelineCriticalError('calculateAppearanceOrder', 'Items must be an array');
  }

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

  // Step 3: Calculate average appearance order for items
  for (const item of items) {
    if (item.appearanceOrderByModel && Object.keys(item.appearanceOrderByModel).length > 0) {
      const positions = Object.values(item.appearanceOrderByModel)
        .filter((p): p is number => typeof p === 'number' && p > 0);

      if (positions.length > 0) {
        // Calculate average position
        const sum = positions.reduce((a: number, b: number) => a + b, 0);
        item.appearanceOrder = Number((sum / positions.length).toFixed(2));
      } else {
        item.appearanceOrder = 999; // Not mentioned = very high position number
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

  return items;
}

/**
 * Mask URLs in markdown links [text](url) with # symbols of same length
 * This prevents counting entity names that appear in URL slugs while preserving
 * character positions for accurate appearanceOrder and excerpt extraction
 */
function maskMarkdownLinkUrls(text: string): string {
  // Match markdown links: [text](url)
  // Captures: [1] = display text, [2] = url
  return text.replace(/(\[[^\]]+\])\(([^\)]+)\)/g, (match, displayText, url) => {
    // Replace URL with same number of # symbols to preserve character positions
    const maskedUrl = '#'.repeat(url.length);
    return `${displayText}(${maskedUrl})`;
  });
}

/**
 * Count mentions of a term in answer text
 */
export function countMentionsOfValueInAnswer(
  term: string,
  answerText: string,
  captureDate?: string
): { count: number; firstAppearanceOrder: number; excerpts: any[] } {
  const lowerAnswer = answerText.toLowerCase();
  let lowerTerm = term.toLowerCase();

  // Check if this looks like a URL/domain
  const isUrl = lowerTerm.includes('.') && !lowerTerm.includes(' ');

  // If searching for non-URL entity, mask markdown link URLs to avoid false matches
  // in URL slugs (e.g., "vahan-chakhalyan" in https://linkedin.com/in/vahan-chakhalyan/)
  const textToSearch = isUrl ? answerText : maskMarkdownLinkUrls(answerText);
  const lowerTextToSearch = textToSearch.toLowerCase();

  let count = 0;
  let firstAppearanceOrder = -1;
  const excerpts: any[] = [];
  const CONTEXT_CHARS = 300;

  // Helper to calculate line and column from position
  const getLineAndColumn = (pos: number): { line: number; column: number } => {
    let line = 1;
    let column = 1;
    for (let i = 0; i < pos; i++) {
      if (answerText[i] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return { line, column };
  };

  // Helper to normalize URLs for comparison
  const normalizeUrl = (url: string): string => {
    let normalized = url.toLowerCase();
    normalized = normalized.replace(/^https?:\/\//, '');
    normalized = normalized.replace(/^www\./, '');
    normalized = normalized.replace(/\/$/, '');
    normalized = normalized.split(/[?#]/)[0];
    return normalized;
  };

  const matches: RegExpMatchArray[] = [];

  if (isUrl) {
    // Find all URLs in the answer text
    const normalizedSearchTerm = normalizeUrl(lowerTerm);
    const urlRegex = /(?:\[([^\]]+)\]\()?((?:https?:\/\/)?(?:www\.)?[a-z0-9][-a-z0-9._]*\.[a-z]{2,}(?:\/[^\s)]*)?)/gi;

    let urlMatch;
    while ((urlMatch = urlRegex.exec(answerText)) !== null) {
      const fullUrl = urlMatch[2];
      const normalizedFoundUrl = normalizeUrl(fullUrl);

      if (normalizedFoundUrl === normalizedSearchTerm ||
          normalizedFoundUrl.startsWith(normalizedSearchTerm + '/') ||
          normalizedSearchTerm.startsWith(normalizedFoundUrl + '/')) {
        const matchObj = {
          0: urlMatch[0],
          index: urlMatch.index,
          input: answerText,
          groups: undefined
        } as RegExpMatchArray;
        matches.push(matchObj);
      }
    }

    // Also check for plain domain references
    const escapedTerm = lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const simpleRegex = new RegExp('\\b' + escapedTerm + '\\b', 'gi');
    let simpleMatch;
    while ((simpleMatch = simpleRegex.exec(answerText)) !== null) {
      const alreadyCaptured = matches.some(m =>
        m.index !== undefined &&
        simpleMatch.index !== undefined &&
        m.index <= simpleMatch.index &&
        m.index + m[0].length >= simpleMatch.index + simpleMatch[0].length
      );
      if (!alreadyCaptured) {
        matches.push(simpleMatch);
      }
    }
  } else {
    // Not a URL, try flexible regex approach first, fallback to indexOf if regex fails
    let regexSuccess = false;

    try {
      const searchRegex = stringToFlexibleRegExp(lowerTerm);
      let match;
      while ((match = searchRegex.exec(lowerTextToSearch)) !== null) {
        matches.push(match);
      }
      regexSuccess = true;
    } catch (regexError) {
      // Regex creation or execution failed, fall back to simple string search
      logger.debug(`Regex failed for term "${lowerTerm}", using indexOf fallback: ${regexError}`);

      // Use case-insensitive indexOf (both strings are already lowercase)
      let searchIndex = 0;
      while ((searchIndex = lowerTextToSearch.indexOf(lowerTerm, searchIndex)) !== -1) {
        // Create a proper RegExpMatchArray-compatible object
        const matchArray = [answerText.substr(searchIndex, lowerTerm.length)] as RegExpMatchArray;
        matchArray.index = searchIndex;
        matchArray.input = answerText;
        matches.push(matchArray);
        searchIndex += 1; // Move past this position to find overlapping matches
      }
      regexSuccess = true; // Mark as handled
    }

    // Check for possessive forms (only if term is suitable)
    if (lowerTerm.length > 3 && !lowerTerm.includes('.')) {
      try {
        const possessivePattern = new RegExp(`\\b${escapeRegExp(lowerTerm)}'s\\b`, 'gi');
        let possessiveMatch;
        while ((possessiveMatch = possessivePattern.exec(textToSearch)) !== null) {
          const alreadyCaptured = matches.some(m =>
            m.index !== undefined &&
            possessiveMatch.index !== undefined &&
            Math.abs(m.index - possessiveMatch.index) < 2
          );
          if (!alreadyCaptured) {
            matches.push(possessiveMatch);
          }
        }
      } catch (possessiveError) {
        // Possessive pattern failed, skip it (not critical)
        logger.debug(`Possessive pattern failed for term "${lowerTerm}": ${possessiveError}`);
      }
    }
  }

  // Process all matches
  count = matches.length;

  if (matches.length > 0) {
    // Sort matches by position
    matches.sort((a, b) => (a.index || 0) - (b.index || 0));

    firstAppearanceOrder = matches[0].index || -1;

    // Create excerpts
    for (const match of matches.slice(0, 5)) { // Limit to 5 excerpts
      if (match.index !== undefined) {
        const startPos = Math.max(0, match.index - CONTEXT_CHARS);
        const endPos = Math.min(answerText.length, match.index + match[0].length + CONTEXT_CHARS);
        const excerpt = answerText.substring(startPos, endPos).trim();
        const { line, column } = getLineAndColumn(match.index);

        excerpts.push({
          appearanceOrder: match.index,
          excerpt,
          line,
          column,
          captureDate
        });
      }
    }
  }

  return { count, firstAppearanceOrder, excerpts };
}

/**
 * Common interface for answer data
 */
export interface AnswerData {
  text: string;
  modelId: string;
  date?: string;
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
 * Entity interface for enrichment operations
 */
export interface Entity {
  id: number;
  type: string;
  value: string;
  similar?: string;
  link?: string;
  sectionName: string;
  originalIndex: number;
}

/**
 * Check if an entity needs enrichment for a specific attribute
 *
 * @param entity - The entity to check
 * @param attrName - The attribute name to check (e.g., 'similar', 'link')
 * @returns true if the entity needs enrichment for this attribute
 */
export function needsToEnrichAttribute(entity: any, attrName: string): boolean {
  // Entity needs enrichment if:
  // 1. Has no attribute field at all
  // 2. Has an empty attribute field
  // 3. Has an attribute field with only whitespace
  // 4. Attribute is not a string type
  return !entity[attrName] ||
          typeof entity[attrName] !== 'string' ||
          entity[attrName].trim() === '';
}

/**
 * Extract the value from an entity (handles different field names)
 *
 * @param entity - The entity to extract value from
 * @returns The entity's value string
 */
export function getEntityValue(entity: any): string {
  return entity.value || entity.name || entity.keyword || entity.title || entity.label || entity.text || entity.link || '';
}

/**
 * Collect all entities that need enrichment for a specific attribute from specified sections
 *
 * @param data - The data object containing sections
 * @param SECTIONS - Array of section names to process
 * @param attrName - The attribute name to enrich (e.g., 'similar', 'link')
 * @returns Array of entities that need enrichment
 */
export function collectEntitiesForEnrichment(data: any, SECTIONS: string[], attrName: string): Entity[] {
  const entities: Entity[] = [];
  let globalId = 1;

  // Process specified sections
  for (const sectionName of SECTIONS) {
    // Skip if section doesn't exist or isn't an array
    if (!data[sectionName] || !Array.isArray(data[sectionName])) {
      logger.debug(`Skipping section '${sectionName}' - not an array`);
      continue;
    }

    // Collect entities that need enrichment
    const entitiesInSection: Entity[] = [];
    data[sectionName].forEach((entity: any, index: number) => {
      const entityValue = getEntityValue(entity);
      if (entityValue && needsToEnrichAttribute(entity, attrName)) {
        const enrichEntity: Entity = {
          id: globalId++,
          type: entity.type,
          value: entityValue,
          link: entity.link,
          similar: entity.similar,
          sectionName: sectionName,
          originalIndex: index
        };
        entities.push(enrichEntity);
        entitiesInSection.push(enrichEntity);
      }
    });

    // Log section processing info at INFO level (not DEBUG)
    const totalInSection = data[sectionName].length;
    const needsEnrichment = entitiesInSection.length;

    if (totalInSection > 0) {
      if (needsEnrichment > 0) {
        logger.info(`  └─ Section '${sectionName}': ${needsEnrichment}/${totalInSection} entities need '${attrName}' enrichment`);
      } else {
        logger.info(`  └─ Section '${sectionName}': 0/${totalInSection} entities need '${attrName}' enrichment (all already have ${attrName})`);
      }
    }
  }

  return entities;
}

// trying to predict some values for functions if any
// for example, we can predict links if link = value without spaces + .com/.org/.ai
export function predictAttributeValueForEntities(data: any, entities: Entity[], attrName: string): Entity[] 
{
  // trying to predict "link" value if we have "links" section which is not empty
  const DOMAIN_ENDINGS = ['.com', '.org', '.ai', '.io'];
  const result: Entity[] = [];
  let predictedLinksCount = 0;
  // processing ATTRIBUTE_NAME as "link"
  if(attrName == 'link' && data['links'] && data['links'].length > 0)
  {
    // get all domains mentioned from "links" array
    const linkItems = data['links'].map((item: any) => extractDomainFromUrl(item.value.toLowerCase()));
    const linkItemsSet = new Set(linkItems);
    if(linkItems.length > 0){
      for(const e of entities){
        if(e.value && e.value.length>0 && !e.link){
          const predictedLink = e.value.replace(/ /g, '').toLowerCase();
          // going through domain endings
          for(const domainEnding of DOMAIN_ENDINGS){
            // if check if we hav this domain like "somestring" + domain ending
            const suggestedLink = predictedLink + domainEnding;
            // check if we have this domain in our domains list from "links"
            if(linkItemsSet.has(suggestedLink))
            {
              // because we have this domain in our domains list from "links"
              // so we can use it as a link for prediction!
              e.link = suggestedLink;
              result.push(e);
              logger.info(`predicted link value for "${e.value}" in "${e.sectionName}" section: ${e.link}`);
              predictedLinksCount++;
              break;
            }
          }
        }
      }
    }
    logger.info(`predicted "${attrName}" attribute for ${result.length} items`);
  }
  // NO OTHER TYPES ARE SUPPORTED YET
  else {
    throw new PipelineCriticalError(
      `No support for predicting "${attrName}" value`,
      'predictAttributeValueForEntities'
    );
  }
  // return entities with predicted values (if any)
  return result;
}

/**
 * Collect entities from a SINGLE section only (not all sections)
 * Used for section-by-section enrichment processing
 *
 * @param data - The data object containing all sections
 * @param sectionName - The specific section to collect from (e.g., 'keywords', 'places')
 * @param attrName - The attribute to check for enrichment need (e.g., 'link', 'similar')
 * @returns Array of entities from this section that need enrichment
 */
export function collectEntitiesForSection(
  data: any,
  sectionName: string,
  attrName: string
): Entity[] {
  const entities: Entity[] = [];

  // Skip if section doesn't exist or isn't an array
  if (!data[sectionName] || !Array.isArray(data[sectionName])) {
    logger.debug(`Section '${sectionName}' does not exist or is not an array`);
    return entities;
  }

  let globalId = 1;

  // Collect entities from this section that need enrichment
  data[sectionName].forEach((item: any, index: number) => {
    const entityValue = getEntityValue(item);
    if (entityValue && needsToEnrichAttribute(item, attrName)) {
      entities.push({
        id: globalId++,
        type: item.type || getEntityTypeFromSectionName(sectionName),
        value: entityValue,
        link: item.link,
        similar: item.similar,
        sectionName: sectionName,
        originalIndex: index
      });
    }
  });

  return entities;
}

/**
 * Get total number of entities in a section
 * Used for logging and statistics
 *
 * @param data - The data object containing all sections
 * @param sectionName - The section name
 * @returns Number of entities in this section
 */
export function getTotalInSection(data: any, sectionName: string): number {
  if (!data[sectionName] || !Array.isArray(data[sectionName])) {
    return 0;
  }
  return data[sectionName].length;
}

/**
 * Helper function to escape special regex characters in entity names
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a string to a flexible regular expression pattern
 * that handles variations in spacing, punctuation, and URL encoding
 */
function stringToFlexibleRegExp(str: string): RegExp {
  // Escape special regex characters
  const escapedStr = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Replace non-alphanumeric characters with a flexible pattern
  const flexiblePattern = escapedStr.replace(/[^a-zA-Z0-9]+/g, (match) => {
    // Check if this is a Unicode character sequence
    const isUnicode = match.split('').some(char => char.charCodeAt(0) > 127);

    if (isUnicode) {
      // For Unicode characters, create exact character alternatives with URL encoding
      const encodedChars = match.split('').map(char => {
        const encoded = encodeURIComponent(char);
        if (encoded !== char) {
          const escapedEncoded = encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return `(?:${escapeRegExp(char)}|${escapedEncoded})`;
        }
        return escapeRegExp(char);
      }).join('');
      return encodedChars;
    } else {
      // For ASCII non-alphanumeric (spaces, punctuation), use flexible matching
      const encodedChars = match.split('').map(char => {
        const encoded = encodeURIComponent(char);
        if (encoded !== char) {
          const escapedEncoded = encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (char === '?') return `(?:\\?|%3F)`;
          else if (char === '+') return `(?:\\+|%2B)`;
          else if (char === '%') return `(?:%|%25)`;
          return `(?:${char}|${escapedEncoded})`;
        }
        return escapeRegExp(char);
      }).join('');
      return `(?:[\\s\\-_.,;:!?'"()\\[\\]{}]+|${encodedChars})`;
    }
  });

  return new RegExp(flexiblePattern, 'gi');
}

/**
 * Extract links from markdown syntax in original answer files
 * Searches for patterns like: [Entity Name](https://example.com)
 * This provides the highest confidence links since they come directly from bot answers
 *
 * @param entities - Array of entities that need links
 * @param project - Project name
 * @param questionFolder - Question folder name
 * @param targetDate - Target date for answers
 * @returns Array of entities with links extracted from markdown
 */
export async function extractLinksFromMarkdownInAnswers(
  entities: Entity[],
  project: string,
  questionFolder: string,
  targetDate: string
): Promise<Entity[]> {
  const result: Entity[] = [];

  // Get answers directory for this question and date
  const answersDir = path.join(
    GET_ANSWERS_DIR_FOR_QUESTION(project, questionFolder),
    targetDate
  );

  // Check if answers directory exists
  try {
    await fs.access(answersDir);
  } catch (error) {
    logger.debug(`No answers directory found at ${answersDir}`);
    return result;
  }

  // Load all answer files
  const answerTexts = new Map<string, string>();
  try {
    const botDirs = await fs.readdir(answersDir, { withFileTypes: true });

    for (const botDir of botDirs) {
      if (!botDir.isDirectory()) continue;

      const answerFile = path.join(answersDir, botDir.name, 'answer.md');
      try {
        const content = await fs.readFile(answerFile, 'utf-8');
        answerTexts.set(botDir.name, content);
      } catch (error) {
        logger.debug(`Could not read answer file: ${answerFile}`);
      }
    }
  } catch (error) {
    logger.debug(`Could not read answers directory: ${answersDir}`);
    return result;
  }

  if (answerTexts.size === 0) {
    logger.debug(`No answer files found in ${answersDir}`);
    return result;
  }

  // Search for markdown links for each entity
  for (const entity of entities) {
    if (entity.link) continue; // Already has a link

    // Try to find markdown link in any answer
    for (const [botId, answerText] of answerTexts) {
      // Escape special regex characters in entity name
      const escapedName = escapeRegExp(entity.value);

      // Regex to find: [text containing entity name](url)
      // Case insensitive, allows text before/after entity name in the link text
      const markdownLinkRegex = new RegExp(
        `\\[([^\\]]*${escapedName}[^\\]]*)\\]\\(([^\\)]+)\\)`,
        'i'
      );

      const match = answerText.match(markdownLinkRegex);
      if (match) {
        const url = match[2].trim();

        // Validate that we got a proper URL
        if (url && url.startsWith('http')) {
          entity.link = url;
          result.push(entity);
          logger.info(`Extracted markdown link for "${entity.value}" from ${botId}: ${url}`);
          break; // Found a link, move to next entity
        }
      }
    }
  }

  return result;
}
