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
  logger.info(`Generating success message for project reports: ${project}, date: ${targetDate}`);


  await showSuccessBox(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

async function showSuccessBox(project:string, targetDate:string): Promise<void> {
    // Display success message in a prominent box
    const reportPath = path.resolve(OUTPUT_DIR(project), 'index.html');
    const successBox = drawBox([
      '',
      colorize('🎉  REPORT GENERATED SUCCESSFULLY!  🎉', 'bright'),
      '',
      colorize('📍 Report Location:', 'yellow'),
      colorize(reportPath, 'cyan'),
      '',
      colorize('👀 To View Your Report:', 'yellow'),
      '  • select ' + colorize('"Open local reports server"', 'cyan') + ' from the main menu',
      '  • or run ' + colorize('aicw-ai-mentions serve', 'cyan') + ' to run the reports server',
      '',
      colorize('💡 Tip:', 'yellow') + ' Share the static report or export CSVs from the Mentions, Links, and Link Domains tabs.',
      ''
    ], { borderColor: 'green', width: 66 });
  
    logger.info('\n' + successBox + '\n');
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
