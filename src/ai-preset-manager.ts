import fs from 'fs';
import path from 'path';
import { USER_AI_PRESETS_DIR, USER_MODELS_JSON_FILE } from './config/user-paths.js';
import { ModelConfig } from './utils/model-config.js';
import { logger } from './utils/compact-logger.js';
import { PipelineCriticalError } from './utils/pipeline-errors.js';
import { ModelType } from './utils/project-utils.js';
export const DEFAULT_PRESET_NAME = 'ai_chats_with_search';



export interface AIPreset {
  name: string;
  description: string;
  models: {
    [ModelType.GET_ANSWER]: string[];
    [ModelType.EXTRACT_ENTITIES]: string[];
  }
}

export interface AIPresetWithModels extends AIPreset {
  modelConfigs: {}
}

/**
 * Load all available models from ai_models.json
 */
export function loadAllModels(): ModelConfig[] {

  try {
    const modelsData = fs.readFileSync(USER_MODELS_JSON_FILE, 'utf8');
    const models = JSON.parse(modelsData).models; // Extract models array from wrapped structure

    logger.debug(`Loaded ${models?.length || 0} models from ai_models.json`);
    return models;
  } catch (error: any) {
    logger.error(`Failed to load ai_models.json: ${error?.message || error}`);
    throw new Error(`Failed to load models from ${USER_MODELS_JSON_FILE}: ${error}`);
  }
}

/**
 * Get a model by its ID (supports both real model IDs and synonym IDs)
 */
export function getModelById(modelId: string): ModelConfig | undefined {
  const models = loadAllModels();
  // Resolve AI products to actual model ID if needed
  const data = JSON.parse(fs.readFileSync(USER_MODELS_JSON_FILE, 'utf8'));
  // search given modelId in aliases first
  const modelAlias = data.aliases?.find((s: any) => s.id === modelId);

  // if it is an alias, we need to find the actual model in the models catalog
  if (modelAlias) {
    // Return model with synonym ID preserved but actual model params
    const targetModel = models.find(m => m.id === modelAlias.targetModelId);
    
    if (targetModel) {
      // Merge actualModel and modelAlias, with modelAlias properties taking precedence (except for id, which is set to requested modelId)
      // as a results we will have modelConfig with all the properties of the actual model and the alias
      // and also with non-empty targetModelId which we will use to find target model id
      return { 
        ...targetModel, // target AI model config
        ...modelAlias, // overriding properties of the actual model with the alias properties if needed
        id: modelId  // id of the alias. we check targetModelId to find final model id
      };
    }
  }

  // otherwise it is not an alias, we just finding a model in the models catalog
  return models.find(m => m.id === modelId);
}

/**
 * Load all available ai_presets from the ai_presets directory
 */
export function loadAllAIPresets(): Map<string, AIPreset> {

  try {
    if (!fs.existsSync(USER_AI_PRESETS_DIR)) {
      logger.error(`AIPresets directory not found: ${USER_AI_PRESETS_DIR}`);
      throw new Error(`AIPresets directory not found: ${USER_AI_PRESETS_DIR}`);
    }

    const ai_presets = new Map<string, AIPreset>();   

    const files = fs.readdirSync(USER_AI_PRESETS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const ai_presetPath = path.join(USER_AI_PRESETS_DIR, file);
      const ai_presetName = path.basename(file, '.json');

      try {
        const content = fs.readFileSync(ai_presetPath, 'utf8');
        const ai_preset = JSON.parse(content) as AIPreset;

        // Validate ai_preset structure
        if (!ai_preset.name) {
          logger.error(`Invalid ai_preset structure in ${file}`);
          throw new Error(`Invalid ai_preset structure in ${file}`);
        }
        ai_presets.set(ai_presetName, ai_preset);
        logger.debug(`Loaded ai_preset: ${ai_presetName}`);
      } catch (error: any) {
        logger.error(`Failed to load ai_preset ${file}: ${error?.message || error}`);
        throw new Error(`Failed to load ai_preset ${file}: ${error?.message || error}`);
      }
    }

    return ai_presets;
    
  } catch (error: any) {
    logger.error(`Failed to load ai_presets: ${error?.message || error}`);
    throw new Error(`Failed to load ai_presets: ${error?.message || error}`);
  }
}

/**
 * Get a specific ai_preset by name
 */
export function getAIPreset(ai_presetName: string): AIPreset | undefined {
  const ai_presets = loadAllAIPresets();
  return ai_presets.get(ai_presetName);
}

/**
 * Get a ai_preset with resolved model configurations
 */
export function getAIAIPresetWithModels(ai_presetName: string): AIPresetWithModels | undefined {
  const ai_preset = getAIPreset(ai_presetName);
  if (!ai_preset) {
    return undefined;
  }

  const resolveModels = (modelIds: string[]): ModelConfig[] => {
    const resolved: ModelConfig[] = [];
    for (const id of modelIds) {
      const model = getModelById(id); // Now handles products
      if (model) {
        resolved.push(model);
      } else {
        logger.error(`Model ${id} not found in ai_models.json (referenced in ai_preset ${ai_presetName})`);
        throw new PipelineCriticalError(
          `Model ${id} not found in ai_models.json (referenced in ai_preset ${ai_presetName})`, 
          'ai-preset-manager'
        );
      }
    }
    return resolved;
  };

  const modelConfigs = {};
  for (const type of Object.keys(ai_preset.models)) {
    modelConfigs[type] = resolveModels(ai_preset.models[type]);
  }

  return {
    ...ai_preset,
    modelConfigs: modelConfigs
  };
}

/**
 * Get list of all available ai_preset names
 */
export function getAIPresetNames(): string[] {
  const ai_presets = loadAllAIPresets();
  return Array.from(ai_presets.keys());
}

/**
 * Get the default ai_preset (DEFAULT_PRESET_NAME if it exists)
 */
export function getDefaultAIPreset(): AIPreset | undefined {
  return getAIPreset(DEFAULT_PRESET_NAME);
}
