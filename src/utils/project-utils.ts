import { QUESTIONS_DIR } from "../config/paths.js";
import { DirentLike } from "../config/types.js";
import { getUserProjectQuestionFileContent } from "../config/user-paths.js";
import path from "path";
import { AGGREGATED_DIR_NAME } from "../config/constants.js";
import fs from "fs-extra";
import { QuestionEntry } from "../config/types.js";
import { logger } from "./compact-logger.js";
import { writeFileAtomic } from "./misc-utils.js";
import { ModelConfig, getAIAIPresetWithModels, getAIPresetNames, getCfgShortInfo } from "./model-config.js";
import { PROJECT_DIR, QUESTION_DATA_COMPILED_DATE_DIR, GET_ANSWERS_DIR_FOR_QUESTION } from "../config/paths.js";
import { cleanContentFromAI } from "./content-cleaner.js";
import vm from "node:vm";
import { PipelineCriticalError, MissingConfigError } from "./pipeline-errors.js";
import { MIN_VALID_ANSWER_SIZE } from "../config/user-paths.js";
import { DEFAULT_PRESET_NAME, getAIPreset } from "../ai-preset-manager.js";
import { ValidationResult } from "./validation.js";
import { isValidDate } from "./validation.js";
import { stringify } from "node:querystring";
import { DATE_FOLDER_NAME_PATTERN_REGEX} from "../config/paths.js";

export const enum ModelType {
  GET_ANSWER = 'get_answer',
  EXTRACT_ENTITIES = 'extract_entities',
}

export async function removeNonProjectModels(dirs: DirentLike[], models: ModelConfig[]): Promise<DirentLike[]> {
  const modelIds = new Set(models.map(m => m.id.toLowerCase()));
  return dirs.filter(dir => dir.isDirectory() && modelIds.has(dir.name.toLowerCase()));
};

/**
 * Read questions from project directory
 */
export async function readQuestions(project: string): Promise<QuestionEntry[]> {
  const questionsDir = QUESTIONS_DIR(project);
  const dirs: DirentLike[] = await fs.readdir(questionsDir, { withFileTypes: true }) as DirentLike[];

  const questions: QuestionEntry[] = [];

  const sortedDirs = dirs
    .filter(dir => dir.isDirectory() && !dir.name.startsWith('_') && dir.name !== AGGREGATED_DIR_NAME)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of sortedDirs) {
    try {
      const questionContent = getUserProjectQuestionFileContent(project, dir.name);
      questions.push({
        folder: dir.name,
        question: questionContent.trim()
      });
    } catch (error) {
      logger.warn(`Could not read question file for ${dir.name}`);
    }
  }

  return questions;
}
/**
 * Load data from compiled JS file
 */
export async function loadDataJs(file: string, keyPrefix: string = 'AppData'): Promise<{ data: any; dataKey: string }> {
  let content: string = await fs.readFile(file, 'utf-8');

  content = cleanContentFromAI(content);

  const context: any = { window: {} };
  try {
    vm.runInNewContext(content, context, {
      filename: file,
      timeout: 5000
    });
  } catch (error: any) {
    throw new Error(`Failed to execute JS file ${file}: ${error.message}`);
  }

  const dataKey = Object.keys(context.window).find(k => k.startsWith(keyPrefix));
  if (!dataKey) {
    throw new Error(`Unable to find ${keyPrefix} in ${file}`);
  }

  return { data: context.window[dataKey], dataKey: dataKey };
}

/**
 * Save data back to JS file
 */
export async function saveDataJs(file: string, key: string, data: any, comment: string = ''): Promise<void> {
  const dataJson = JSON.stringify(data, null, 2);
  if (comment) {
    comment = `// ${comment}\n`;
  }
  const text = `window.${key} = ${dataJson};\nwindow.AppData = window.${key};\n`;
  await writeFileAtomic(file, text);
}


export async function loadProjectModelConfigs_FIRST(project: string, modelType: ModelType): Promise<ModelConfig> {
  const models = await loadProjectModelConfigs(project, modelType);
  if (models.length === 0) {
    throw new PipelineCriticalError(
      `No models found for ${modelType} in project ${project}`,
      'loadProjectModelConfigs_FIRST',
      project
    );
  }
  return models[0];
}
/**
 * Load project-specific model from project for specific purpose
 * Returns models from ai_preset.fetchAnswers (used for answer fetching and folder names)
 */
export async function loadProjectModelConfigs(project: string, modelType: ModelType): Promise<ModelConfig[]> {
  
  if (!project || modelType === null || modelType === undefined) {
    throw new Error('Project and purpose are required');
  }
  
  const projectJsonPath = path.join(PROJECT_DIR(project), 'project.json');

  try {
    const projectContent = await fs.readFile(projectJsonPath, 'utf-8');
    const projectConfig = JSON.parse(projectContent);

    // Require ai_preset field
    if (!projectConfig.ai_preset) {
      throw new Error(
        `Project ${project} missing required 'ai_preset' field in project.json. ` +
        `Please add a ai_preset field (e.g., "ai_preset": "${DEFAULT_PRESET_NAME}").`
      )
    }

    // Load models from ai_preset's 
    const ai_preset = getAIAIPresetWithModels(projectConfig.ai_preset);
    if (!ai_preset) {
      throw new Error(
        `AIPreset '${projectConfig.ai_preset}' not found. ` +
        `Available ai_presets: ${getAIPresetNames().join(', ')}`
      )
    }

    if (!ai_preset.modelConfigs[modelType]) {
      throw new Error(
        `AIPreset '${projectConfig.ai_preset}' has no "${modelType}" models configured.`
      )
    }

    const models: ModelConfig[] = ai_preset.modelConfigs[modelType];
    
    if (models.length === 0) {
      throw new Error(
        `AIPreset '${projectConfig.ai_preset}' has no "${modelType}" models configured.`
        )
    }
    return models;

  } catch (error: any) {
    // rethrow
    throw new PipelineCriticalError(
      `Error loading project models: ${error.message}`,
      'loadProjectModelConfigs',
      project
      )
  }
}

/**
 * Get the latest compiled data file for a question
 */
export async function getLatestCompiledFile(project: string, questionFolder: string, targetDate: string): Promise<string | null> {
  const compiledBaseDir = QUESTION_DATA_COMPILED_DATE_DIR(project, questionFolder, targetDate || '');

  try {
    if (targetDate) {
      // If specific date requested, look for that date's file
      const dateDir = path.join(path.dirname(compiledBaseDir), targetDate);
      const files = await fs.readdir(dateDir);
      // Look for the canonical {date}-data.js file
      const compiledFile = files.find(f => f === `${targetDate}-data.js`);
      if (compiledFile) {
        return path.join(dateDir, compiledFile);
      }
    } else {
      // Find the latest date with compiled data
      // When targetDate is empty, compiledBaseDir is already the data-compiled directory
      const dataCompiledDir = compiledBaseDir;
      const entries = await fs.readdir(dataCompiledDir, { withFileTypes: true });
      const dateDirs = entries
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map(e => e.name)
        .sort()
        .reverse();

      for (const date of dateDirs) {
        const dateDir = path.join(dataCompiledDir, date);
        const files = await fs.readdir(dateDir);
        // Look for the canonical {date}-data.js file
        const compiledFile = files.find(f => f === `${date}-data.js`);
        if (compiledFile) {
          return path.join(dateDir, compiledFile);
        }
      }
    }
  } catch (error) {
    logger.debug(`No compiled data found for ${questionFolder}: ${error}`);
  }

  return null;
}

/**
 * Get all previous data files for trend analysis
 */
export async function getPreviousDataFiles(project: string, questionFolder: string, currentDate: string, maxFiles: number = 3): Promise<string[]> {
  // When date is empty string, QUESTION_DATA_COMPILED_DATE_DIR returns the data-compiled directory
  const dataCompiledDir = QUESTION_DATA_COMPILED_DATE_DIR(project, questionFolder, '');
  const prevFiles: string[] = [];

  try {
    const entries = await fs.readdir(dataCompiledDir, { withFileTypes: true });
    const dateDirs = entries
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .filter(date => date < currentDate)
      .sort()
      .reverse()
      .slice(0, maxFiles);

    for (const date of dateDirs) {
      const dateDir = path.join(dataCompiledDir, date);
      const files = await fs.readdir(dateDir);
      const dataFile = files.find(f => f === `${date}-data.js`);
      if (dataFile) {
        prevFiles.push(path.join(dateDir, dataFile));
      }
    }
  } catch (error) {
    logger.debug(`No previous data found for ${questionFolder}: ${error}`);
  }

  return prevFiles;
}

/**
 * Resolve relative date offset (e.g., -1, -2) to actual date from complete dates array
 *
 * @param dateStr - Date string to check (e.g., "-1", "-2", or "2025-01-15")
 * @param completeDates - Array of complete answer dates (sorted newest first)
 * @returns Resolved date if dateStr is a relative offset, null otherwise
 * @throws PipelineCriticalError if offset is out of bounds
 */
function resolveRelativeDateOffset(dateStr: string, completeDates: string[]): string | null {
  // Check if it's a negative number pattern
  const match = dateStr.match(/^-(\d+)$/);
  if (!match) return null; // Not a relative date

  const offset = parseInt(match[1]);

  // Validate offset is within bounds
  if (offset >= completeDates.length) {
    throw new PipelineCriticalError(
      `Relative date offset -${offset} is out of bounds. Only ${completeDates.length} complete answer date(s) available: ${completeDates.join(', ')}`,
      'resolveRelativeDateOffset'
    );
  }

  return completeDates[offset];
}

export async function getTargetDateFromProjectOrEnvironment(project: string): Promise<string> {

  const args = process.argv.slice(2);

  let finalDate: string | undefined = undefined;

  // getting the list of all complete answer dates
  // we need them to verify against cmd params or env 
  // so we can reject ones which are NOT in the list 
  const completeAnswersDates: string[] | null = await getDatesWithCompleteAnswers(project);
  //logger.info(`getTargetDateFromProjectOrEnvironment: completeAnswersDates: ${completeAnswersDates}`);
  // raise error if no complete answers at all for the project
  if (!completeAnswersDates || completeAnswersDates.length === 0) { 
    // if not dates with complete answers at all, we return empty string
    logger.info(`No complete answer dates found for project ${project}. New project?`);
    /*
    throw new PipelineCriticalError(
      `No complete answer dates found for project ${project}. Check project.json`,
      'getTargetDateFromProjectOrEnvironment',
      project
    );
    */
  }

  // first parse from args
  const dateIndex = args.indexOf('--date');
  if (dateIndex !== -1 && args[dateIndex + 1]) {
    logger.warn(`Target date found in command-line params: ${args[dateIndex + 1]}`);
    let date = args[dateIndex + 1];

    // Try to resolve relative date offset (e.g., -1, -2)
    const resolvedDate = resolveRelativeDateOffset(date, completeAnswersDates);
    if (resolvedDate) {
      logger.warn(`Relative date offset ${date} resolved to: ${resolvedDate}`);
      date = resolvedDate;
    }

    // check if this data in the list of dates with complete answers
    if (!completeAnswersDates.includes(date)) {
      throw new PipelineCriticalError(
        `Target date ${date} was set via --date param but not found in the list of complete answer dates for project ${project}. Check project.json`,
        'getTargetDateFromProjectOrEnvironment',
        project
      );
    }
    logger.warn(`Target date used from --date cmd params: ${date}`);
    finalDate = date;
  }
  // if not then trying to use from ENV
  else if (process.env.AICW_TARGET_DATE) {
    let date = process.env.AICW_TARGET_DATE;
    logger.warn(`Target date detected in AICW_TARGET_DATE env var: ${date}`);

    // Try to resolve relative date offset (e.g., -1, -2)
    const resolvedDate = resolveRelativeDateOffset(date, completeAnswersDates);
    if (resolvedDate) {
      logger.warn(`Relative date offset ${date} (from env) resolved to: ${resolvedDate}`);
      date = resolvedDate;
    }

    // check if this date can be used and it is in complete answers dates
    if (!completeAnswersDates.includes(date)) {
      throw new PipelineCriticalError(
        `Target date ${date} not found in the list of complete answer dates for project ${project}. Check project.json`,
        'getTargetDateFromProjectOrEnvironment',
        project
      );
    }
    finalDate = date;
    logger.info(`Using date defined in process.env.AICE_TARGET_DATE: ${finalDate}`);
  }
  else {
    // if not then trying to use from project.json
    const latestCompleteDateFromProject = await getLatestCompleteAnswersDateFromProjectSettings(project);  

    // latest date is not saved in project.json or it is different from the one in the list of complete answer dates
    if (!latestCompleteDateFromProject || latestCompleteDateFromProject !== completeAnswersDates[0]) {
      // writing to project.json if we have latest complete date different from the one in project.json
      finalDate = completeAnswersDates[0];
      await setDateOfLatestCompleteAnswersInProjectFile(project, completeAnswersDates[0]);
      logger.debug(`getTargetDateFromProjectOrEnvironment: detected latest complete answers date from folders (and saved to project.json): ${completeAnswersDates[0]}`);
    } else {
      finalDate = latestCompleteDateFromProject;
      logger.debug(`getTargetDateFromProjectOrEnvironment: detected latest complete answers date from project.json: ${latestCompleteDateFromProject}`);
    }
  }

  if (!finalDate) {
    // if still no date then we return current date formatted as YYYY-MM-DD
    finalDate = new Date().toISOString().split('T')[0];
    logger.info(`No target date found for project ${project}. Returning current date: ${finalDate}`);
    
    /*
    throw new PipelineCriticalError(
      `No target date found for project ${project}. Check project.json`,
      'getTargetDateFromProjectOrEnvironment',
      project
    );
    */
  }

  logger.info(`Target date detected as: ${finalDate}`);
  return finalDate;

} 

export async function validateModelsAIPresetForProject(project: string, modelType: ModelType): Promise<void> {
  const projectJsonPath = path.join(PROJECT_DIR(project), 'project.json');
  const projectConfigContent = await fs.readFile(projectJsonPath, 'utf-8');
  const projectConfig = JSON.parse(projectConfigContent);

  const cfgs: ModelConfig[] = await loadProjectModelConfigs(project, modelType);

  if(cfgs.length === 0){
    throw new PipelineCriticalError(
      `No models found for "${modelType}" in project "${project}"'s ai_preset!`,
      'validateModelsAIPresetForProject',
      project
    );
  }

  for (const cfg of cfgs)
  {
    // check if required API env variable is defined
    if (!process.env[cfg.api_key_env]) {
      throw new MissingConfigError(
        `Model '${getCfgShortInfo(cfg)}' is missing a required API key. The environment variable '${cfg.api_key_env}' is not set. ` + 
        `Please run Setup step to set this API key first!`,
        'validateModelsAIPresetForProject'
      );
    }
  }
}

/**
 * Get the cached latest complete answers date from project.json
 * This avoids expensive filesystem scanning on every pipeline step.
 *
 * @param project - Project name
 * @returns Cached date or undefined if not set
 */
async function getLatestCompleteAnswersDateFromProjectSettings(project: string): Promise<string | undefined> {
  const projectJsonPath = path.join(PROJECT_DIR(project), 'project.json');
  //logger.debug(`getLatestCompleteAnswersDateFromProject: projectJsonPath: ${projectJsonPath}`);

  try {
    const projectContent = await fs.readFile(projectJsonPath, 'utf-8');
    const projectConfig = JSON.parse(projectContent);
    //logger.debug(`getLatestCompleteAnswersDateFromProject: projectConfig: ${JSON.stringify(projectConfig)}`);
    return projectConfig.latest_complete_answers_date || undefined;
  } catch (error) {
    logger.debug(`Could not read latest_complete_answers_date from project.json: ${error}`);
    return undefined;
  }
}

export async function getProjectNameFromCommandLine(): Promise<string> {
  const args = process.argv.slice(2);

  // Handle project names with spaces by joining all args before --date flag
  // spawn() splits "best lawyer for a startup" into ["best", "lawyer", "for", "a", "startup"]
  const dateIndex = args.indexOf('--date');
  const projectArgs = dateIndex !== -1 ? args.slice(0, dateIndex) : args;
  const project = projectArgs.join(' ').trim();

  if (!project || project === '') {
    // project was NOT found anywhere
    throw new PipelineCriticalError(
      'Project was not specified! Usage: <actionName> <ProjectName> [--date YYYY-MM-DD]',
      'getProjectNameFromCommandLine'
    );
  }
  return project;
}


/**
 * Save the latest complete answers date to project.json
 * This caches the date so subsequent pipeline steps don't need to scan filesystem.
 *
 * @param project - Project name
 * @param date - Date in YYYY-MM-DD format
 */
async function setDateOfLatestCompleteAnswersInProjectFile(project: string, date: string): Promise<void> {
  const projectJsonPath = path.join(PROJECT_DIR(project), 'project.json');

  try {
    // Read existing config
    const projectContent = await fs.readFile(projectJsonPath, 'utf-8');
    const projectConfig = JSON.parse(projectContent);

    // Update date
    projectConfig.latest_complete_answers_date = date;

    // Write back atomically
    await writeFileAtomic(projectJsonPath, JSON.stringify(projectConfig, null, 2));

    logger.debug(`Saved latest_complete_answers_date to project.json: ${date}`);
  } catch (error) {
    logger.warn(`Could not save latest_complete_answers_date to project.json: ${error}`);
    // Don't throw - this is a nice-to-have optimization
  }
}

/**
 * Check if a date directory has complete answers for all project models
 *
 * @param answersDir - Path to the answers directory for a question
 * @param date - Date to check (YYYY-MM-DD format)
 * @param projectModels - Array of model IDs from project.json
 * @returns true if all models have valid answer.md files (>= MIN_VALID_ANSWER_SIZE bytes)
 */
async function questionHasCompleteAnswers(answersDir: string, date: string, projectModels: ModelConfig[]): Promise<boolean> {
  let dateDir = await fs.readdir(path.join(answersDir, date), { withFileTypes: true });
  
  dateDir = await removeNonProjectModels(
    dateDir,
    projectModels
  );

  //console.info(`hasCompleteAnswers: answersDir: ${answersDir}, date: ${date}, answersDirDate: ${dateDir.map(d => d.name).join(', ')}`);
  //console.info(`hasCompleteAnswers: projectModels: ${projectModels.map(m => m.id).join(', ')}`);

  try {
    for (const dir of dateDir) {
      const answerFile = path.join(dateDir.name, dir.name, 'answer.md');

      try {
        const stats = await fs.stat(answerFile);
        if (stats.size < MIN_VALID_ANSWER_SIZE) {
          logger.debug(`Date ${date}: Model ${dir.name} has answer.md but size ${stats.size} < ${MIN_VALID_ANSWER_SIZE} bytes`);
          return false;
        }
      } catch (error) {
        logger.debug(`Date ${date}: Model ${dir.name} missing answer.md: ${error}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.debug(`Error checking date ${date}: ${error}`);
    return false;
  }
}

/**
 * Find the latest date with COMPLETE answer data for a project
 * This ensures consistency across all pipeline steps when no explicit date is provided.
 * Only returns dates where ALL project models have valid answers (>= MIN_VALID_ANSWER_SIZE bytes)
 *
 * @param project - Project name
 * @returns Latest complete answer date in YYYY-MM-DD format, or null if no complete answers found
 * @throws Error if no complete answer dates are found
 */
export async function getDatesWithCompleteAnswers(project: string): Promise<string[] | null> {
  const questionsDir = QUESTIONS_DIR(project);

    const questionDirs = await fs.readdir(questionsDir, { withFileTypes: true });

    // Find the first non-aggregated question directory
    const questionsDirsWithoutAggregateDir = questionDirs
      // filter out aggregate directory which is not a question and always recreated
      .filter(d => d.isDirectory() && d.name !== AGGREGATED_DIR_NAME)
      .sort();

    if (!questionsDirsWithoutAggregateDir || questionsDirsWithoutAggregateDir.length === 0) {
      logger.warn('No question directories found (without aggregate directory)');
      // return empty set of dates
      return [];
    }

    // Load project models to validate completeness
    const projectModelsForAnswer = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);

    if (projectModelsForAnswer.length === 0) {
      throw new Error(`No models configured for project ${project}. Check project.json`);
    }    

    // array of unique dates which are complete dates
    const completeDates: string[] = [];

    try {
      // Check for answer dates in the first question directory

      for (const questionDir of questionsDirsWithoutAggregateDir) {
        const answersDir = GET_ANSWERS_DIR_FOR_QUESTION(project, questionDir.name);  

        const dateDirs = await fs.readdir(answersDir, { withFileTypes: true });
        const dates = dateDirs
          .filter(d => d.isDirectory() && DATE_FOLDER_NAME_PATTERN_REGEX.test(d.name))
          .map(d => d.name);

        if (dates.length === 0) {
          // if we didnt find any dates at all inside ANY question, it is means
          // we have not complete answeres dates at all
          logger.warn(`No answer date directories found for project ${project} in ${answersDir}`);
          return [];
        }

        // for question get dates with complete answers
        const completeDatesForQuestion = dates.filter((date:string) => questionHasCompleteAnswers(answersDir, date, projectModelsForAnswer));

        // we must not have empty dates for any question
        if (completeDatesForQuestion.length === 0) {
          logger.warn(`No complete answer dates found for project ${project} for question "${questionDir.name}" in ${answersDir}`);
          throw new PipelineCriticalError(
            `No complete answer dates found for project ${project}. Check project.json`,
            'getDatesWithCompleteAnswers',
            project
          );
        }

        // it is our very first run 
        if(completeDates.length === 0){
          completeDates.push(...completeDatesForQuestion);
          // as the first run we should go to the next question
          continue;
        }

        // 2nd or further question. Intersect completeDates and completeDatesForQuestion to keep only dates present in both.
        const intersectedDates = completeDates.filter(date => completeDatesForQuestion.includes(date));
        if (intersectedDates.length === 0) {
          logger.error(`No complete answer dates found for project ${project} for question "${questionDir.name}" in ${answersDir}`);
          throw new PipelineCriticalError(
            `No complete answer dates found for project ${project}. Check project.json`,
            'getDatesWithCompleteAnswers',
            project
          );
        }
        // Update completeDates to only those present in both sets
        completeDates.length = 0;
        completeDates.push(...intersectedDates);
        // then we repeat and we should end up with completeDates having
        // only the dates where we have complete answers for all questions!
        
      }

        // return the array of complete dates, starting from the NEWEST one (descending order)
        return completeDates.sort().reverse();

    } catch (error) {
      throw new PipelineCriticalError(
        `Error reading answers directory: ${error}`,
        'getDatesWithCompleteAnswers',
        project
      );
    }
}

/**
 * Sanitize project name - remove invalid characters
 */
export function sanitizeProjectName(name: string): string {
  return name
    .trim()
    // Replace invalid characters with underscores
    .replace(/[^a-zA-Z0-9_\- ]/g, '_')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    // Limit length
    .substring(0, 100);
}


export function validateProjectName(project: string): { isisValid: boolean; error?: string } {
  if (!project) {
    return { isisValid: false, error: 'Project name is required' };
  }
  
  if (!/^[a-zA-Z0-9_-]+$/.test(project)) {
    return { isisValid: false, error: 'Project name can only contain letters, numbers, hyphens, and underscores' };
  }
  
  return { isisValid: true };
}

async function validateProjectConfig(projectPath: string): Promise<ValidationResult> {
  const result: ValidationResult = { isValid: true, errors: []};
  try {
    // Read and parse project.json
    const configPath = path.join(projectPath, 'project.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    let config: any;

    try {
      config = JSON.parse(configContent);
    } catch (e) {
      result.errors.push('Invalid JSON format in project.json');
      result.isValid = false;
      return result;
    }

    // Validate required fields
    if (!config.name) {
      result.errors.push('Missing required field: name');
      result.isValid = false;
    } else if (typeof config.name !== 'string') {
      result.errors.push('Field "name" must be a string');
      result.isValid = false;
    } else if (!/^[a-zA-Z0-9_\- ]+$/.test(config.name)) {
      result.errors.push('Project name contains invalid characters. Use only letters, numbers, spaces, hyphens, and underscores.');
      result.isValid = false;
    }

    // Validate ai_preset (REQUIRED)
    if (!config.ai_preset) {
      result.errors.push('Missing required field: ai_preset');
      result.isValid = false;
    } else if (typeof config.ai_preset !== 'string') {
      result.errors.push('Field "ai_preset" must be a string');
      result.isValid = false;
    } else {
      // Validate ai_preset exists
      const ai_preset = getAIPreset(config.ai_preset);
      if (!ai_preset) {
        const availableAIPresets = getAIPresetNames();
        result.errors.push(
          `Invalid ai_preset: '${config.ai_preset}'. ` +
          `Available ai_presets: ${availableAIPresets.join(', ')}`
        );
        result.isValid = false;
      }
    }


    // Validate dates if present
    if (config.created_at) {
      if (!isValidDate(config.created_at)) {
        result.errors.push(`Invalid created_at date format: ${config.created_at}`);
      }
    }

    if (config.updated_at) {
      if (!isValidDate(config.updated_at)) {
        result.errors.push(`Invalid updated_at date format: ${config.updated_at}`);
      }
    }

    // Validate questions array if present
    if (config.questions) {
      if (!Array.isArray(config.questions)) {
        result.errors.push('Field "questions" must be an array');
        result.isValid = false;
      } else if (config.questions.length === 0) {
        result.errors.push('Questions array is empty');
      }
    }

    // Check for unknown fields
    const knownFields = ['name', 'display_name', 'ai_preset', 'questions',
                        'created_at', 'updated_at', 'description', 'latest_complete_answers_date',
                        'published_url_base'];
    const unknownFields = Object.keys(config).filter(key => !knownFields.includes(key));
    if (unknownFields.length > 0) {
      result.errors.push(`Unknown fields in project.json: ${unknownFields.join(', ')}`);
    }

  } catch (error: any) {
    result.errors.push(`Failed to read project.json: ${error.message}`);
    result.isValid = false;
  }

  return result;
}

export async function validateAndLoadProject(project: string, silent: boolean = false): Promise<any | null> {
  const projectPath = PROJECT_DIR(project);
  const validation = await validateProjectConfig(projectPath);

  if (!silent) {
    // Print validation results
    if (validation.errors.length > 0) {
      logger.error('Project configuration errors:');
      validation.errors.forEach(err => logger.error(`  ❌ ${err}`));
    }

    if (validation.isValid && validation.errors.length === 0) {
      logger.debug('✓ Project configuration is valid');
    }
  }

  if (!validation.isValid) {
    return null;
  }

  // Load and return the config
  try {
    const configPath = path.join(projectPath, 'project.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(configContent);
  } catch (error) {
    logger.error(`Error loading project configuration: ${error.message}`);
    throw new PipelineCriticalError(
      `Error loading project configuration: ${error.message}`,
      'validateAndLoadProject',
      project
    );
  }
}
