import { promises as fs } from 'fs';
import { DirentLike } from '../config/types.js';
import path from 'path';
import { generateAggregateReport } from '../utils/report-aggregation.js';
import { generateAnswersFile } from './report-generate-answers-file.js';
import { REPORT_HTML_TEMPLATE_DIR, QUESTIONS_DIR, REPORT_DIR, OUTPUT_DIR, PROJECT_REPORTS_DIR, REPORTS_BY_DATE_DIR, QUESTION_DATA_COMPILED_DATE_DIR, QUESTION_DATA_COMPILED_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { writeFileAtomic, drawBox, colorize, waitForEnterInInteractiveMode, replaceMacrosInTemplate } from '../utils/misc-utils.js';
import { logger } from '../utils/compact-logger.js';
import { generateProjectNavigation } from '../utils/report-projects-navigation-generator.js';
import { getProjectNameFromCommandLine, getTargetDateFromProjectOrEnvironment, validateAndLoadProject } from '../utils/project-utils.js';
import { getUserProjectQuestionFileContent, getCurrentDateTimeAsStringISO } from '../config/user-paths.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);

async function main(projectArg?: string): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);  
  
  await logger.initialize(import.meta.url, project);
  logger.info(`Generating navigation for project reports: ${project}, date: ${targetDate}`);

  const baseQ: string = QUESTIONS_DIR(project);
  const outputBase: string = OUTPUT_DIR(project);

  // Update project navigation
  try {
    await generateProjectNavigation(project);
    logger.debug('Generated project navigation');
  } catch (error) {
    logger.error(`Error updating project navigation: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  logger.info(`\Project navigation generation complete:`);
  logger.info(`  Processed: ${project.length} projects`);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
