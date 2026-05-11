import { promises as fs } from 'fs';
import path from 'path';
import { DirentLike } from '../config/types.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { QUESTIONS_DIR, QUESTION_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME, MAX_PREVIOUS_DATES } from '../config/constants.js';
import { MAIN_SECTIONS } from '../config/constants-entities.js';
import { PipelineCriticalError, createMissingFileError } from '../utils/pipeline-errors.js';
import { loadDataJs, saveDataJs, readQuestions } from '../utils/project-utils.js';
import { getProjectNameFromCommandLine, validateAndLoadProject, getTargetDateFromProjectOrEnvironment } from '../utils/project-utils.js';
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
import { cleanUrl } from '../utils/url-utils.js';
import { extractLinksFromContent } from '../utils/link-extraction.js';

const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

// ============================================================================
// DISTANCE CONSTRAINTS
// ============================================================================

// Maximum sentences between entity mention and source link
const SOURCE_DETECTION_MAX_SENTENCES_FROM_SOURCE = 2;

// Maximum words between entity mention and source link
const SOURCE_DETECTION_MAX_WORDS_FROM_SOURCE = 250;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Entity source with bots and dates tracking
 */
export interface EntitySource {
  url: string;      // Cleaned URL (no protocol, www, query params, anchors)
  bots: string;     // Model ID like "openai_chatgpt_with_search_latest"
  dates: string[];  // Dates this source appeared (e.g., ["2025-10-10", "2025-10-21"])
}

/**
 * Answer file information with path and bots
 */
interface AnswerFileInfo {
  path: string;
  bots: string;
}

// ============================================================================
// URL DEDUPLICATION
// ============================================================================
// Note: Using cleanUrl from url-utils.js for consistent URL normalization

/**
 * Deduplicate sources and aggregate bot IDs and dates
 * Groups by URL and combines all bot IDs and dates
 */
function deduplicateSources(sources: EntitySource[]): EntitySource[] {
  const urlMap = new Map<string, { bots: Set<string>, dates: Set<string> }>();

  for (const source of sources) {
    const cleanedUrl = cleanUrl(source.url);
    if (!urlMap.has(cleanedUrl)) {
      urlMap.set(cleanedUrl, { bots: new Set(), dates: new Set() });
    }
    const entry = urlMap.get(cleanedUrl)!;
    entry.bots.add(source.bots);
    for (const date of source.dates || []) {
      entry.dates.add(date);
    }
  }

  const result: EntitySource[] = [];
  for (const [url, { bots, dates }] of urlMap.entries()) {
    result.push({
      url,
      bots: Array.from(bots).sort().join(','),
      dates: Array.from(dates).sort()
    });
  }

  return result;
}

function getLinkValue(link: unknown): string {
  if (typeof link === 'string') return link;
  if (Array.isArray(link) && link.length > 0) return String(link[0] || '');
  if (link && typeof link === 'object') {
    const item = link as Record<string, unknown>;
    if (typeof item.link === 'string' && item.link.trim()) return item.link;
    if (typeof item.value === 'string' && item.value.trim()) return item.value;
  }
  return '';
}

function getVerifiedSourceUrls(data: Record<string, unknown>): Set<string> {
  const verified = new Set<string>();
  const links = Array.isArray(data.links) ? data.links : [];

  for (const link of links) {
    const value = getLinkValue(link);
    if (value) {
      verified.add(cleanUrl(value));
    }
  }

  return verified;
}

function filterSourcesToVerifiedLinks(
  sources: EntitySource[],
  verifiedSourceUrls: Set<string>
): EntitySource[] {
  if (verifiedSourceUrls.size === 0) {
    return sources;
  }

  return sources.filter(source => verifiedSourceUrls.has(cleanUrl(source.url)));
}

/**
 * Distance check result with details
 */
interface DistanceCheckResult {
  withinLimits: boolean;
  minSentences: number;
  minWords: number;
}

/**
 * Check if a link found in context is within distance limits from entity mention
 * Measures minimum distance in both sentences and words
 * Returns detailed result with actual distances measured
 */
function isLinkWithinDistanceLimits(
  contextText: string,
  entityValue: string,
  linkOrMarker: string
): DistanceCheckResult {
  const normalizedContext = contextText.toLowerCase();
  const normalizedEntity = entityValue.toLowerCase();

  // Find all entity mention positions
  const entityPositions: number[] = [];
  let pos = 0;
  while ((pos = normalizedContext.indexOf(normalizedEntity, pos)) !== -1) {
    entityPositions.push(pos);
    pos += normalizedEntity.length;
  }

  if (entityPositions.length === 0) {
    return { withinLimits: false, minSentences: Infinity, minWords: Infinity };
  }

  // Find link/marker position
  const linkPos = contextText.indexOf(linkOrMarker);
  if (linkPos === -1) {
    return { withinLimits: false, minSentences: Infinity, minWords: Infinity };
  }

  // Calculate minimum distance to any entity mention
  let minWords = Infinity;
  let minSentences = Infinity;

  for (const entityPos of entityPositions) {
    const start = Math.min(entityPos, linkPos);
    const end = Math.max(entityPos, linkPos);
    const textBetween = contextText.substring(start, end);

    // Count words
    const wordCount = textBetween.split(/\s+/).filter(w => w.length > 0).length;

    // Count sentences
    const sentenceCount = (textBetween.match(/[.!?]+/g) || []).length;

    minWords = Math.min(minWords, wordCount);
    minSentences = Math.min(minSentences, sentenceCount);
  }

  // Check both constraints (AND)
  const withinLimits = (
    minSentences <= SOURCE_DETECTION_MAX_SENTENCES_FROM_SOURCE &&
    minWords <= SOURCE_DETECTION_MAX_WORDS_FROM_SOURCE
  );

  return { withinLimits, minSentences, minWords };
}

// ============================================================================
// SENTENCE SPLITTING
// ============================================================================

/**
 * Split text into sentences with smart boundary detection
 * Handles: "Mr. Smith", "Dr. Jones", "U.S.", "U.K.", bulleted lists
 */
function splitIntoSentences(text: string): string[] {
  // FIRST: Split on bulleted/numbered list items to handle entities in separate list items
  // Patterns: "- **Entity:**", "* **Entity:**", "1. **Entity:**"
  const listItemRegex = /\n(?=[-*]|\d+\.)\s*/g;
  const listItems = text.split(listItemRegex);

  const allSentences: string[] = [];

  for (const listItem of listItems) {
    // Handle common abbreviations by temporarily replacing dots
    let processed = listItem
      .replace(/Mr\./g, 'Mr[DOT]')
      .replace(/Mrs\./g, 'Mrs[DOT]')
      .replace(/Ms\./g, 'Ms[DOT]')
      .replace(/Dr\./g, 'Dr[DOT]')
      .replace(/Prof\./g, 'Prof[DOT]')
      .replace(/U\.S\./g, 'US')
      .replace(/U\.K\./g, 'UK')
      .replace(/e\.g\./g, 'eg')
      .replace(/i\.e\./g, 'ie');

    // Split on sentence boundaries: . ! ? followed by space and capital or end
    const sentences = processed.split(/([.!?])\s+(?=[A-Z])|([.!?])$/);

    // Reconstruct sentences with their punctuation
    for (let i = 0; i < sentences.length; i++) {
      if (!sentences[i]) continue;

      let sentence = sentences[i];

      // Add punctuation back if next element is punctuation
      if (i + 1 < sentences.length && /^[.!?]$/.test(sentences[i + 1])) {
        sentence += sentences[i + 1];
        i++; // Skip the punctuation element
      }

      // Restore abbreviations
      sentence = sentence.replace(/\[DOT\]/g, '.');

      if (sentence.trim().length > 0) {
        allSentences.push(sentence.trim());
      }
    }
  }

  // Fallback: if no sentences found, return the original text as one sentence
  if (allSentences.length === 0 && text.trim().length > 0) {
    return [text.trim()];
  }

  return allSentences;
}

// ============================================================================
// CITATION RESOLUTION
// ============================================================================

/**
 * Resolve citation references [1], [8], [9] to citations array
 * Example: "text[1][8][9]" → citations[0], citations[7], citations[8]
 */
function resolveCitationReferences(context: string, citations: string[]): string[] {
  const sources: string[] = [];

  // Match [1], [8], [9], etc.
  const regex = /\[(\d+)\]/g;

  let match;
  while ((match = regex.exec(context)) !== null) {
    const citationNumber = parseInt(match[1], 10);
    const citationIndex = citationNumber - 1; // Convert to 0-based array index

    // Verify index is valid and citation exists
    if (citationIndex >= 0 && citationIndex < citations.length) {
      const citation = citations[citationIndex];
      if (citation) {
        sources.push(citation);
      }
    }
  }

  return sources;
}

// ============================================================================
// CONTEXT WINDOW EXTRACTION
// ============================================================================

/**
 * Extract context windows (±sentenceRadius sentences) around entity mentions
 */
function extractContextWindowsForEntity(
  content: string,
  entityValue: string,
  sentenceRadius: number = 2
): string[] {
  const contexts: string[] = [];

  // Split into sentences
  const sentences = splitIntoSentences(content);

  if (sentences.length === 0) {
    return [content]; // Fallback to entire content
  }

  // Find all sentences containing entity (case-insensitive)
  const matchingIndices: number[] = [];
  const normalizedEntity = entityValue.toLowerCase();

  sentences.forEach((sentence, index) => {
    if (sentence.toLowerCase().includes(normalizedEntity)) {
      matchingIndices.push(index);
    }
  });

  // If no matches found, return empty
  if (matchingIndices.length === 0) {
    return [];
  }

  // For each match, extract ±sentenceRadius context
  const extractedRanges = new Set<string>();

  for (const matchIndex of matchingIndices) {
    const startIdx = Math.max(0, matchIndex - sentenceRadius);
    const endIdx = Math.min(sentences.length - 1, matchIndex + sentenceRadius);

    const contextSentences = sentences.slice(startIdx, endIdx + 1);
    const contextText = contextSentences.join(' ');

    // Use range as key to avoid duplicate contexts
    const rangeKey = `${startIdx}-${endIdx}`;
    if (!extractedRanges.has(rangeKey)) {
      extractedRanges.add(rangeKey);
      contexts.push(contextText);
    }
  }

  return contexts;
}

// ============================================================================
// STRATEGY 1: CONTENT PROXIMITY SEARCH
// ============================================================================

/**
 * Find all links near entity mentions in content (±2 sentences)
 * Uses proven extraction function from link-extraction.ts
 * Note: This is Strategy 3 in the priority order (after annotations and sentence-start links)
 */
function findLinksNearEntityInContent(
  content: string,
  entityValue: string,
  citations: string[]
): string[] {
  const sources: string[] = [];

  // Split into sentences to find entity's exact sentence
  const sentences = splitIntoSentences(content);
  const normalizedEntity = entityValue.toLowerCase();

  // Find all sentences containing the entity
  for (const sentence of sentences) {
    if (!sentence.toLowerCase().includes(normalizedEntity)) {
      continue; // Skip sentences without entity
    }

    // Extract citation markers ONLY from this sentence
    const citationRegex = /\[(\d+)\]/g;
    let match;
    while ((match = citationRegex.exec(sentence)) !== null) {
      const citationMarker = match[0]; // e.g., "[9]"
      const citationNumber = parseInt(match[1], 10);
      const citationIndex = citationNumber - 1;

      // Check distance within THIS sentence only using defined constants
      const distanceCheck = isLinkWithinDistanceLimits(sentence, entityValue, citationMarker);

      // Use constants: SOURCE_DETECTION_MAX_SENTENCES_FROM_SOURCE and SOURCE_DETECTION_MAX_WORDS_FROM_SOURCE
      if (!distanceCheck.withinLimits) {
        continue; // Skip citations too far from entity
      }

      if (citationIndex >= 0 && citationIndex < citations.length) {
        const citationUrl = citations[citationIndex];
        if (citationUrl) {
          const cleaned = cleanUrl(citationUrl);
          if (cleaned) {
            sources.push(cleaned);
          }
        }
      }
    }

    // Also detect markdown link syntax: [Entity Name](url)
    // Handles Claude/AI answers without citations/annotations arrays
    const escapedEntity = entityValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markdownLinkRegex = new RegExp(`\\[${escapedEntity}\\]\\(([^)]+)\\)`, 'gi');
    let mdMatch;
    while ((mdMatch = markdownLinkRegex.exec(sentence)) !== null) {
      const mdUrl = mdMatch[1].trim();
      if (mdUrl && mdUrl.startsWith('http')) {
        const cleaned = cleanUrl(mdUrl);
        if (cleaned) {
          sources.push(cleaned);
        }
      }
    }

    // Also detect ANY markdown links near entity (e.g., source references)
    // Pattern: Entity text (source: [Source Name](url))
    const anyMarkdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let anyMdMatch;
    while ((anyMdMatch = anyMarkdownLinkRegex.exec(sentence)) !== null) {
      const linkText = anyMdMatch[1];
      const mdUrl = anyMdMatch[2].trim();

      // Skip if this is the entity-name link (already handled above)
      if (linkText.toLowerCase() === entityValue.toLowerCase()) {
        continue;
      }

      // Check distance from entity to this markdown link
      const distanceCheck = isLinkWithinDistanceLimits(sentence, entityValue, anyMdMatch[0]);
      if (!distanceCheck.withinLimits) {
        continue;
      }

      if (mdUrl && mdUrl.startsWith('http')) {
        const cleaned = cleanUrl(mdUrl);
        if (cleaned) {
          sources.push(cleaned);
        }
      }
    }

    // Also detect PLAIN URLs near entity (not markdown formatted)
    // Pattern: Entity text https://example.com or http://example.com
    // Exclude ] and [ to prevent matching through markdown syntax like ](
    const plainUrlRegex = /(https?:\/\/[^\s\)\[\]]+)/g;
    let plainMatch;
    while ((plainMatch = plainUrlRegex.exec(sentence)) !== null) {
      const plainUrl = plainMatch[1].trim();

      // Check distance from entity to this plain URL
      const distanceCheck = isLinkWithinDistanceLimits(sentence, entityValue, plainMatch[0]);
      if (!distanceCheck.withinLimits) {
        continue;
      }

      if (plainUrl && plainUrl.startsWith('http')) {
        const cleaned = cleanUrl(plainUrl);
        if (cleaned) {
          sources.push(cleaned);
        }
      }
    }
  }

  return sources;
}

// ============================================================================
// STRATEGY 2: SENTENCE-START LINKS
// ============================================================================

/**
 * Find links at the beginning of sentences or paragraphs near entity mentions
 * Pattern: "www.example.com - information about entity"
 * Priority: Check 2 sentences forward, then backward to paragraph start
 */
function findLinksAtSentenceStart(
  content: string,
  entityValue: string,
  citations: string[]
): string[] {
  const sources: string[] = [];
  const sentences = splitIntoSentences(content);

  if (sentences.length === 0) return sources;

  const normalizedEntity = entityValue.toLowerCase();

  // Find all sentences containing entity
  const matchingIndices: number[] = [];
  sentences.forEach((sentence, index) => {
    if (sentence.toLowerCase().includes(normalizedEntity)) {
      matchingIndices.push(index);
    }
  });

  if (matchingIndices.length === 0) return sources;

  const foundUrls = new Set<string>(); // Avoid duplicates

  for (const matchIndex of matchingIndices) {
    // Strategy 2a: Scan 2 sentences FORWARD for sentence-start links
    const forwardEnd = Math.min(sentences.length - 1, matchIndex + 2);

    for (let i = matchIndex; i <= forwardEnd; i++) {
      const sentence = sentences[i].trim();

      // Check if sentence starts with a link (allow whitespace)
      const startsWithUrl = /^\s*(https?:\/\/|www\.|[a-z0-9][-a-z0-9]*\.[a-z]{2,})/i.test(sentence);

      if (startsWithUrl) {
        // Extract all markdown and plain URL formats using proven extraction function
        const links = extractLinksFromContent(sentence);

        for (const link of links) {
          if (!foundUrls.has(link)) {
            foundUrls.add(link);
            sources.push(link);
            break; // Take first link only
          }
        }
        if (sources.length > 0) break; // Stop forward scan after first link
      }
    }

    // Strategy 2b: Scan BACKWARD to paragraph start for sentence-start links
    // (only if we haven't found links forward)
    if (sources.length === 0) {
      for (let i = matchIndex - 1; i >= 0; i--) {
        const sentence = sentences[i].trim();

        // Stop at likely paragraph boundary (empty or very short)
        if (sentence.length < 10) break;

        const startsWithUrl = /^\s*(https?:\/\/|www\.|[a-z0-9][-a-z0-9]*\.[a-z]{2,})/i.test(sentence);

        if (startsWithUrl) {
          // Extract all markdown and plain URL formats using proven extraction function
          const links = extractLinksFromContent(sentence);

          for (const link of links) {
            if (!foundUrls.has(link)) {
              foundUrls.add(link);
              sources.push(link);
            }
          }
          break; // Only take the first paragraph-start link found
        }
      }
    }
  }

  return sources;
}

// ============================================================================
// STRATEGY 3: ANNOTATIONS SEARCH
// ============================================================================

/**
 * Find links in annotations where entity is mentioned
 * Checks: title, content, and url fields (with encoding variations)
 */
function findLinksInAnnotations(
  entityValue: string,
  annotations: any[]
): string[] {
  const sources: string[] = [];
  const normalizedEntity = entityValue.toLowerCase().trim();

  if (!annotations || !Array.isArray(annotations)) {
    return sources;
  }

  for (const annotation of annotations) {
    if (annotation.type !== 'url_citation') continue;

    const citation = annotation.url_citation;
    if (!citation || !citation.url) continue;

    let found = false;

    // Field 1: Check title
    if (citation.title && citation.title.toLowerCase().includes(normalizedEntity)) {
      const cleaned = cleanUrl(citation.url);
      if (cleaned) sources.push(cleaned);
      found = true;
    }

    // Field 2: Check content (OpenAI provides this with snippets)
    if (!found && citation.content && citation.content.toLowerCase().includes(normalizedEntity)) {
      const cleaned = cleanUrl(citation.url);
      if (cleaned) sources.push(cleaned);
      found = true;
    }

    // Field 3: Check URL (with encoding variations)
    if (!found) {
      const urlDecoded = decodeURIComponent(citation.url).toLowerCase();
      const urlVariations = [
        normalizedEntity,
        normalizedEntity.replace(/ /g, '-'),   // "Naval Ravikant" → "naval-ravikant"
        normalizedEntity.replace(/ /g, '_'),   // "Naval Ravikant" → "naval_ravikant"
        normalizedEntity.replace(/ /g, '%20')  // "Naval Ravikant" → "naval%20ravikant"
      ];

      for (const variation of urlVariations) {
        if (urlDecoded.includes(variation)) {
          const cleaned = cleanUrl(citation.url);
          if (cleaned) sources.push(cleaned);
          break;
        }
      }
    }
  }

  return sources;
}

// ============================================================================
// STRATEGY 4: CITATIONS DIRECT SEARCH
// ============================================================================

/**
 * Find citations where entity name appears in URL
 */
function findLinksInCitations(
  entityValue: string,
  citations: string[]
): string[] {
  const sources: string[] = [];
  const normalizedEntity = entityValue.toLowerCase().trim();

  if (!citations || !Array.isArray(citations)) {
    return sources;
  }

  for (const citationUrl of citations) {
    if (!citationUrl) continue;

    const urlDecoded = decodeURIComponent(citationUrl).toLowerCase();

    // Check if entity name appears in URL
    const variations = [
      normalizedEntity,
      normalizedEntity.replace(/ /g, '-'),
      normalizedEntity.replace(/ /g, '_')
    ];

    for (const variation of variations) {
      if (urlDecoded.includes(variation)) {
        const cleaned = cleanUrl(citationUrl);
        if (cleaned) sources.push(cleaned);
        break;
      }
    }
    if (sources.length > 0) break; // Stop after first citation found
  }

  return sources;
}

// ============================================================================
// ANSWER FILE LOADING
// ============================================================================

/**
 * Load all answer.json files for a question and date
 * Returns array with file paths and extracted botss
 */
async function loadAnswerJsonFiles(
  project: string,
  questionFolder: string,
  targetDate: string
): Promise<AnswerFileInfo[]> {
  const answersDir = path.join(
    QUESTIONS_DIR(project),
    questionFolder,
    'answers',
    targetDate
  );

  const files: AnswerFileInfo[] = [];

  try {
    const modelDirs = await fs.readdir(answersDir, { withFileTypes: true });

    for (const modelDir of modelDirs) {
      if (!modelDir.isDirectory()) continue;

      const answerPath = path.join(answersDir, modelDir.name, 'answer.json');

      try {
        await fs.access(answerPath);
        files.push({
          path: answerPath,
          bots: modelDir.name  // Extract bots directly from directory name
        });
      } catch {
        // answer.json doesn't exist for this model
        logger.debug(`No answer.json found at ${answerPath}`);
        continue;
      }
    }
  } catch (error) {
    logger.debug(`Cannot read answers directory: ${answersDir}`);
  }

  return files;
}

/**
 * Load all answer.json files from ALL questions for aggregated processing
 * Used when processing _all-questions-combined folder
 */
async function loadAllAnswerFilesForAllQuestions(
  project: string,
  questions: any[],
  targetDate: string
): Promise<AnswerFileInfo[]> {
  const allFiles: AnswerFileInfo[] = [];

  for (const question of questions) {
    // Skip the aggregated folder itself
    if (question.folder === AGGREGATED_DIR_NAME) continue;

    const files = await loadAnswerJsonFiles(project, question.folder, targetDate);
    allFiles.push(...files);
  }

  return allFiles;
}

/**
 * Get valid previous dates for scanning historical sources
 * Only includes dates with complete answers from all models
 */
async function getPreviousDates(
  project: string,
  targetDate: string
): Promise<string[]> {
  try {
    const { getDatesWithCompleteAnswers } = await import('../utils/project-utils.js');
    const allCompleteDates = await getDatesWithCompleteAnswers(project);

    if (!allCompleteDates || allCompleteDates.length === 0) {
      return [];
    }

    // Filter to dates before target date and take first MAX_PREVIOUS_DATES
    return allCompleteDates
      .filter(date => date < targetDate)
      .slice(0, MAX_PREVIOUS_DATES);
  } catch (error) {
    logger.debug(`Could not get previous dates: ${error}`);
    return [];
  }
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Main function to extract source links for all non-computed entities
 */
export async function enrichGetSourceLinksForEntities(
  project: string,
  targetDate: string
): Promise<void> {
  logger.info(`Extracting source links for entities in project: ${project} (date: ${targetDate})`);

  // Non-computed sections to process (brands is the new unified section, others kept for backward compatibility)
  const NON_COMPUTED_SECTIONS = ['brands', 'products', 'organizations', 'persons', 'keywords', 'places', 'events', 'links'];

  // Read all question directories (including _all-questions-combined)
  const questionsDir = QUESTIONS_DIR(project);
  const questionDirs = await fs.readdir(questionsDir, { withFileTypes: true }) as DirentLike[];
  const actualQuestions = questionDirs.filter(d => d.isDirectory());

  // Also get question metadata for aggregated processing
  const questionsList = await readQuestions(project);

  logger.info(`Processing ${actualQuestions.length} question folders`);
  logger.startProgress(actualQuestions.length, 'questions');

  let processedCount = 0;
  let totalEntitiesProcessed = 0;
  let totalSourcesFound = 0;

  for (const [index, dir] of actualQuestions.entries()) {
    const currentIndex = index + 1;
    logger.updateProgress(currentIndex, `Processing ${dir.name}...`);

    // Path to compiled data file
    const compiledFile = path.join(
      QUESTION_DATA_COMPILED_DATE_DIR(project, dir.name, targetDate),
      `${targetDate}-data.js`
    );

    // Check if compiled file exists
    try {
      await fs.access(compiledFile);
    } catch {
      throw createMissingFileError(dir.name, compiledFile, CURRENT_MODULE_NAME);
    }

    try {
      // Load compiled data
      const { data, dataKey } = await loadDataJs(compiledFile);
      const verifiedSourceUrls = getVerifiedSourceUrls(data);

      // Variables for previous dates scanning
      let previousDates: string[] | null = null;
      const isAggregated = dir.name === AGGREGATED_DIR_NAME;
      const scannedPreviousDates = false; // Kept for future per-question optimization

      // Load answer.json files
      // For aggregated folder, load ALL answers from ALL questions
      // For individual questions, load only that question's answers
      const answerFiles = isAggregated
        ? await loadAllAnswerFilesForAllQuestions(project, questionsList, targetDate)
        : await loadAnswerJsonFiles(project, dir.name, targetDate);

      if (answerFiles.length === 0) {
        logger.warn(`No answer.json files found for ${dir.name}`);
        continue;
      }

      logger.debug(`  Found ${answerFiles.length} answer files for ${dir.name}`);

      // Process each non-computed section
      for (const sectionName of NON_COMPUTED_SECTIONS) {
        if (!data[sectionName] || !Array.isArray(data[sectionName])) {
          continue;
        }

        // Process each item in section
        for (const item of data[sectionName]) {
          if (!item.value) continue;

          const allSources: EntitySource[] = [];

          // Process each answer file
          for (const answerFile of answerFiles) {
            try {
              const answerContent = await fs.readFile(answerFile.path, 'utf-8');
              const answer = JSON.parse(answerContent);

              const choice = answer.choices?.[0];
              if (!choice) continue;

              const content = choice.message?.content || '';
              const annotations = choice.message?.annotations || [];
              const citations = answer.citations || [];

              // Primary strategies (always run together): Annotations + Citation markers
              // Fallback strategies (only if primary found nothing): Sentence-start + Citations direct
              let foundInThisAnswer = false;

              // Strategy 1: Annotations (title + content + url)
              const annotationLinks = findLinksInAnnotations(item.value, annotations);
              for (const url of annotationLinks) {
                allSources.push({ url, bots: answerFile.bots, dates: [targetDate] });
              }

              // Strategy 3: Content proximity (citation markers)
              const contentLinks = findLinksNearEntityInContent(content, item.value, citations);
              for (const url of contentLinks) {
                allSources.push({ url, bots: answerFile.bots, dates: [targetDate] });
              }

              // Mark as found if either Strategy 1 or 3 found anything
              if (annotationLinks.length > 0 || contentLinks.length > 0) {
                foundInThisAnswer = true;
              }

              // Strategy 2: Sentence-start links (fallback only)
              if (!foundInThisAnswer) {
                const sentenceStartLinks = findLinksAtSentenceStart(content, item.value, citations);
                if (sentenceStartLinks.length > 0) {
                  for (const url of sentenceStartLinks) {
                    allSources.push({ url, bots: answerFile.bots, dates: [targetDate] });
                  }
                  foundInThisAnswer = true;
                }
              }

              // Strategy 4: Citations direct (last resort)
              if (!foundInThisAnswer) {
                const citationLinks = findLinksInCitations(item.value, citations);
                for (const url of citationLinks) {
                  allSources.push({ url, bots: answerFile.bots, dates: [targetDate] });
                }
              }

            } catch (error) {
              logger.debug(`Error reading answer file ${answerFile.path}: ${error}`);
              continue;
            }
          }

          // If no sources found or item has zero mentions (disappeared), scan previous dates
          const hasZeroMentions = (item.mentions === 0 || item.mentions === '0');
          if ((allSources.length === 0 || hasZeroMentions) && !scannedPreviousDates) {
            // Get previous dates (lazy load once per question)
            if (!previousDates) {
              previousDates = await getPreviousDates(project, targetDate);
            }

            if (previousDates.length > 0) {
              logger.debug(`Scanning ${previousDates.length} previous dates for sources of "${item.value}"`);

              // Scan each previous date
              for (const prevDate of previousDates) {
                const prevAnswerFiles = isAggregated
                  ? await loadAllAnswerFilesForAllQuestions(project, questionsList, prevDate)
                  : await loadAnswerJsonFiles(project, dir.name, prevDate);

                if (prevAnswerFiles.length === 0) continue;

                // Process each answer file from previous date
                for (const answerFile of prevAnswerFiles) {
                  try {
                    const answerContent = await fs.readFile(answerFile.path, 'utf-8');
                    const answer = JSON.parse(answerContent);

                    const choice = answer.choices?.[0];
                    if (!choice) continue;

                    const content = choice.message?.content || '';
                    const annotations = choice.message?.annotations || [];
                    const citations = answer.citations || [];

                    let foundInPrevAnswer = false;

                    // Use same strategies for previous dates
                    const annotationLinks = findLinksInAnnotations(item.value, annotations);
                    for (const url of annotationLinks) {
                      allSources.push({ url, bots: answerFile.bots, dates: [prevDate] });
                    }

                    const contentLinks = findLinksNearEntityInContent(content, item.value, citations);
                    for (const url of contentLinks) {
                      allSources.push({ url, bots: answerFile.bots, dates: [prevDate] });
                    }

                    if (annotationLinks.length > 0 || contentLinks.length > 0) {
                      foundInPrevAnswer = true;
                    }

                    if (!foundInPrevAnswer) {
                      const sentenceStartLinks = findLinksAtSentenceStart(content, item.value, citations);
                      if (sentenceStartLinks.length > 0) {
                        for (const url of sentenceStartLinks) {
                          allSources.push({ url, bots: answerFile.bots, dates: [prevDate] });
                        }
                        foundInPrevAnswer = true;
                      }
                    }

                    if (!foundInPrevAnswer) {
                      const citationLinks = findLinksInCitations(item.value, citations);
                      for (const url of citationLinks) {
                        allSources.push({ url, bots: answerFile.bots, dates: [prevDate] });
                      }
                    }

                  } catch (error) {
                    logger.debug(`Error reading previous answer file ${answerFile.path}: ${error}`);
                    continue;
                  }
                }
              }
            }
          }

          // Deduplicate by (url + bots) combination
          item.sources = filterSourcesToVerifiedLinks(
            deduplicateSources(allSources),
            verifiedSourceUrls
          );

          if (item.sources.length > 0) {
            totalEntitiesProcessed++;
            totalSourcesFound += item.sources.length;

            // Calculate unique URLs and bots for this entity
            const uniqueUrls = new Set(item.sources.map(s => s.url)).size;
            const uniqueBots = new Set(item.sources.map(s => s.bots)).size;

            logger.debug(
              `  ${sectionName}:"${item.value}" → ${item.sources.length} sources ` +
              `(${uniqueUrls} unique URLs, ${uniqueBots} bots)`
            );
          }
        }
      }

      // Save enriched data back to file
      const comment = `// Source links extracted on ${new Date().toISOString()}`;
      await saveDataJs(compiledFile, dataKey, data, comment);

      processedCount++;
      logger.updateProgress(currentIndex, `${dir.name} - ✓`);

    } catch (error) {
      logger.error(`Failed to process ${dir.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw new PipelineCriticalError(
        `Failed to process ${dir.name}: ${error instanceof Error ? error.message : String(error)}`,
        CURRENT_MODULE_NAME,
        project
      );
    }
  }

  // Complete progress
  logger.completeProgress(`Processed ${processedCount} questions`);

  // Add summary statistics
  logger.addStat('Questions processed', processedCount);
  logger.addStat('Entities with sources', totalEntitiesProcessed);
  logger.addStat('Total source links', totalSourcesFound);
  if (totalEntitiesProcessed > 0) {
    logger.addStat('Avg sources per entity', (totalSourcesFound / totalEntitiesProcessed).toFixed(1));
  }

  logger.info(`Source link extraction complete`);
  await logger.showSummary();
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  // Initialize logger
  await logger.initialize(import.meta.url, project);

  await enrichGetSourceLinksForEntities(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
});
