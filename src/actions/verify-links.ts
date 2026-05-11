import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { getTargetDateFromProjectOrEnvironment, getProjectNameFromCommandLine, validateAndLoadProject } from '../utils/project-utils.js';
import { readQuestions, loadDataJs, saveDataJs } from '../utils/project-utils.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { prepareStepFiles } from '../utils/enrich-data-utils.js';
import { createMissingFileError, PipelineCriticalError } from '../utils/pipeline-errors.js';
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
import { validateLinks } from '../utils/validate-links.js';
import { lookup } from 'node:dns/promises';

const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

function shouldCheckReachability(): boolean {
  return process.env.AICW_VERIFY_LINKS !== 'false';
}

async function canResolveKnownDomain(): Promise<boolean> {
  const probeDomains = ['aicw.io', 'github.com', 'google.com'];
  const results = await Promise.all(
    probeDomains.map(async domain => {
      try {
        await lookup(domain);
        return true;
      } catch {
        return false;
      }
    })
  );

  return results.some(Boolean);
}

function getLinkValue(link: unknown): string {
  if (!link || typeof link !== 'object') return '';
  const item = link as Record<string, unknown>;
  if (typeof item.link === 'string' && item.link.trim()) return item.link;
  if (typeof item.value === 'string' && item.value.trim()) return item.value;
  return '';
}

export async function verifyLinks(project: string, targetDate: string): Promise<void> {
  await logger.initialize(import.meta.url, project);
  logger.info(`Verifying links for project: ${project}`);

  const questions = await readQuestions(project);
  questions.push({
    folder: AGGREGATED_DIR_NAME,
    question: `${project} - Aggregate Report`
  });

  logger.startProgress(questions.length, 'questions');

  let processedCount = 0;
  let totalBefore = 0;
  let totalRemoved = 0;
  let checkReachability = shouldCheckReachability();
  if (checkReachability && !(await canResolveKnownDomain())) {
    logger.warn(
      'DNS is unavailable in this environment. Skipping live link checks and keeping syntax-valid links.'
    );
    checkReachability = false;
  }

  for (const [index, question] of questions.entries()) {
    const currentIndex = index + 1;
    logger.updateProgress(currentIndex, `Verifying links for ${question.folder}...`);

    const files = await prepareStepFiles({
      project,
      questionFolder: question.folder,
      date: targetDate,
      stepName: CURRENT_MODULE_NAME
    });

    if (!files.exists) {
      throw createMissingFileError(question.folder, files.inputPath, CURRENT_MODULE_NAME);
    }

    try {
      const { data, dataKey } = await loadDataJs(files.inputPath);
      const links = Array.isArray(data.links) ? data.links : [];

      if (links.length === 0) {
        processedCount++;
        logger.updateProgress(currentIndex, `${question.folder} - no links`);
        continue;
      }

      const candidates = links.map(getLinkValue);
      const results = await validateLinks(candidates, { checkReachability });
      const validLinks = links.filter((_, linkIndex) => results[linkIndex]?.valid);
      const removed = links.length - validLinks.length;

      const dnsFailures = results.filter(result => !result.valid && result.reason === 'dns-not-found').length;
      if (checkReachability && results.length >= 3 && dnsFailures === results.length) {
        logger.warn(
          `DNS checks failed for every link in ${question.folder}. Keeping existing links to avoid false removals.`
        );
        totalBefore += links.length;
        processedCount++;
        logger.updateProgress(currentIndex, `${question.folder} - kept existing links (DNS unavailable)`);
        continue;
      }

      if (removed > 0) {
        const removedResults = results.filter(result => !result.valid);
        logger.info(
          `Removed ${removed} invalid link${removed !== 1 ? 's' : ''} from ${question.folder}: ` +
          removedResults.map(result => `${result.link} (${result.reason || 'invalid'})`).join(', ')
        );
      }

      data.links = validLinks;
      delete data.linkDomains;
      await saveDataJs(files.outputPath, dataKey, data);

      totalBefore += links.length;
      totalRemoved += removed;
      processedCount++;
      logger.updateProgress(currentIndex, `${question.folder} - ✓ ${validLinks.length}/${links.length} links kept`);
    } catch (error) {
      if (error instanceof PipelineCriticalError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new PipelineCriticalError(
        `Failed to verify links for ${question.folder}: ${message}`,
        CURRENT_MODULE_NAME,
        project
      );
    }
  }

  logger.completeProgress(`Processed ${processedCount} questions`);
  logger.addStat('Processed', processedCount);
  logger.addStat('Links Checked', totalBefore);
  logger.addStat('Links Removed', totalRemoved);
  logger.info(`Link verification complete. Checked: ${totalBefore}, Removed: ${totalRemoved}`);
  await logger.showSummary();
}

async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  await verifyLinks(project, targetDate);
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
});
