/**
 * Enrich Calculate Mentions
 *
 * This module calculates how many times each entity is mentioned by different AI models.
 * It counts mentions, tracks which models mentioned each item, and calculates percentages.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DirentLike } from '../config/types.js';
import { QUESTIONS_DIR, CAPTURE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { isInterrupted } from '../utils/delay.js';
import { ENRICHMENT_SECTIONS } from '../config/constants-entities.js';
import { PipelineCriticalError, createMissingFileError } from '../utils/pipeline-errors.js';
import {
  EnrichedItem,
  AnswerData,
  prepareStepFiles
} from '../utils/enrich-data-utils.js';
import { loadProjectModelConfigs, loadDataJs, saveDataJs, removeNonProjectModels } from '../utils/project-utils.js';
import { getProjectNameFromCommandLine, validateAndLoadProject } from '../utils/project-utils.js';
import { getTargetDateFromProjectOrEnvironment } from '../utils/project-utils.js';
import { ModelType } from '../utils/project-utils.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


/**
 * Helper function to escape special regex characters
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  // Wrap with word boundaries to prevent matching substrings inside other words
  // e.g., "EA" should not match inside "leading" or "real-time"
  return new RegExp(`\\b${flexiblePattern}\\b`, 'gi');
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
function countMentionsInAnswer(
  term: string,
  answerText: string,
  captureDate?: string,
  promptId?: string
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
        // Check word boundaries to prevent substring matches (e.g., "EA" in "leading")
        const charBefore = searchIndex > 0 ? lowerTextToSearch[searchIndex - 1] : '';
        const charAfter = lowerTextToSearch[searchIndex + lowerTerm.length] || '';
        const isWordChar = /[a-z0-9]/i;

        // Skip if surrounded by word characters (not at word boundary)
        if (isWordChar.test(charBefore) || isWordChar.test(charAfter)) {
          searchIndex += 1;
          continue;
        }

        // Create a proper RegExpMatchArray-compatible object
        const matchArray = [answerText.substr(searchIndex, lowerTerm.length)] as RegExpMatchArray;
        matchArray.index = searchIndex;
        matchArray.input = answerText;
        matches.push(matchArray);
        searchIndex += lowerTerm.length; // Move past this match
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
          captureDate,
          promptId
        });
      }
    }
  }

  return { count, firstAppearanceOrder, excerpts };
}

/**
 * Normalize URL for comparison (removes protocol, www, trailing slash, query/fragment)
 */
function normalizeUrlForComparison(url: string): string {
  let normalized = url.toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/^www\./, '');
  normalized = normalized.replace(/\/$/, '');
  normalized = normalized.split(/[?#]/)[0];
  return normalized;
}

/**
 * Count URL mentions in text, excluding positions already counted by longer URLs.
 * Returns count, positions, firstAppearanceOrder, and excerpts.
 */
function countUrlMentionsExcluding(
  urlToFind: string,
  answerText: string,
  excludePositions: Set<number>,
  captureDate?: string,
  promptId?: string
): { count: number; positions: number[]; firstAppearanceOrder: number; excerpts: any[] } {
  const normalizedSearchUrl = normalizeUrlForComparison(urlToFind);
  const positions: number[] = [];
  const excerpts: any[] = [];
  let firstAppearanceOrder = -1;
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

  // Find all URL matches in text (handles both markdown links and plain URLs)
  const urlRegex = /(?:\[([^\]]+)\]\()?((?:https?:\/\/)?(?:www\.)?[a-z0-9][-a-z0-9._]*\.[a-z]{2,}(?:\/[^\s)\]]*)?)/gi;

  let match;
  while ((match = urlRegex.exec(answerText)) !== null) {
    const foundUrl = match[2];
    const normalizedFoundUrl = normalizeUrlForComparison(foundUrl);
    const matchStart = match.index;

    // Skip if this position was already counted by a longer URL
    if (excludePositions.has(matchStart)) continue;

    // Check if this URL matches our search URL:
    // - Exact match
    // - Found URL starts with search URL + "/" (search URL is a prefix/domain of found URL)
    // - Search URL starts with found URL + "/" (found URL is a prefix/domain of search URL)
    if (normalizedFoundUrl === normalizedSearchUrl ||
        normalizedFoundUrl.startsWith(normalizedSearchUrl + '/') ||
        normalizedSearchUrl.startsWith(normalizedFoundUrl + '/')) {
      positions.push(matchStart);

      // Track earliest appearance
      if (firstAppearanceOrder === -1 || matchStart < firstAppearanceOrder) {
        firstAppearanceOrder = matchStart;
      }

      // Create excerpt (limit to 5)
      if (excerpts.length < 5) {
        const startPos = Math.max(0, matchStart - CONTEXT_CHARS);
        const endPos = Math.min(answerText.length, matchStart + match[0].length + CONTEXT_CHARS);
        const excerpt = answerText.substring(startPos, endPos).trim();
        const { line, column } = getLineAndColumn(matchStart);

        excerpts.push({
          appearanceOrder: matchStart,
          excerpt,
          line,
          column,
          captureDate,
          promptId
        });
      }
    }
  }

  return { count: positions.length, positions, firstAppearanceOrder, excerpts };
}

/**
 * Calculate mentions for link items using longest-first strategy.
 * Prevents double-counting by tracking which text positions have been counted.
 */
function calculateLinkMentions(
  linkItems: EnrichedItem[],
  answers: AnswerData[],
  currentDate: string,
  models: any[]
): void {
  // Sort links by URL length (longest first)
  const sortedLinks = [...linkItems].sort((a, b) => {
    const urlA = (a.link || a.value || '').toString();
    const urlB = (b.link || b.value || '').toString();
    return urlB.length - urlA.length;
  });

  // Initialize all link items
  for (const item of linkItems) {
    item.mentions = 0;
    item.mentionsByModel = {};
    item.firstAppearanceOrderCharByModel = {};
    item.excerptsByModel = {};

    models.forEach(model => {
      item.mentionsByModel![model.id] = 0;
      item.firstAppearanceOrderCharByModel![model.id] = -1;
    });
  }

  // For each answer, process links from longest to shortest
  for (const answer of answers) {
    // Only count mentions from the current date's answers
    if (answer.date && answer.date !== currentDate) continue;

    // Track counted positions for this answer (shared across all links)
    const countedPositions = new Set<number>();

    // Process links from longest to shortest
    for (const item of sortedLinks) {
      const urlToSearch = (item.link || item.value || '').toString();
      if (!urlToSearch) continue;

      // Count mentions that haven't been counted yet
      const { count, positions, firstAppearanceOrder, excerpts } = countUrlMentionsExcluding(
        urlToSearch,
        answer.text,
        countedPositions,
        currentDate,
        answer.promptId
      );

      // Mark these positions as counted (for subsequent shorter URLs)
      positions.forEach(pos => countedPositions.add(pos));

      // Accumulate to item
      item.mentionsByModel![answer.modelId] = (item.mentionsByModel![answer.modelId] || 0) + count;
      item.mentions = (item.mentions || 0) + count;

      // Collect excerpts
      if (!item.excerptsByModel![answer.modelId]) {
        item.excerptsByModel![answer.modelId] = [];
      }
      item.excerptsByModel![answer.modelId].push(...excerpts);

      // Track earliest appearance order
      if (count > 0) {
        const currentFirst = item.firstAppearanceOrderCharByModel![answer.modelId];
        if (currentFirst === -1 || firstAppearanceOrder < currentFirst) {
          item.firstAppearanceOrderCharByModel![answer.modelId] = firstAppearanceOrder;
        }
      }
    }
  }

  // Finalize link items (bots, percentages, etc.)
  for (const item of linkItems) {
    // Add bots property - comma-separated string of bot IDs that mentioned this item
    const botsWithMentions = Object.entries(item.mentionsByModel || {})
      .filter(([_, mentions]) => (mentions as number) > 0)
      .map(([botId]) => botId);
    item.bots = botsWithMentions.join(',');
    item.botCount = botsWithMentions.length;
    item.uniqueModelCount = botsWithMentions.length;
  }
}

/**
 * Read answers from capture directory
 */
async function readAnswers(
  folder: string,
  dates: string | string[],
  allowedModels: any[],
  promptId?: string  // Question folder name for answer lookup
): Promise<AnswerData[]> {
  const answers: AnswerData[] = [];
  const datesToProcess = Array.isArray(dates) ? dates : [dates];

  for (const date of datesToProcess) {
    const answersDir = path.join(folder, 'answers', date);
    try {
      const modelDirs = await removeNonProjectModels(
        await fs.readdir(answersDir, { withFileTypes: true }),
        allowedModels
      );

      for (const modelDir of modelDirs) {
        const modelId = modelDir.name;
        const answerFile = path.join(answersDir, modelId, 'answer.md');
        try {
          const text = await fs.readFile(answerFile, 'utf-8');
          answers.push({ text, modelId, date, promptId });
        } catch (error) {
          // Answer file doesn't exist for this model
          continue;
        }
      }
    } catch (error) {
      // Date directory doesn't exist
      continue;
    }
  }

  return answers;
}

/**
 * Calculate mentions for all items
 */
function calculateMentions(
  items: EnrichedItem[],
  answers: AnswerData[],
  currentDate: string,
  models: any[]
): void {
  if (!Array.isArray(items)) return;

  // Separate links from other items for special handling
  // Links use longest-first strategy to prevent double-counting
  const linkItems = items.filter(item => item.type === 'link');
  const nonLinkItems = items.filter(item => item.type !== 'link');

  // Process links with longest-first strategy to prevent double-counting
  if (linkItems.length > 0) {
    calculateLinkMentions(linkItems, answers, currentDate, models);
  }

  // Step 1: Collect mentions for each non-link item in each answer
  for (const item of nonLinkItems) {
    // Get the value to display
    const displayValue = (item.value || item.link || item.keyword || item.organization || item.source || '').toString();
    if (!displayValue) continue;

    // Use display value as search term (no special handling needed for non-links)
    const searchTerm = displayValue;

    let totalMentions = 0;
    const mentionsByModel: { [modelId: string]: number } = {};
    const firstAppearanceOrderCharByModel: { [modelId: string]: number } = {};
    const excerptsByModel: { [modelId: string]: any[] } = {};

    // Initialize mentions by model
    models.forEach(model => {
      mentionsByModel[model.id] = 0;
      firstAppearanceOrderCharByModel[model.id] = -1;
    });

    // Count mentions
    for (const answer of answers) {
      const { count, firstAppearanceOrder, excerpts } = countMentionsInAnswer(searchTerm, answer.text, currentDate, answer.promptId);

      // Only count mentions from the current date's answers
      if (!answer.date || answer.date === currentDate) {
        // Accumulate mentions across all questions (for aggregated data)
        mentionsByModel[answer.modelId] = (mentionsByModel[answer.modelId] || 0) + count;

        // Collect all excerpts
        if (!excerptsByModel[answer.modelId]) {
          excerptsByModel[answer.modelId] = [];
        }
        excerptsByModel[answer.modelId].push(...excerpts);

        if (count > 0) {
          totalMentions += count;
          // Track earliest appearance order
          if (firstAppearanceOrderCharByModel[answer.modelId] === -1 || firstAppearanceOrder < firstAppearanceOrderCharByModel[answer.modelId]) {
            firstAppearanceOrderCharByModel[answer.modelId] = firstAppearanceOrder;
          }
        }
      }
    }

    // Store data on item
    item.mentionsByModel = mentionsByModel;
    item.firstAppearanceOrderCharByModel = firstAppearanceOrderCharByModel;
    item.excerptsByModel = excerptsByModel;
    item.mentions = totalMentions;

    // Add bots property - comma-separated string of bot IDs that mentioned this item
    const botsWithMentions = Object.entries(mentionsByModel)
      .filter(([botId, mentions]) => (mentions as number) > 0)
      .map(([botId]) => botId);
    item.bots = botsWithMentions.join(',');
    item.botCount = botsWithMentions.length;
    item.uniqueModelCount = botsWithMentions.length;
  }

  // Step 2: Calculate mentions as percentage
  const totalMentionsAcrossAllItems = items.reduce((sum, item) => sum + (item.mentions || 0), 0);

  // Calculate total mentions by each bot across all items
  const totalMentionsByModel: { [botId: string]: number } = {};
  models.forEach(model => {
    totalMentionsByModel[model.id] = items.reduce((sum, item) =>
      sum + ((item.mentionsByModel && item.mentionsByModel[model.id]) || 0), 0
    );
  });

  items.forEach(item => {
    // Store as decimal (0.0 to 1.0) not percentage (0 to 100)
    item.mentionsAsPercent = totalMentionsAcrossAllItems > 0
      ? Number((item.mentions! / totalMentionsAcrossAllItems).toFixed(5))
      : 0;

    // Calculate mentions as percent by model
    item.mentionsAsPercentByModel = {};
    models.forEach(model => {
      const botTotalMentions = totalMentionsByModel[model.id] || 0;
      const itemModelMentions = (item.mentionsByModel && item.mentionsByModel[model.id]) || 0;
      item.mentionsAsPercentByModel[model.id] = botTotalMentions > 0
        ? Number((itemModelMentions / botTotalMentions).toFixed(5))
        : 0;
    });
  });
}

/**
 * Main function to calculate mentions for enriched data
 */
export async function enrichCalculateMentions(project: string, targetDate: string): Promise<void> {
  logger.info(`Starting mentions calculation for project: ${project}${targetDate ? ` for date: ${targetDate}` : ''}`);

  // Load project models
  const projectModelsForAnswer = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);

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
      throw createMissingFileError(dir.name, files.inputPath, 'enrich-calculate-mentions');
    }

    try {
      // Load compiled data
      const { data, dataKey } = await loadDataJs(files.inputPath);

      // Use the date from prepareStepFiles
      const currentDate = files.date;

      // Read answers for this question
      let answers: AnswerData[] = [];
      if (dir.name === AGGREGATED_DIR_NAME) {
        // Aggregate: read from ALL questions
        const allQuestions = questionDirs.filter(d => d.isDirectory() && d.name !== AGGREGATED_DIR_NAME);
        for (const q of allQuestions) {
          const questionCaptureDir = path.join(CAPTURE_DIR(project), q.name);
          const questionAnswers = await readAnswers(questionCaptureDir, currentDate, projectModelsForAnswer, q.name);
          answers.push(...questionAnswers);
        }
      } else {
        // Normal question
        const captureDir = path.join(CAPTURE_DIR(project), dir.name);
        answers = await readAnswers(captureDir, currentDate, projectModelsForAnswer, dir.name);
      }

      // calculate
      for (const arrayType of ENRICHMENT_SECTIONS) {
        if (data[arrayType] && Array.isArray(data[arrayType])) {
          calculateMentions(data[arrayType], answers, currentDate, projectModelsForAnswer);

          // Set default influence values so OSS reports work before the influence step runs.
          for (const item of data[arrayType]) {
            if (item.influence === undefined) {
              item.influence = 0;
            }
            if (item.influenceByModel === undefined) {
              item.influenceByModel = {};
            }
            if (item.weightedInfluence === undefined) {
              item.weightedInfluence = 0;
            }
            if (item.shareOfVoice === undefined) {
              item.shareOfVoice = 0;
            }
          }
        }
      }

      // Save enriched data back to same file
      const comment = `// Mentions calculated on ${new Date().toISOString()}`;
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
  logger.info(`Mentions calculation complete. Processed: ${processedCount}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project); 
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);  

  // Initialize logger
  await logger.initialize(import.meta.url, project);

  await enrichCalculateMentions(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
