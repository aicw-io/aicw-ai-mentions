import { promises as fs } from 'fs';
import path from 'path';
import { QUESTION_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { getProjectNameFromCommandLine, getTargetDateFromProjectOrEnvironment, loadProjectModelConfigs, ModelType, readQuestions, validateAndLoadProject } from '../utils/project-utils.js';
import { writeFileAtomic } from '../utils/misc-utils.js';
import { PipelineCriticalError } from '../utils/pipeline-errors.js';
import { MAIN_SECTIONS } from '../config/constants-entities.js';
// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
import { getCurrentDateTimeAsString } from '../config/user-paths.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

/**
 * Main function to create initial data files from template
 */
export async function dataFilePrepare(project: string, targetDate: string): Promise<void> {

  logger.info(`Initializing "${targetDate}-data.js" files for project: ${project}`);

  const questions = await readQuestions(project);

  // Add aggregate entry
  questions.push({
    folder: AGGREGATED_DIR_NAME,
    question: `${project} - Aggregate Report`
  });

  logger.info(`Processing ${questions.length} questions for date: ${targetDate}`);

  // Start progress tracking
  logger.startProgress(questions.length, 'questions');

  let processedCount = 0;

  for (const [index, question] of questions.entries()) {
    const currentIndex = index + 1;
    logger.updateProgress(currentIndex, `Processing ${question.folder}...`);

    // Determine output path
    const compiledDir = QUESTION_DATA_COMPILED_DATE_DIR(project, question.folder, targetDate);
    const dataFile = path.join(compiledDir, `${targetDate}-data.js`);

    // we assume that the data was removed by the previous action

    try {
      // Create directory if needed
      await fs.mkdir(compiledDir, { recursive: true });

      // date without dashes
      const dateWithoutDashes = targetDate.replace(/-/g, '');

      // information about AI models for this project
      // getting list of AI models for this project for answer fetching
      const projectAIModels = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);
      const projectAIModelsAsJson = JSON.stringify(projectAIModels.map(m => ({
        id: m.id,
        name: m.display_name,
        url: m.url,
        estimated_mau: m.estimated_mau || 0
      })));      

      const data: Record<string, unknown> = {
        report_question: question.question,
        report_date: targetDate,
        report_question_id: question.folder,
        report_created_at: getCurrentDateTimeAsString(),
        bots: JSON.parse(projectAIModelsAsJson)
      };
      for (const sectionName of MAIN_SECTIONS) {
        data[sectionName] = [];
      }

      const filled = `window.AppData${dateWithoutDashes} = ${JSON.stringify(data, null, 2)};\n`;

      // Write data file
      await writeFileAtomic(dataFile, filled);

      processedCount++;
      logger.updateProgress(currentIndex, `${question.folder} - ✓`);
      logger.info(`Created data file for ${question.folder}`);

    } catch (error) {
      logger.error(`Failed to process ${question.folder}: ${error instanceof Error ? error.message : String(error)}`);
      throw new PipelineCriticalError(
        `Failed to process "${question.folder}" for "${project}" for date "${targetDate}": ${error instanceof Error ? error.message : String(error)}`, 
        CURRENT_MODULE_NAME, 
        project
      );    
    }
  }

  // Complete progress
  logger.completeProgress(`Created ${processedCount} data files`);

  // Add summary stats
  logger.addStat('Created', processedCount);

  logger.info(`Data file creation complete. Created: ${processedCount}`);
  await logger.showSummary();
}

// CLI entry point
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  // Initialize logger
  await logger.initialize(import.meta.url, project);


  await dataFilePrepare(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
