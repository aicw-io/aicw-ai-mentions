import { promises as fs } from 'fs';
import path from 'path';
import { DirentLike } from '../config/types.js';
import { REPORT_HTML_TEMPLATE_DIR, QUESTIONS_DIR, OUTPUT_DIR, QUESTION_DATA_COMPILED_DATE_DIR, AGGREGATED_DATA_COMPILED_DATE_DIR } from '../config/paths.js';
import { MAIN_SECTIONS } from '../config/constants-entities.js';
import { logger } from './compact-logger.js';
import {
  normalizeModelWeights,
  calculateShareOfVoice,
  calculateInfluenceByModel,
  calculateProminence
} from './influence-calculator.js';
import { loadProjectModelConfigs, readQuestions, validateAndLoadProject } from './project-utils.js';
import { QuestionEntry } from '../config/types.js';
import { ModelType } from './project-utils.js';
import { generateEntityPages } from './report-entity-pages.js';
import { generateSourcePages } from './report-source-pages.js';
import { generateStaticMainPage } from './report-main-static.js';

// Load enriched data file and parse it
async function loadEnrichedData(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, 'utf-8');
  
  // Extract the data object using regex to handle window.AppData assignment
  const match = content.match(/window\.AppData\d*\s*=\s*(\{[\s\S]*\});?\s*$/m);
  if (!match) {
    throw new Error(`Could not parse data from ${filePath}`);
  }
  
  // Use Function constructor to safely evaluate the object literal
  const dataStr = match[1];
  const data = new Function(`return ${dataStr}`)();
  return data;
}

// Merge items from multiple prompts
async function mergeItems(project: string, itemsByPrompt: Record<string, any[]>, arrayName: string, questionsByPrompt: Record<string, string>, baseData?: any): Promise<any[]> {
  const mergedMap = new Map<string, any>();
  
  for (const [promptId, items] of Object.entries(itemsByPrompt)) {
    for (const item of items) {
      const key = item.value.toLowerCase(); // Use lowercase for case-insensitive matching
      
      if (!mergedMap.has(key)) {
        // First occurrence - initialize the merged item
        mergedMap.set(key, {
          ...item,
          mentionsByPrompt: {},
          influenceByPrompt: {},
          mentionsByModelByPrompt: {},
          appearanceOrderByPrompt: {},
          excerptsByModelByPrompt: {} // Add this to track excerpts by prompt
        });
      }
      
      const merged = mergedMap.get(key)!;
      
      // Store per-prompt data
      merged.mentionsByPrompt[promptId] = item.mentions || 0;
      merged.influenceByPrompt[promptId] = item.influence || 0;
      merged.appearanceOrderByPrompt[promptId] = item.appearanceOrder || -1;  // Note: appearanceOrder is order of appearance, not rank
      merged.mentionsByModelByPrompt[promptId] = item.mentionsByModel || {};

      // Store appearanceOrder by model for each prompt (for proper aggregation)
      if (!merged.appearanceOrderByModelByPrompt) {
        merged.appearanceOrderByModelByPrompt = {};
      }
      merged.appearanceOrderByModelByPrompt[promptId] = item.appearanceOrderByModel || {};
      
      // Store excerpts with prompt information
      if (item.excerptsByModel) {
        merged.excerptsByModelByPrompt[promptId] = item.excerptsByModel;
      }
      
      // Aggregate mentions - count REAL mentions across all questions using SUM
      if (promptId !== Object.keys(itemsByPrompt)[0]) {
        // Not the first prompt, so aggregate

        // SUM mentions by model (real count for filtered view)
        for (const [modelId, mentions] of Object.entries(item.mentionsByModel || {})) {
          merged.mentionsByModel[modelId] = (merged.mentionsByModel[modelId] || 0) + (mentions as number);
        }

        // Total mentions = SUM of all mentionsByModel (real total for default view)
        merged.mentions = Object.values(merged.mentionsByModel)
          .reduce((sum: number, count: any) => sum + (count as number), 0);

        // Aggregate weighted influence
        merged.weightedInfluence = (merged.weightedInfluence || 0) + (item.weightedInfluence || 0);

        // Merge trend values (keep the most recent trends)
        if (item.mentionsTrendVals && item.mentionsTrendVals.length > 0) {
          merged.mentionsTrendVals = item.mentionsTrendVals;
          merged.mentionsTrend = item.mentionsTrend;
        }
        
        if (item.influenceTrendVals && item.influenceTrendVals.length > 0) {
          merged.influenceTrendVals = item.influenceTrendVals;
          merged.influenceTrend = item.influenceTrend;
        }
        
        if (item.appearanceOrderTrendVals && item.appearanceOrderTrendVals.length > 0) {
          merged.appearanceOrderTrendVals = item.appearanceOrderTrendVals;
          merged.appearanceOrderTrend = item.appearanceOrderTrend;
        }
      }
    }
  }
  
  // Convert map back to array and recalculate appearanceOrders
  const mergedArray = Array.from(mergedMap.values());
  
  // Validation: Check for suspiciously high mention counts
  const modelCount = Object.keys(itemsByPrompt[Object.keys(itemsByPrompt)[0]][0]?.mentionsByModel || {}).length;
  const questionCount = Object.keys(itemsByPrompt).length;
  const maxReasonableMentions = modelCount * questionCount * 10; // Assume max 10 mentions per model per question
  
  mergedArray.forEach(item => {
    if (item.mentions > maxReasonableMentions) {
      logger.warn(`WARNING: Suspiciously high mention count for "${item.value}": ${item.mentions} mentions (max reasonable: ${maxReasonableMentions})`);
      logger.warn(`  Models: ${modelCount}, Questions: ${questionCount}`);
      logger.warn(`  Mentions by model: ${JSON.stringify(item.mentionsByModel)}`);
    }
  });

  // Recalculate bots/botCount based on final aggregated mentionsByModel
  mergedArray.forEach(item => {
    const botsWithMentions = Object.entries(item.mentionsByModel || {})
      .filter(([botId, mentions]) => (mentions as number) > 0)
      .map(([botId]) => botId);
    item.bots = botsWithMentions.join(',');
    item.botCount = botsWithMentions.length;
    item.uniqueModelCount = botsWithMentions.length;
  });
  
  // Merge excerpts from all prompts into a single excerptsByModel with question info
  mergedArray.forEach(item => {
    if (item.excerptsByModelByPrompt && Object.keys(item.excerptsByModelByPrompt).length > 0) {
      item.excerptsByModel = {};

      // For each prompt that has excerpts
      for (const [promptId, excerptsByModel] of Object.entries(item.excerptsByModelByPrompt)) {
        const question = questionsByPrompt[promptId] || promptId;

        // For each model in this prompt's excerpts
        for (const [modelId, excerpts] of Object.entries(excerptsByModel as any)) {
          if (!item.excerptsByModel[modelId]) {
            item.excerptsByModel[modelId] = [];
          }

          // Add excerpts with question information
          for (const excerpt of excerpts as any[]) {
            item.excerptsByModel[modelId].push({
              ...excerpt,
              question: question,
              promptId: promptId
            });
          }
        }
      }

      // Deduplicate excerpts - keep one per answer (promptId + captureDate) per model
      // This prevents near-identical excerpts when an entity is mentioned multiple times in one answer
      for (const [modelId, excerpts] of Object.entries(item.excerptsByModel)) {
        const seenAnswers = new Set<string>();
        item.excerptsByModel[modelId] = (excerpts as any[]).filter(excerpt => {
          const key = `${excerpt.promptId}|${excerpt.captureDate}`;
          if (seenAnswers.has(key)) return false;
          seenAnswers.add(key);
          return true;
        });
      }
    }
  });
  

  const aiModelsForAnswer = await loadProjectModelConfigs(project, ModelType.GET_ANSWER);

  const normalizedWeights = normalizeModelWeights(aiModelsForAnswer);

  for (const item of mergedArray) {
    // Calculate average appearanceOrder (order of appearance) from all prompts
    const appearanceOrders: number[] = [];
    const appearanceOrderByModel: { [modelId: string]: number[] } = {};

    // Aggregate appearanceOrders from all prompts
    for (const promptId of Object.keys(item.mentionsByPrompt || {})) {
      if (item.appearanceOrderByPrompt && item.appearanceOrderByPrompt[promptId] > 0) {
        appearanceOrders.push(item.appearanceOrderByPrompt[promptId]);
      }

      // Aggregate per-model appearanceOrders if available
      if (item.appearanceOrderByModelByPrompt && item.appearanceOrderByModelByPrompt[promptId]) {
        for (const [modelId, pos] of Object.entries(item.appearanceOrderByModelByPrompt[promptId])) {
          if (!appearanceOrderByModel[modelId]) {
            appearanceOrderByModel[modelId] = [];
          }
          if (typeof pos === 'number' && pos > 0) {
            appearanceOrderByModel[modelId].push(pos);
          }
        }
      }
    }

    // Calculate average appearanceOrder by model (average positions across questions)
    item.appearanceOrderByModel = {};
    for (const [modelId, modelAppearanceOrders] of Object.entries(appearanceOrderByModel)) {
      if (modelAppearanceOrders.length > 0) {
        item.appearanceOrderByModel[modelId] = Number(
          (modelAppearanceOrders.reduce((a: number, b: number) => a + b, 0) / modelAppearanceOrders.length).toFixed(2)
        );
      } else if (item.mentionsByModel && item.mentionsByModel[modelId] > 0) {
        item.appearanceOrderByModel[modelId] = 999; // Unknown appearanceOrder
      }
    }

    // Calculate WEIGHTED AVERAGE appearanceOrder across models
    // This is consistent with enrich-calculate-appearance-order.ts
    // Weight by model importance (estimated_mau) so higher-traffic models have more influence
    if (Object.keys(item.appearanceOrderByModel).length > 0) {
      let weightedSum = 0;
      let totalWeight = 0;

      for (const [modelId, position] of Object.entries(item.appearanceOrderByModel)) {
        if (typeof position === 'number' && position > 0 && position < 999) {
          const weight = normalizedWeights.get(modelId) || 0;
          weightedSum += position * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0) {
        item.appearanceOrder = Number((weightedSum / totalWeight).toFixed(2));
      } else {
        item.appearanceOrder = item.mentions > 0 ? 999 : -1;
      }
    } else {
      item.appearanceOrder = item.mentions > 0 ? 999 : -1;
    }
  }

  // STEP 1: Find global max prominence across all merged items
  let maxProminence = 0;

  for (const item of mergedArray) {
    if (!item.mentions || item.mentions === 0) continue;

    // Calculate total prominence for this item
    let totalProminence = 0;
    for (const [modelId, mentions] of Object.entries(item.mentionsByModel || {})) {
      const appearanceOrder = (item.appearanceOrderByModel || {})[modelId] || 999;
      const prominence = calculateProminence(mentions as number, appearanceOrder);
      totalProminence += prominence;
    }

    if (totalProminence > maxProminence) {
      maxProminence = totalProminence;
    }
  }

  // STEP 2: Recalculate Share of Voice using proper appearanceOrder data and max prominence
  for (const item of mergedArray) {
    if (!item.mentions || item.mentions === 0) {
      item.influence = 0;
      item.influenceByModel = {};
      item.weightedInfluence = 0;
      continue;
    }

    // Calculate Share of Voice using the new formula
    item.influence = calculateShareOfVoice(
      item.mentionsByModel || {},
      item.appearanceOrderByModel || {},
      normalizedWeights,
      maxProminence
    );

    // Calculate per-model share of voice
    item.influenceByModel = calculateInfluenceByModel(
      item.mentionsByModel || {},
      item.appearanceOrderByModel || {},
      normalizedWeights,
      maxProminence
    );

    // Keep weightedInfluence for backward compatibility
    item.weightedInfluence = item.influence;
  }

  // No need for normalizeInfluences() - Share of Voice is already 0-1 scale

  // No sorting here - let the frontend handle sorting by any column the user prefers
  // Note: appearanceOrder field represents the average order of appearance in answers

  return mergedArray;
}


// Collect questions data with answer counts
async function collectQuestionsData(project: string, date: string, questions: QuestionEntry[]): Promise<any> {
  const questionsData: any[] = [];
  let totalAnswers = 0;
  
  for (const question of questions) {
    const promptId = question.folder;
    const questionText = question.question;
    // Extract question number from promptId (e.g., "1-what-are-the-best-ci" -> 1)
    const questionNumber = parseInt(promptId.split('-')[0]) || 0;
    
    // Count answers by checking model directories
    const answersPath = path.join(QUESTIONS_DIR(project), promptId, 'answers', date);
    let answerCount = 0;
    
    try {
      const modelDirs = await fs.readdir(answersPath, { withFileTypes: true });
      // Count directories that contain actual answer files
      for (const dir of modelDirs) {
        if (dir.isDirectory()) {
          try {
            const answerFile = path.join(answersPath, dir.name, 'answer.md');
            await fs.access(answerFile);
            answerCount++;
          } catch {
            // No answer file in this model directory
          }
        }
      }
    } catch (error) {
      logger.warn(`Could not count answers for ${promptId}: ${error}`);
    }
    
    totalAnswers += answerCount;
    
    questionsData.push({
      id: promptId,
      number: questionNumber,
      text: questionText,
      answerCount: answerCount,
      reportUrl: `./${promptId}/index.html`
    });
  }
  
  // Sort by question number
  questionsData.sort((a, b) => a.number - b.number);
  
  return {
    questions: questionsData,
    totalQuestions: questionsData.length,
    totalAnswers: totalAnswers,
    reportDate: date
  };
}

// Main aggregation function
export async function generateAggregateReport(project: string, date: string): Promise<void> {
  logger.info(`Starting aggregate report generation for ${project} on ${date}`);
  
  try {
    // Load questions
    const questions = await readQuestions(project);
    const promptIds = questions.map(q => q.folder);
    logger.info(`Found ${promptIds.length} prompts to aggregate`);
    
    // Collect questions data with answer counts
    const questionsData = await collectQuestionsData(project, date, questions);
    logger.info(`Collected questions data: ${questionsData.totalQuestions} questions, ${questionsData.totalAnswers} total answers`);

    // Load the pre-enriched aggregate data (already calculated in enrichment pipeline)
    const aggregatedCompiledPath = path.join(AGGREGATED_DATA_COMPILED_DATE_DIR(project, date), `${date}-data.js`);
    let aggregatedData: any;

    try {
      aggregatedData = await loadEnrichedData(aggregatedCompiledPath);
      logger.info(`Loaded pre-enriched aggregate data from ${aggregatedCompiledPath}`);
    } catch (error) {
      throw new Error(`Failed to load pre-enriched aggregate data: ${error}`);
    }

    // Use promptIds as validPrompts (for metadata)
    const validPrompts = promptIds;

    // Add metadata to the pre-enriched aggregate data
    // (Entity data is already calculated correctly in the enrichment pipeline)
    aggregatedData.report_type = 'aggregate';
    aggregatedData.report_date = date;
    aggregatedData.report_question = project;
    aggregatedData.report_title = project;
    aggregatedData.prompts = validPrompts;
    aggregatedData.promptQuestions = questions;
    aggregatedData.questionsData = questionsData;

    // Fix report metadata for aggregate reports
    aggregatedData.reportMetadata = {
      isQuestionReport: false,
      isAggregateReport: true,
      totalQuestions: validPrompts.length,
      questionsIncluded: validPrompts
    };

    // Recalculate total counts from already-enriched data
    if (!aggregatedData.totalCounts) {
      aggregatedData.totalCounts = {};
    }

    aggregatedData.totalDataPoints = 0;
    for (const name of MAIN_SECTIONS) {
      if (aggregatedData[name] && Array.isArray(aggregatedData[name])) {
        aggregatedData.totalCounts[name] = aggregatedData[name].length;
        aggregatedData.totalDataPoints += aggregatedData[name].length;
      }
    }

    aggregatedData.totalCounts.bots = aggregatedData.bots ? aggregatedData.bots.length : 0;
    
    // Recalculate itemCountPerModel and itemCountPerAppearanceOrderTrend
    aggregatedData.itemCountPerModel = {};
    aggregatedData.itemCountPerAppearanceOrderTrend = {};
    
    for (const arrayName of MAIN_SECTIONS ) {
      // Count by model
      const modelCounts: Record<string, number> = {};
      const trendCounts: Record<string, number> = {};
      
      for (const item of aggregatedData[arrayName]) {
        // Count by model
        for (const [modelId, mentions] of Object.entries(item.mentionsByModel || {})) {
          if ((mentions as number) > 0) {
            modelCounts[modelId] = (modelCounts[modelId] || 0) + 1;
          }
        }
        
        // Count by trend
        const trend = String(item.appearanceOrderTrend || -9999);
        trendCounts[trend] = (trendCounts[trend] || 0) + 1;
      }
      
      // Convert to array format
      aggregatedData.itemCountPerModel[arrayName] = Object.entries(modelCounts)
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count);
        
      aggregatedData.itemCountPerAppearanceOrderTrend[arrayName] = Object.entries(trendCounts)
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count);
    }
    
    // Create output directories and file manager
    const outputDir = OUTPUT_DIR(project);

    await fs.mkdir(outputDir, { recursive: true });


    // copy answers file
    const answersFile = path.join(AGGREGATED_DATA_COMPILED_DATE_DIR(project, date), `${date}-answers.js`);
    await fs.copyFile(answersFile, path.join(outputDir, `${date}-answers.js`));
    logger.info(`Copied answers file ${answersFile} to ${path.join(outputDir, `${date}-answers.js`)}`);

    // Build base URL for absolute canonical URLs in entity/source pages
    const projectConfig = await validateAndLoadProject(project, true);
    const publishedUrlBase = projectConfig?.published_url_base || null;
    const baseUrl = publishedUrlBase
      ? `${publishedUrlBase}${encodeURIComponent(project)}/`
      : null;

    // Generate entity pages for aggregate report
    try {
      const aggregatedDataFile = path.join(AGGREGATED_DATA_COMPILED_DATE_DIR(project, date), `${date}-data.js`);
      const entityPagesGenerated = await generateEntityPages({
        project,
        questionId: '_aggregate',
        targetDate: date,
        outputDir,
        templateDir: REPORT_HTML_TEMPLATE_DIR,
        enrichedDataFile: aggregatedDataFile,
        baseUrl
      });
      if (entityPagesGenerated > 0) {
        logger.info(`Generated ${entityPagesGenerated} entity pages for aggregate report`);
      }
    } catch (entityError) {
      logger.warn(`Could not generate entity pages for aggregate: ${entityError instanceof Error ? entityError.message : String(entityError)}`);
    }

    // Generate source domain pages for aggregate report
    try {
      const aggregatedDataFile = path.join(AGGREGATED_DATA_COMPILED_DATE_DIR(project, date), `${date}-data.js`);
      const sourcePagesGenerated = await generateSourcePages({
        project,
        questionId: '_aggregate',
        targetDate: date,
        outputDir,
        templateDir: REPORT_HTML_TEMPLATE_DIR,
        enrichedDataFile: aggregatedDataFile,
        baseUrl
      });
      if (sourcePagesGenerated > 0) {
        logger.info(`Generated ${sourcePagesGenerated} source pages for aggregate report`);
      }
    } catch (sourceError) {
      logger.warn(`Could not generate source pages for aggregate: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}`);
    }

    // Generate static SEO-friendly main page for aggregate report
    try {
      const aggregatedDataFile = path.join(AGGREGATED_DATA_COMPILED_DATE_DIR(project, date), `${date}-data.js`);

      // Build questions list with counts for the static page
      const questionsForStatic = questions.map(q => ({
        id: q.folder,
        text: q.question,
        brandsCount: questionsData.questions.find((qd: { id: string }) => qd.id === q.folder)?.uniqueBrands || 0,
        domainsCount: questionsData.questions.find((qd: { id: string }) => qd.id === q.folder)?.uniqueDomains || 0
      }));

      const staticResult = await generateStaticMainPage({
        project,
        targetDate: date,
        outputDir,
        templateDir: REPORT_HTML_TEMPLATE_DIR,
        enrichedDataFile: aggregatedDataFile,
        isAggregate: true,
        questions: questionsForStatic
      });
      if (staticResult) {
        logger.info(`Generated static main page for aggregate report`);
      }
    } catch (staticError) {
      logger.warn(`Could not generate static main page for aggregate: ${staticError instanceof Error ? staticError.message : String(staticError)}`);
      // Don't fail if static page generation fails
    }

    logger.info(`Aggregate report generated successfully at:`);
    logger.info(`  - ${outputDir}/index.html`);

    
  } catch (error) {
    logger.error(`Failed to generate aggregate report: ${error}`);
    throw error;
  }
}
