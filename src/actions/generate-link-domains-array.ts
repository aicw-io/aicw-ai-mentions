import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { extractDomainFromUrl } from '../utils/url-utils.js';
import { getTargetDateFromProjectOrEnvironment, getProjectNameFromCommandLine, validateAndLoadProject } from '../utils/project-utils.js';
import { readQuestions, loadDataJs, saveDataJs } from '../utils/project-utils.js';
import { PipelineCriticalError, createMissingFileError, createMissingDataError } from '../utils/pipeline-errors.js';
import { prepareStepFiles } from '../utils/enrich-data-utils.js';
// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

/**
 * Create linkDomains array by grouping links by their domain
 */
function createLinkDomainsFromLinks(links: any[]): any[] {
  const domainMap = new Map<string, any>();

  for (const link of links) {
    // Extract domain from link URL
    const url = link.link || link.value || '';
    const domain = extractDomainFromUrl(url);

    if (!domain) continue; // Skip if no valid domain

    if (!domainMap.has(domain)) {
      domainMap.set(domain, {
        type: 'linkDomain',
        code: domain,
        value: domain,
        link: 'https://' + domain
      });
    }
  }

  return Array.from(domainMap.values());
}

/**
 * Main function to generate linkDomains from classified links
 */
export async function generateLinkDomains(project: string, targetDate: string): Promise<void> {
  // Initialize logger
  await logger.initialize(import.meta.url, project);

  logger.info(`Generating linkDomains from classified links for project: ${project}`);

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
  let totalLinkDomainsCreated = 0;

  for (const [index, question] of questions.entries()) {
    const currentIndex = index + 1;
    logger.updateProgress(currentIndex, `Generating linkDomains for ${question.folder}...`);

    const files = await prepareStepFiles({
      project,
      questionFolder: question.folder,
      date: targetDate,
      stepName: logger.currentActionName
    });

    // Check if input exists
    if (!files.exists) {
      throw createMissingFileError(question.folder, files.inputPath, logger.currentActionName);
    }

    try {
      // Load compiled data
      const { data, dataKey } = await loadDataJs(files.inputPath);

      // Check if links exist - CRITICAL: links are required to generate linkDomains
      if (!data.links || !Array.isArray(data.links) || data.links.length === 0) {
        throw createMissingDataError(question.folder, 'Links', CURRENT_MODULE_NAME, logger.currentActionName);
      }

      // Generate linkDomains from links
      data.linkDomains = createLinkDomainsFromLinks(data.links);

      const linkDomainCount = data.linkDomains.length;
      totalLinkDomainsCreated += linkDomainCount;

      // Save updated data
      await saveDataJs(files.outputPath, dataKey, data);

      processedCount++;

      logger.updateProgress(currentIndex, `${question.folder} - ✓ ${linkDomainCount} domains from ${data.links.length} links`);
      logger.info(`Generated ${linkDomainCount} link domains from ${data.links.length} links for ${question.folder}`);

    } catch (error) {
      // Re-throw critical errors to stop pipeline
      if (error instanceof PipelineCriticalError) {
        logger.error(`Pipeline-stopping error in ${error.questionFolder}: ${error.message}`);
        throw error;
      }

      // Log and throw for other errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to process ${question.folder}: ${errorMsg}`);
      throw new PipelineCriticalError(
        `Failed to process ${question.folder}: ${errorMsg}`,
        logger.currentActionName,
        project
      );
    }
  }

  // Complete progress
  logger.completeProgress(`Processed ${processedCount} questions`);

  // Add summary stats
  logger.addStat('Processed', processedCount);
  logger.addStat('LinkDomains Created', totalLinkDomainsCreated);

  logger.info(`LinkDomains generation complete. Processed: ${processedCount}, LinkDomains: ${totalLinkDomainsCreated}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  await generateLinkDomains(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
