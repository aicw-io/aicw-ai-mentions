import { promises as fs } from 'fs';
import path from 'path';
import { QUESTIONS_DIR, OUTPUT_DIR, QUESTION_DATA_COMPILED_DATE_DIR, AGGREGATED_DATA_COMPILED_DIR, AGGREGATED_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { getProjectNameFromCommandLine, getTargetDateFromProjectOrEnvironment, loadProjectModelConfigs, removeNonProjectModels, validateAndLoadProject } from '../utils/project-utils.js';
import { PipelineCriticalError } from '../utils/pipeline-errors.js';
import { logger } from '../utils/compact-logger.js';
import { writeFileAtomic } from '../utils/misc-utils.js';
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
import { ModelType } from '../utils/project-utils.js';
import { renderMarkdownToHtml } from '../utils/markdown-utils.js';
// get action name for the current module
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

interface AnswersByModel {
  [modelId: string]: {
    text: string;
    html: string;
  }
}

interface AggregatedAnswersData {
  [questionId: string]: {
    [date: string]: AnswersByModel;
  }
}

async function readAnswersForQuestion(project: string, questionDir: string, targetDate: string): Promise<AnswersByModel> {
  const answersBaseDir = path.join(questionDir, 'answers');
  const results: AnswersByModel = {};
  const aiModelsForAnswerInProject = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);

  try {
    const dateDirs = await fs.readdir(answersBaseDir, { withFileTypes: true });

    for (const dateDir of dateDirs) {

      if (!dateDir.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateDir.name))
        continue;

      if (dateDir.name !== targetDate)
        continue; //

      const dateAnswersDir = path.join(answersBaseDir, dateDir.name);

      const modelDirs = 
        await removeNonProjectModels(
          await fs.readdir(dateAnswersDir, { withFileTypes: true }),
          aiModelsForAnswerInProject
        );      


      for (const modelDir of modelDirs) {

        const answerFile = path.join(dateAnswersDir, modelDir.name, 'answer.md');
        try {
          const text = await fs.readFile(answerFile, 'utf-8');
          results[modelDir.name] = {
            text: text,
            html: renderMarkdownToHtml(text)
          };
        } catch (error) {
          // Skip if answer.md doesn't exist
        }
      }
    }
  } catch (error) {
    logger.warn(`Error reading answers for question: ${error}`);
    throw new PipelineCriticalError(
      `Error reading answers for project ${project}, question ${questionDir}: ${error}`,
      'readAnswersForQuestion',
      project
    );
  }

  return results;
}

export async function generateAnswersFile(project: string, targetDate: string): Promise<void> {
  logger.info(`Generating answers file for project: ${project}, date: ${targetDate}`);
  
  const questionsDir = QUESTIONS_DIR(project);
  const outputDir = OUTPUT_DIR(project);
  const targetDateWithoutDashes = targetDate.replace(/-/g, '');
  
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const questionDirs = await fs.readdir(questionsDir, { withFileTypes: true });
    let questionIndex = 0;
    // we will later join all answers per question into one single file for aggregate report
    const answersPerQuestionFiles: string[] = []; 
    const aggregatedAnswersData: AggregatedAnswersData = {};

    // go through all questions
    for (const questionDir of questionDirs) {

      if (!questionDir.isDirectory()) continue;
      // Skip aggregate folder - it doesn't have answers directory
      if (questionDir.name === AGGREGATED_DIR_NAME) continue;

      // get the compiled directory for the question
      const compiledDir = QUESTION_DATA_COMPILED_DATE_DIR(project, questionDir.name, targetDate);
      // get the answers for the question
      const questionPath = path.join(questionsDir, questionDir.name);
      const answersForQuestion: AnswersByModel = await readAnswersForQuestion(project, questionPath, targetDate);

      // if there are answers for the question, add them to the aggregated answers data
      if (Object.keys(answersForQuestion).length > 0) {
        // initialize the aggregated answers data for the question
        if (!aggregatedAnswersData[questionDir.name]) {
          aggregatedAnswersData[questionDir.name] = {};
        }
        // add the answers for the question to the aggregated answers data
        aggregatedAnswersData[questionDir.name][targetDate] = answersForQuestion;

        // write the answers for the question to the compiled directory
        // wrap in nested structure for per-question file (same format as aggregate)
        const perQuestionData = {
          [questionDir.name]: {
            [targetDate]: answersForQuestion
          }
        };
        const content = `window.answers${targetDateWithoutDashes} = ${JSON.stringify(perQuestionData, null, 2)};\n`;

        const outputFilePath = path.join(compiledDir, `${targetDate}-answers.js`);

        await writeFileAtomic(outputFilePath, content); 
        logger.info(`Wrote answers file for question ${questionDir.name} to ${outputFilePath}`);
        answersPerQuestionFiles.push(outputFilePath);
      }
    }

    // write the aggregated answers data to the compiled directory
    const contentAggregated = `window.answers${targetDateWithoutDashes} = ${JSON.stringify(aggregatedAnswersData, null, 2)};\n`;
    const aggregatedDir = AGGREGATED_DATA_COMPILED_DATE_DIR(project, targetDate);
    await fs.mkdir(aggregatedDir, { recursive: true });
    const aggregatedAnswersFilePath = path.join(aggregatedDir, `${targetDate}-answers.js`);
    await writeFileAtomic(aggregatedAnswersFilePath, contentAggregated);
    logger.info(`Wrote aggregated answers file for ${project} to ${aggregatedAnswersFilePath}`);

    
  } catch (error) {
    logger.error(`Error generating answers file: ${error instanceof Error ? error.message : String(error)}`);
    throw new PipelineCriticalError(
      `Error generating answers file for project ${project}, date ${targetDate}: ${error instanceof Error ? error.message : String(error)}`, 
      'generateAnswersFile', 
      project
    );
  }
}

// Main function for standalone execution
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
 await validateAndLoadProject(project);
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);

  try {
    await generateAnswersFile(project, targetDate);
  } catch (error) {
    logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    throw new PipelineCriticalError(
      `Fatal error in main process: ${error instanceof Error ? error.message : String(error)}`, 
      'generateAnswersFile', 
      project
    );
  }
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
