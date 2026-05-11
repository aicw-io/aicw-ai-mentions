import { promises as fs } from 'fs';
import path from 'path';
import vm from 'node:vm';
import { DirentLike } from '../config/types.js';
import { QuestionEntry } from '../config/types.js';
import { QUESTIONS_DIR, QUESTION_DATA_COMPILED_DATE_DIR, PROJECT_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { waitForEnterInInteractiveMode, writeFileAtomic } from '../utils/misc-utils.js';
import { logger } from '../utils/compact-logger.js';
import { extractDomainFromUrl } from '../utils/url-utils.js';
import { cleanContentFromAI } from '../utils/content-cleaner.js';
import { loadProjectModelConfigs, getTargetDateFromProjectOrEnvironment, getProjectNameFromCommandLine, validateAndLoadProject } from '../utils/project-utils.js';
import { loadDataJs, saveDataJs, readQuestions } from '../utils/project-utils.js';
import { PipelineCriticalError, createMissingFileError, createMissingDataError } from '../utils/pipeline-errors.js';
import { prepareStepFiles } from '../utils/enrich-data-utils.js';
import { ModelType } from '../utils/project-utils.js';
// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);



/**
 * Create linkDomains array from classified links by aggregating mentions
 * Groups individual source links by domain and aggregates their mentions.
 */
function createLinkDomainsMentions(sources: any[], models: any[], currentDate: string): any[] {
  logger.debug('Starting linkDomains mentions aggregation');

  // Create a map to group sources by domain
  const domainMap = new Map<string, any>();

  // Process each source
  for (const source of sources) {
    const url = source.link || source.value || '';
    const domain = extractDomainFromUrl(url);

    if (!domain) continue; // Skip if no valid domain

    if (!domainMap.has(domain)) {
      // Initialize the linkDomain entry
      domainMap.set(domain, {
        type: 'linkDomain',
        code: domain,
        value: domain,
        link: 'https://' + domain,
        mentions: 0,
        mentionsByModel: {},
        excerptsByModel: {}, // Aggregated excerpts from all links in this domain
        sources: [], // Keep for subsequent calculations
        bots: new Set<string>(),
        botCount: 0,
        uniqueModelCount: 0
      });
    }

    const domainEntry = domainMap.get(domain)!;

    // Aggregate mentions
    domainEntry.mentions += source.mentions || 0;

    // Aggregate mentions by model
    if (source.mentionsByModel) {
      for (const [modelId, mentions] of Object.entries(source.mentionsByModel)) {
        domainEntry.mentionsByModel[modelId] = (domainEntry.mentionsByModel[modelId] || 0) + (mentions as number);
      }
    }

    // Collect bots that mentioned this source
    if (source.bots) {
      source.bots.split(',').forEach((bot: string) => {
        if (bot) domainEntry.bots.add(bot);
      });
    }

    // Aggregate excerpts from source links
    if (source.excerptsByModel) {
      for (const [modelId, excerpts] of Object.entries(source.excerptsByModel)) {
        if (!domainEntry.excerptsByModel[modelId]) {
          domainEntry.excerptsByModel[modelId] = [];
        }
        // Add link URL to each excerpt for context on source pages
        const excerptsWithLink = (excerpts as any[]).map(excerpt => ({
          ...excerpt,
          sourceLink: source.link || source.value
        }));
        domainEntry.excerptsByModel[modelId].push(...excerptsWithLink);
      }
    }

    // Keep track of individual sources for subsequent calculations
    domainEntry.sources.push({
      link: source.link,
      mentions: source.mentions,
      appearanceOrder: source.appearanceOrder,
      appearanceOrderByModel: source.appearanceOrderByModel,
      mentionsByModel: source.mentionsByModel,
      influence: source.influence,
      influenceByModel: source.influenceByModel,
      weightedInfluence: source.weightedInfluence
    });
  }

  // Convert map to array and finalize mentions calculations
  const linkDomains = Array.from(domainMap.values()).map(entry => {
    // Convert bots Set to comma-separated string
    entry.bots = Array.from(entry.bots).sort().join(',');
    entry.botCount = entry.bots ? entry.bots.split(',').length : 0;
    entry.uniqueModelCount = entry.botCount;

    // Calculate mentionsAsPercentByModel
    entry.mentionsAsPercentByModel = {};
    models.forEach(model => {
      const totalMentions = sources.reduce((sum, s) =>
        sum + ((s.mentionsByModel && s.mentionsByModel[model.id]) || 0), 0
      );
      entry.mentionsAsPercentByModel[model.id] = totalMentions > 0
        ? Number(((entry.mentionsByModel[model.id] || 0) / totalMentions).toFixed(5))
        : 0;
    });

    // Calculate appearanceOrder (earliest appearance across all sources)
    // Use minimum appearanceOrder as the domain appears when its first link appears
    const appearanceOrders = entry.sources
      .map((s: any) => s.appearanceOrder)
      .filter((order: number) => order > 0);
    entry.appearanceOrder = appearanceOrders.length > 0
      ? Math.min(...appearanceOrders)
      : -1;

    // Calculate appearanceOrderByModel (earliest appearance per model)
    entry.appearanceOrderByModel = {};
    models.forEach(model => {
      const modelAppearanceOrders = entry.sources
        .map((s: any) => s.appearanceOrderByModel?.[model.id])
        .filter((order: number | undefined) => order !== undefined && order > 0);

      if (modelAppearanceOrders.length > 0) {
        entry.appearanceOrderByModel[model.id] = Math.min(...modelAppearanceOrders);
      }
    });

    return entry;
  });

  // Calculate mentionsAsPercent
  const totalMentions = linkDomains.reduce((sum, item) => sum + (item.mentions || 0), 0);
  linkDomains.forEach(item => {
    item.mentionsAsPercent = totalMentions > 0
      ? Number((item.mentions / totalMentions).toFixed(5))
      : 0;
  });

  logger.debug(`Created ${linkDomains.length} link domains from ${sources.length} links`);
  return linkDomains;
}

/**
 * Main function to calculate mentions for linkDomains
 */
export async function enrichLinkDomainsCalculateMentions(project: string, targetDate: string): Promise<void> {
  // Initialize logger
  await logger.initialize(import.meta.url, project);

  logger.info(`Starting linkDomains mentions calculation for project: ${project}`);

  // Load project models
  const projectModels = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);

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
  let totalLinksProcessed = 0;

  for (const [index, question] of questions.entries()) {
    const currentIndex = index + 1;
    logger.updateProgress(currentIndex, `Calculating mentions for ${question.folder}...`);

    const files = await prepareStepFiles({
      project,
      questionFolder: question.folder,
      date: targetDate,
      stepName: CURRENT_MODULE_NAME
    });

    if (!files.exists) {
      throw createMissingFileError(question.folder, files.inputPath, 'enrich-link-domains-calculate-mentions');
    }

    try {


      const { data, dataKey } = await loadDataJs(files.inputPath);

      // Check if links exist - CRITICAL: links are required to create linkDomains
      const linksData = data.links || data.sources;
      if (!linksData || !Array.isArray(linksData) || linksData.length === 0) {
        const error = `CRITICAL: No "links" array were found to create linkDomains for ${question.folder} in ${files.inputPath}. Previous step probably failed.`;
        logger.error(error);
        throw new Error(error);
      }

      // Create linkDomains array with mentions calculations
      data.linkDomains = createLinkDomainsMentions(linksData, projectModels, targetDate);

      totalLinksProcessed += linksData.length;

      // Save updated data
      await saveDataJs(files.outputPath, dataKey, data);

      processedCount++;

      logger.updateProgress(currentIndex, `${question.folder} - ✓ ${data.linkDomains.length} domains`);
      logger.info(`Created ${data.linkDomains.length} link domains from ${linksData.length} links for ${question.folder}`);

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
      continue;
    }
  }

  // Complete progress
  logger.completeProgress(`Processed ${processedCount} questions`);

  // Add summary stats
  logger.addStat('Processed', processedCount);
  logger.addStat('Skipped', skippedCount);
  logger.addStat('Links Processed', totalLinksProcessed);

  logger.info(`LinkDomains mentions calculation complete. Processed: ${processedCount}, Skipped: ${skippedCount}, Links: ${totalLinksProcessed}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  await enrichLinkDomainsCalculateMentions(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
