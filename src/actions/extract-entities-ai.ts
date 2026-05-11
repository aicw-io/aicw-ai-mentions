import { promises as fs } from 'fs';
import path from 'path';
import vm from 'node:vm';
import { DirentLike } from '../config/types.js';
import { OpenAI } from 'openai';
import { ModelConfig, getAIAIPresetWithModels } from '../utils/model-config.js';
import { QUESTIONS_DIR, QUESTION_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { AGGREGATED_DIR_NAME } from '../config/constants.js';
import { MAIN_SECTIONS } from '../config/constants-entities.js';
import { logger } from '../utils/compact-logger.js';
import { waitForEnterInInteractiveMode } from '../utils/misc-utils.js';
import { createAiClientInstance, callAIWithRetry } from '../utils/ai-caller.js';
import { isInterrupted } from '../utils/delay.js';
import { cleanContentFromAI } from '../utils/content-cleaner.js';
import { getProjectNameFromCommandLine, getTargetDateFromProjectOrEnvironment, loadDataJs, saveDataJs, validateAndLoadProject, validateModelsAIPresetForProject } from '../utils/project-utils.js';
import { PipelineCriticalError } from '../utils/pipeline-errors.js';
import { loadProjectModelConfigs } from '../utils/project-utils.js';
import { loadProjectModelConfigs_FIRST } from '../utils/project-utils.js';
import { ModelType } from '../utils/project-utils.js';
import { getEntityTypeFromSectionName } from '../utils/misc-utils.js';

// get action name for the current module
import { getModuleNameFromUrl } from '../utils/misc-utils.js';
const CURRENT_MODULE_NAME = getModuleNameFromUrl(import.meta.url);


// Validate JavaScript syntax
function validateJavaScriptSyntax(code: string, filename: string): { isValid: boolean; error?: string } {
  try {
    // Remove markdown code blocks if present
    let cleanCode = cleanContentFromAI(code); 
    
    // Try to compile the script to check for syntax errors
    new vm.Script(cleanCode, { filename });
    return { isValid: true };
  } catch (error: any) {
    const errorLine = error.stack?.split('\n')[0] || error.message;
    return {
      isValid: false,
      error: `Syntax error: ${error.message}`
    };
  }
}

async function compilePromptWithFallback(project: string, file: string, cfg: ModelConfig): Promise<string> {
  const prompt = await fs.readFile(file, 'utf-8');
  logger.debug(`Prompt loaded, length: ${prompt.length} characters`);


    try {
      const aiClientInstance = createAiClientInstance(cfg);

      // Use centralized AI caller with retry logic
      const chat = await callAIWithRetry(
        aiClientInstance,
        cfg,
        {
          model: cfg.model,
          messages: [
            { role: 'system', content: 'You are a JavaScript code generator. IMPORTANT: Always ensure your output is valid JavaScript. If you open a comment block with /*, you MUST close it with */. Never leave unclosed comment blocks.' },
            { role: 'user', content: prompt }
          ]
        },
        {
          contextInfo: `Processing prompt file for ${CURRENT_MODULE_NAME}: ${path.basename(file)} with ${cfg.display_name}`,
          cacheNamePrefix: CURRENT_MODULE_NAME
        }
      );

      const result = chat.choices[0]?.message?.content || '';
      logger.debug(`Compilation successful with ${cfg.display_name}, result length: ${result.length} characters`);

      return result

    } catch (error: any) {
      throw new PipelineCriticalError(
        `Failed to compile prompt with ${cfg.display_name}: ${error.message}`, 
        CURRENT_MODULE_NAME, 
        project
      );
      
    }

}

/**
 * Merge entities from all questions into aggregate
 */
async function mergeEntitiesForAggregate(
  project: string,
  targetDate: string,
  questionDirs: DirentLike[]
): Promise<any> {
  logger.info('Merging entities from all questions for aggregate report');

  const mergedData: any = {};

  // Maps to deduplicate items by their key
  const itemMaps: Record<string, Map<string, any>> = {};
  for (const section of MAIN_SECTIONS) {
    itemMaps[section] = new Map();
  }

  // Read each question's data
  const actualQuestions = questionDirs.filter(d => d.isDirectory() && d.name !== AGGREGATED_DIR_NAME);

  for (const dir of actualQuestions) {
    try {
      const dataPath = path.join(
        QUESTION_DATA_COMPILED_DATE_DIR(project, dir.name, targetDate),
        `${targetDate}-data.js`
      );

      const { data } = await loadDataJs(dataPath);

      // Copy structure from first question
      if (!mergedData.report_date) {
        mergedData.report_date = data.report_date || targetDate;
        mergedData.report_question = `${project} - Aggregate Report`;
        mergedData.report_title = `${project} - Aggregate Report`;
        mergedData.report_type = 'aggregate';
        mergedData.bots = data.bots || [];
        // Copy other metadata
        if (data.reportMetadata) {
          mergedData.reportMetadata = { ...data.reportMetadata };
        }
      }

      // Merge items from each section
      for (const section of MAIN_SECTIONS) {
        if (data[section] && Array.isArray(data[section])) {
          for (const item of data[section]) {
            // Generate key for deduplication (same logic as trends calculation)
            const itemKey = (item.value || item.link || item.keyword || item.organization || item.source || '').toLowerCase();
            if (!itemKey) continue;

            // Keep first occurrence, but merge types from subsequent occurrences
            if (!itemMaps[section].has(itemKey)) {
              itemMaps[section].set(itemKey, { ...item });
            } else {
              // Merge unique types from subsequent occurrences
              const existing = itemMaps[section].get(itemKey);
              if (item.type && existing.type) {
                const existingTypes = existing.type.split(',').map((t: string) => t.trim());
                const newTypes = item.type.split(',').map((t: string) => t.trim());
                for (const t of newTypes) {
                  if (!existingTypes.includes(t)) {
                    existingTypes.push(t);
                  }
                }
                existing.type = existingTypes.join(',');
              }
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`Could not load data for ${dir.name}: ${error}`);
    }
  }

  // Convert maps to arrays
  for (const section of MAIN_SECTIONS) {
    mergedData[section] = Array.from(itemMaps[section].values());
    logger.debug(`Merged ${section}: ${mergedData[section].length} items`);
  }

  const totalItems = MAIN_SECTIONS.reduce((sum, section) => sum + (mergedData[section]?.length || 0), 0);
  logger.info(`Merged ${totalItems} total entities from ${actualQuestions.length} questions`);

  return mergedData;
}

export async function extractEntities(project: string, targetDate: string): Promise<void> {
  
  logger.info(`Starting extract entities process for project: ${project}`);

  const baseQ: string = QUESTIONS_DIR(project);
  logger.debug(`Questions directory: ${baseQ}`);
  
  try {
    const questionDirs: DirentLike[] = await fs.readdir(baseQ, { withFileTypes: true }) as DirentLike[];
    logger.debug(`Found ${questionDirs.length} items in questions directory`);

    const directories = questionDirs.filter(dirent => dirent.isDirectory());
    logger.info(`Found ${directories.length} directories to process`);
    
    // Start progress tracking
    logger.startProgress(directories.length, 'questions');
    
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let currentIndex = 0;
    
    for (const dirent of questionDirs) {
      // Check for interruption at the start of each iteration
      if (isInterrupted()) {
        logger.info('Operation cancelled by user, stopping batch processing...');
        throw new Error('Operation cancelled');
      }

      if (!dirent.isDirectory()) {
        logger.warn(`Skipping non-directory item: ${dirent.name}`);
        continue;
      }

      currentIndex++;
      logger.updateProgress(currentIndex, `Compiling ${dirent.name}...`);

      // Handle aggregate - merge entities instead of running AI
      if (dirent.name === AGGREGATED_DIR_NAME) {
        logger.info(`Processing aggregate - merging entities from all questions`);

        const compiledDir: string = QUESTION_DATA_COMPILED_DATE_DIR(project, dirent.name, targetDate);
        const compiledJsFile: string = `${targetDate}-data.js`;
        const outputPath = path.join(compiledDir, compiledJsFile);

        // Merge entities from all questions
        const mergedData = await mergeEntitiesForAggregate(project, targetDate, questionDirs);

        // Save to aggregate's data.js
        const dataKey = `AppData${targetDate.replace(/-/g, '')}`;
        const comment = `// Aggregate entities merged on ${new Date().toISOString()}`;
        await saveDataJs(outputPath, dataKey, mergedData, comment);

        processedCount++;
        logger.updateProgress(currentIndex, `${dirent.name} - ✓ (merged)`);
        continue; // Skip AI processing
      }

      // Look for prompts in the new location
      const compiledDir: string = QUESTION_DATA_COMPILED_DATE_DIR(project, dirent.name, targetDate);
      logger.debug(`Looking for prompts in: ${compiledDir}`);
      
      try {
        const files: string[] = await fs.readdir(compiledDir);
        logger.debug(`Found ${files.length} files in directory: ${files.join(', ')}`);
        
        // Look for prompt file for the target date
        const promptFile: string | undefined = files.find(f => 
          f.endsWith('.PROMPT.md') && f.startsWith(`${targetDate}`)
        );
        
        
        if (!promptFile) {
          logger.error(`No prompt files available for ${dirent.name} (.PROMPT.md)`);
          throw new PipelineCriticalError(
            `No prompt files available for ${dirent.name}. Files checked: ${files.join(', ')}`, 
            CURRENT_MODULE_NAME, 
            dirent.name
          );
        }
        
        // Extract date from prompt filename (e.g., "2025-07-19-data.js.PROMPT.md")
        const outputDate = promptFile.substring(0, 10);
        const compiledJsFile: string = `${outputDate}-data.js`;
        
        logger.debug(`Found prompt file: ${promptFile}, will output to: ${compiledJsFile}`);
        
        const promptPath = path.join(compiledDir, promptFile);
        const outputPath = path.join(compiledDir, compiledJsFile);

        // Check if already compiled WITH actual brands data (not just file existence)
        // The data file may exist from project-data-file-create but have empty brands
        let alreadyCompiled = false;
        try {
          const { data: existingData } = await loadDataJs(outputPath);
          alreadyCompiled = existingData.brands &&
                            Array.isArray(existingData.brands) &&
                            existingData.brands.length > 0;
          if (alreadyCompiled) {
            logger.info(`Already compiled with ${existingData.brands.length} brands: ${compiledJsFile}, skipping`);
            continue; // Skip to next question, don't recompile
          }
        } catch (error) {
          // File doesn't exist or can't be loaded - proceed with extraction
          alreadyCompiled = false;
        }
        // Otherwise, proceed to compile...

        logger.debug(`Compiling prompt from: ${promptPath}`);
        
        const aiModelToUse: ModelConfig = await loadProjectModelConfigs_FIRST(project, ModelType.EXTRACT_ENTITIES);

        // Update progress to show AI is being called
        logger.updateProgress(currentIndex, `${dirent.name} - Calling AI model ("${aiModelToUse.model}")...`);
        let output: string = await compilePromptWithFallback(project, promptPath, aiModelToUse);

        // Validate JavaScript syntax before processing
        logger.debug(`Validating JavaScript syntax for: ${compiledJsFile}`);
        const validation = validateJavaScriptSyntax(output, compiledJsFile);

        if (!validation.isValid) {
          logger.error(`AI generated invalid JavaScript for ${dirent.name}: ${validation.error}`);

          // Save invalid output for debugging
          const cleanedForSave = cleanContentFromAI(output);
          const savedPath = await logger.saveInvalidAIOutput({
            rawOutput: output,
            cleanedOutput: cleanedForSave,
            step: CURRENT_MODULE_NAME,
            project: project,
            questionId: dirent.name,
            error: validation.error || 'JavaScript syntax validation failed',
            model: aiModelToUse.model,
            promptFile: promptPath
          });

          errorCount++;
          logger.completeProgress(`Compilation failed due to invalid JavaScript`);
          throw new Error(`Cannot continue: AI generated invalid JavaScript for ${dirent.name}. ${validation.error}. Debug files saved to logs/invalid/`);
        }

        // Load existing data.js file
        logger.debug(`Loading existing data file: ${outputPath}`);
        const { data, dataKey } = await loadDataJs(outputPath);

        // Parse AI's output to extract outputData
        logger.debug(`Parsing AI output to extract entities`);
        const cleanOutput = cleanContentFromAI(output);
        const outputDataContext: any = {};
        try {
          vm.runInNewContext(cleanOutput, outputDataContext, {
            filename: 'ai-output.js',
            timeout: 5000
          });
        } catch (error: any) {
          // Save invalid output for debugging
          const savedPath = await logger.saveInvalidAIOutput({
            rawOutput: output,
            cleanedOutput: cleanOutput,
            step: CURRENT_MODULE_NAME,
            project: project,
            questionId: dirent.name,
            error: `VM execution failed: ${error.message}`,
            model: aiModelToUse.model,
            promptFile: promptPath
          });

          // Show preview in error message
          const preview = cleanOutput.substring(0, 200).replace(/\n/g, '\\n');
          logger.error(`Failed to execute AI output for ${dirent.name}`);
          logger.error(`Error: ${error.message}`);
          logger.error(`Output preview: ${preview}...`);

          throw new PipelineCriticalError(
            `Failed to parse AI output for ${dirent.name}: ${error.message}. Check logs/invalid/ for full output.`,
            CURRENT_MODULE_NAME,
            dirent.name
          );
        }

        const outputData = outputDataContext.output;
        if (!outputData) {
          throw new PipelineCriticalError(
            `AI output missing outputData for ${dirent.name}`, 
            CURRENT_MODULE_NAME, 
            dirent.name
          );
        }

        // Merge extracted entities into existing data
        logger.debug(`Merging entities into data structure`);
        
        // Map all keys from outputData to data, but throw if outputData contains unknown keys
        for (const key of Object.keys(outputData)) {
          // Skip non-entity keys to prevent corrupting metadata fields
          if (!MAIN_SECTIONS.includes(key as any)) continue;

          if (Object.prototype.hasOwnProperty.call(data, key)) {
            (data as any)[key] = Array.isArray(outputData[key]) ? outputData[key] : [];
          } else {
            throw new PipelineCriticalError(
              `Unknown key "${key}" found in AI output for ${dirent.name}. This key does not exist in the target data structure.`,
              CURRENT_MODULE_NAME,
              dirent.name
            );
          }
        }

        // Type enum mapping for compressed format expansion
        const TYPE_MAP: Record<number, string> = {
          1: 'product',
          2: 'organization',
          3: 'person',
          4: 'event'
        };

        // Expand type codes to type names (supports multiple types: "2,1" → "organization,product")
        function expandTypes(t: number | string): string {
          // Handle single number (backward compatible)
          if (typeof t === 'number') {
            return TYPE_MAP[t] || 'unknown';
          }
          // Handle comma-separated string like "2,1" or single string like "2"
          if (typeof t === 'string') {
            return t.split(',')
              .map(code => TYPE_MAP[parseInt(code.trim(), 10)] || null)
              .filter(type => type !== null)
              .join(',') || 'unknown';
          }
          return 'unknown';
        }

        // Expand and normalize brands in one step: {"v":"Name","t":"2,1"} → {"value":"Name","type":"organization,product"}
        logger.debug(`Expanding and normalizing brands data`);
        if (Array.isArray(data['brands'])) {
          data['brands'] = data['brands']
            .map((item: any) => {
              // Handle compressed format {v, t} - direct to final format
              if (item.v !== undefined && item.t !== undefined) {
                return {
                  value: item.v,
                  type: expandTypes(item.t)
                };
              }
              // Handle legacy {value, type} format (existing data)
              if (typeof item === 'object' && item.value !== undefined) {
                return {
                  value: item.value,
                  type: item.type || expandTypes(item.t) || 'unknown'
                };
              }
              // Handle legacy string format
              if (typeof item === 'string') {
                return { value: item, type: 'unknown' };
              }
              // Unknown format - return as-is for filtering
              return item;
            })
            .filter((item: any) => {
              // Filter out invalid items
              if (item.value && typeof item.value === 'string' && item.value.trim() !== '' && item.value.length > 1) {
                return true;
              }
              logger.warn(`Skipping invalid brand: ${JSON.stringify(item)}`);
              return false;
            });
        }

        // Normalize links array if present (unchanged logic)
        if (Array.isArray(data['links'])) {
          const entityType = getEntityTypeFromSectionName('links');
          data['links'] = data['links']
            .filter((item: any) => {
              const value = typeof item === 'string' ? item : item?.value;
              return value && typeof value === 'string' && value.trim() !== '' && value.length > 1;
            })
            .map((item: any) => {
              if (typeof item === 'string') {
                return { value: item, type: entityType };
              }
              return { value: item.value, type: item.type || entityType };
            });
        }

        // VALIDATION: Check if extraction actually found brands
        // If extraction ran but brands array is empty, the pipeline failed silently
        const hasAnyEntities = data['brands'] && Array.isArray(data['brands']) && data['brands'].length > 0;

        if (!hasAnyEntities) {
          throw new PipelineCriticalError(
            `Entity extraction completed but found ZERO brands for ${dirent.name}. ` +
            `This indicates extraction failed or AI returned empty results. ` +
            `Check the AI response and extraction prompts. ` +
            `Cannot proceed with empty brands array.`,
            CURRENT_MODULE_NAME,
            dirent.name
          );
        }

        // Save updated data
        logger.info(`Saving updated data to: ${outputPath}`);
        await saveDataJs(outputPath, dataKey, data)
        
        logger.updateProgress(currentIndex, `${dirent.name} - ✓`);
        logger.info(`Successfully processed "${dirent.name}" for ${project}`);
        processedCount++;
        
      } catch (error) {
        // Check if operation was cancelled by user
        if (error instanceof Error && error.message === 'Operation cancelled') {
          throw error; // Re-throw to stop the entire batch
        }

        logger.error(`Error processing ${dirent.name}: ${error instanceof Error ? error.message : String(error)}`);
        throw new PipelineCriticalError(
          `Error processing ${dirent.name}: ${error instanceof Error ? error.message : String(error)}`, 
          CURRENT_MODULE_NAME, 
          dirent.name
        );
      }
    }
    
    // Complete progress
    logger.completeProgress(`Compiled ${processedCount} questions`);
    
    // Add summary stats
    logger.addStat('Processed', processedCount);
    logger.addStat('Skipped', skippedCount);
    if (errorCount > 0) {
      logger.addStat('Errors', errorCount);
    }
    
    logger.info(`Compilation complete. Processed: ${processedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
    await logger.showSummary();
    
  } catch (error) {
    logger.error(`Failed to read questions directory: ${error instanceof Error ? error.message : String(error)}`);
    throw new PipelineCriticalError(
      `Failed to read questions directory: ${error instanceof Error ? error.message : String(error)}`, 
      CURRENT_MODULE_NAME, 
      project
    );
  }
}
async function main(): Promise<void> {
  const project = await getProjectNameFromCommandLine();
  await validateAndLoadProject(project);  
  const targetDate = await getTargetDateFromProjectOrEnvironment(project);  
  await validateModelsAIPresetForProject(project, ModelType.EXTRACT_ENTITIES);

  // Initialize logger
  await logger.initialize(import.meta.url, project);

  await extractEntities(project, targetDate);

  // Wait for Enter in interactive mode
  await waitForEnterInInteractiveMode();
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
