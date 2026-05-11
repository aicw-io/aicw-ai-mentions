import { promises as fs } from 'fs';
import { DirentLike } from '../config/types.js';
import path from 'path';
import { generateAggregateReport } from '../utils/report-aggregation.js';
import { REPORT_HTML_TEMPLATE_DIR, QUESTIONS_DIR, OUTPUT_DIR, QUESTION_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { logger } from '../utils/compact-logger.js';
import { getProjectNameFromCommandLine, getTargetDateFromProjectOrEnvironment, validateAndLoadProject } from '../utils/project-utils.js';
import { getUserProjectQuestionFileContent } from '../config/user-paths.js';
import { createMissingFileError, PipelineCriticalError } from '../utils/pipeline-errors.js';
import { generateEntityPages } from '../utils/report-entity-pages.js';
import { generateSourcePages } from '../utils/report-source-pages.js';
import { generateStaticMainPage } from '../utils/report-main-static.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


// Export wrapper function for programmatic use
export async function reportGenerate(project: string): Promise<void> {
  await main(project);
}

async function main(projectArg?: string): Promise<void> {
  const project = projectArg || await getProjectNameFromCommandLine();
  const projectConfig = await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  // Get published URL base from project config (for JSON-LD structured data)
  const publishedUrlBase = projectConfig?.published_url_base || null;  
  
  await logger.initialize(import.meta.url, project);
  logger.info(`Generating reports for project: ${project}, date: ${targetDate}`);

  const baseQ: string = QUESTIONS_DIR(project);
  const outputBase: string = OUTPUT_DIR(project);

  const questionDirs: DirentLike[] = await fs.readdir(baseQ, { withFileTypes: true }) as DirentLike[];

  // Filter to get only actual question directories
  const actualQuestionsDirs = questionDirs.filter(d => d.isDirectory() && d.name !== AGGREGATED_DIR_NAME);

  // Collect all questions for cross-linking in per-question reports
  const allQuestions: Array<{ id: string; text: string }> = actualQuestionsDirs.map(d => ({
    id: d.name,
    text: getUserProjectQuestionFileContent(project, d.name)
  }));

  logger.startProgress(actualQuestionsDirs.length + 1, 'reports'); // +1 for aggregate report

  let enrichedFiles = 0;
  let processedQuestions = 0;
  let errorCount = 0;
  let dataNotFoundCount = 0;
  let currentIndex = 0;

  for (const dir of actualQuestionsDirs) {
    currentIndex++;
    logger.updateProgress(currentIndex, `Generating report for ${dir.name}...`);

    const questionId = dir.name;
    const compiledDir = QUESTION_DATA_COMPILED_DATE_DIR(project, questionId, targetDate);
    const outputDir = path.join(outputBase, questionId);
    const enrichedDataFile = path.join(compiledDir, `${targetDate}-data.js`);
    const questionContent = getUserProjectQuestionFileContent(project, questionId);

    // Check if enriched data file exists
    const hasEnrichedData = await fs.access(enrichedDataFile).then(() => true).catch(() => false);

    if (!hasEnrichedData) {
      logger.warn(`No enriched data found for ${project} for date ${targetDate}`);
      throw new PipelineCriticalError(
        `No enriched data found for ${project} for date ${targetDate}`, 
        CURRENT_MODULE_NAME,
        project
      );
    }

    try {
      // Create output directory if it doesn't exist
      await fs.mkdir(outputDir, { recursive: true });

      // Copy answers file if it exists
      const answersFile = path.join(compiledDir, `${targetDate}-answers.js`);
      try{
        await fs.access(answersFile);
      }
      catch(err){
        createMissingFileError( 
          dir.name,
          answersFile,
          CURRENT_MODULE_NAME
        )
      }

      const outputAnswersFile = path.join(outputDir, `${targetDate}-answers.js`);
      await fs.copyFile(answersFile, outputAnswersFile);
      logger.debug(`Copied answers file ${answersFile} to ${outputAnswersFile}`);

      // Build base URL for absolute URLs in JSON-LD structured data
      const baseUrl = publishedUrlBase
        ? `${publishedUrlBase}${encodeURIComponent(project)}/${questionId}/`
        : null;

      // Generate entity pages for brands
      try {
        const entityPagesGenerated = await generateEntityPages({
          project,
          questionId,
          targetDate,
          outputDir,
          templateDir: REPORT_HTML_TEMPLATE_DIR,
          enrichedDataFile,
          baseUrl
        });
        if (entityPagesGenerated > 0) {
          logger.debug(`Generated ${entityPagesGenerated} entity pages for ${dir.name}`);
        }
      } catch (entityError) {
        logger.warn(`Could not generate entity pages for ${dir.name}: ${entityError instanceof Error ? entityError.message : String(entityError)}`);
        // Don't fail the whole report generation if entity pages fail
      }

      // Generate source domain pages
      try {
        const sourcePagesGenerated = await generateSourcePages({
          project,
          questionId,
          targetDate,
          outputDir,
          templateDir: REPORT_HTML_TEMPLATE_DIR,
          enrichedDataFile,
          baseUrl
        });
        if (sourcePagesGenerated > 0) {
          logger.debug(`Generated ${sourcePagesGenerated} source pages for ${dir.name}`);
        }
      } catch (sourceError) {
        logger.warn(`Could not generate source pages for ${dir.name}: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}`);
        // Don't fail the whole report generation if source pages fail
      }

      // Generate static SEO-friendly main page
      try {
        const staticResult = await generateStaticMainPage({
          project,
          questionId,
          targetDate,
          outputDir,
          templateDir: REPORT_HTML_TEMPLATE_DIR,
          enrichedDataFile,
          isAggregate: false,
          questionText: questionContent,
          questions: allQuestions,
          baseUrl: baseUrl || undefined
        });
        if (staticResult) {
          logger.debug(`Generated static main page for ${dir.name}`);
        }
      } catch (staticError) {
        logger.warn(`Could not generate static main page for ${dir.name}: ${staticError instanceof Error ? staticError.message : String(staticError)}`);
        // Don't fail if static page generation fails
      }

      // Report generation successful for this question

      enrichedFiles++;
      processedQuestions++;
      logger.updateProgress(currentIndex, `${dir.name} - ✓`);
    } catch (error) {
      logger.error(`Error generating report for ${dir.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  // Generate aggregate report
  currentIndex++;
  logger.updateProgress(currentIndex, `Generating aggregate report...`);

  try {
    await generateAggregateReport(project, targetDate);
    logger.updateProgress(currentIndex, `Aggregate report - ✓`);
  } catch (error) {
    logger.error(`Error generating aggregate report: ${error instanceof Error ? error.message : String(error)}`);
    errorCount++;
  }

  logger.completeProgress('Report generation complete');

  logger.info(`\nReport generation complete:`);
  logger.info(`  Processed: ${processedQuestions} questions`);
  if (dataNotFoundCount > 0) logger.warn(`  No data found: ${dataNotFoundCount} questions`);
  if (errorCount > 0) logger.error(`  Errors: ${errorCount} questions`);

  await logger.showSummary();

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
