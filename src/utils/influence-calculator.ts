import { ModelConfig } from './model-config.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARE OF VOICE (INFLUENCE) CALCULATION - SINGLE SOURCE OF TRUTH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Share of Voice measures how prominent an entity is across AI models, considering:
 * 1. MODEL COVERAGE: Which AI models mention you (weighted by their user base)
 * 2. MENTION FREQUENCY: How many times you're mentioned
 * 3. PROMINENCE: Where you appear in results (position/rank)
 *
 * FORMULA:
 * --------
 * Share of Voice = Model Coverage × Quality Score
 *
 * Where:
 *   Model Coverage = Sum of normalized weights for models that mention you (0-1)
 *   Quality Score = Your prominence / Max prominence in dataset (0-1)
 *   Prominence = mentions × (1 / log2(position + 1))
 *
 * EXAMPLES:
 * ---------
 * Example 1: Christina Inge
 *   - Mentioned 1 time in ChatGPT (60% of market) at position 1
 *   - Model Coverage = 0.60 (only ChatGPT)
 *   - Prominence = 1 × (1/log2(2)) = 1.0
 *   - Quality Score = 1.0 / 10.0 (if max in dataset is 10.0) = 0.10
 *   - Share of Voice = 0.60 × 0.10 = 0.06 = 6%
 *
 * Example 2: ChatGPT (the product)
 *   - Mentioned 13 times across 11 models at various positions
 *   - Model Coverage = 1.0 (all models weighted by MAU)
 *   - Prominence = sum of (mentions × position_score) across models = 8.5
 *   - Quality Score = 8.5 / 10.0 = 0.85
 *   - Share of Voice = 1.0 × 0.85 = 0.85 = 85%
 *
 * Example 3: Perfect Score
 *   - Mentioned frequently in all models at position 1
 *   - Model Coverage = 1.0 (all models)
 *   - Quality Score = 1.0 (highest prominence)
 *   - Share of Voice = 1.0 × 1.0 = 1.0 = 100%
 *
 * To achieve 100% Share of Voice, you need:
 *   - BOTH full model coverage (mentioned in all weighted models)
 *   - AND highest prominence (many mentions at top positions)
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Normalize model weights so they sum to 1.0 across all models
 * This ensures consistent influence calculations regardless of number of models
 */
export function normalizeModelWeights(models: ModelConfig[]): Map<string, number> {
  const weights = new Map<string, number>();

  // Calculate raw weights based on estimated active users
  let totalWeight = 0;
  for (const model of models) {
    let weight = 0.5; // Default weight if no user data

    if (model.estimated_mau && model.estimated_mau > 0) {
      // Normalize to 0-1 scale (assuming max 1 billion users)
      weight = Math.min(model.estimated_mau / 1000000000, 1);
    }

    weights.set(model.id, weight);
    totalWeight += weight;
  }

  // Normalize so sum equals 1.0
  if (totalWeight > 0) {
    for (const [modelId, weight] of weights) {
      weights.set(modelId, weight / totalWeight);
    }
  }

  return weights;
}

/**
 * Calculate prominence score for a single model's mention
 * Prominence = mentions × position_score
 *
 * Position uses logarithmic decay:
 *   - Position 1 = 1.00 (100%)
 *   - Position 2 = 0.63 (63%)
 *   - Position 5 = 0.43 (43%)
 *   - Position 10 = 0.29 (29%)
 *
 * @param mentions - Number of times mentioned in this model
 * @param appearanceOrder - Position in results (1 = first, 2 = second, etc.)
 * @returns Prominence score (unbounded, will be used for quality calculation)
 */
export function calculateProminence(
  mentions: number,
  appearanceOrder: number
): number {
  if (mentions === 0) {
    return 0;
  }

  // Position score: items appearing earlier get higher scores
  // Using logarithmic decay: position 1 = 1.0, position 2 = 0.63, position 5 = 0.43, etc.
  const positionScore = appearanceOrder > 0 ? 1 / Math.log2(appearanceOrder + 1) : 0;

  // Prominence = mentions × position_score
  const prominence = mentions * positionScore;

  return prominence;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CALCULATE SHARE OF VOICE - MAIN FUNCTION (SINGLE SOURCE OF TRUTH)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the ONLY function that should be used to calculate Share of Voice.
 * See the header documentation for formula explanation and examples.
 *
 * @param mentionsByModel - Object mapping model IDs to mention counts
 * @param appearanceOrderByModel - Object mapping model IDs to position (1 = first)
 * @param normalizedWeights - Pre-normalized model weights (sum = 1.0)
 * @param maxProminenceInDataset - The highest prominence score in the entire dataset
 * @returns Share of Voice as a decimal (0.0 to 1.0, representing 0% to 100%)
 */
export function calculateShareOfVoice(
  mentionsByModel: { [modelId: string]: number },
  appearanceOrderByModel: { [modelId: string]: number },
  normalizedWeights: Map<string, number>,
  maxProminenceInDataset: number
): number {
  if (!mentionsByModel || Object.keys(mentionsByModel).length === 0) {
    return 0;
  }

  // STEP 1: Calculate Model Coverage (0-1)
  // Sum of weights for models that mention this item
  let modelCoverage = 0;
  let totalProminence = 0;

  for (const [modelId, mentions] of Object.entries(mentionsByModel)) {
    if (mentions > 0) {
      const weight = normalizedWeights.get(modelId) || 0;
      const appearanceOrder = appearanceOrderByModel[modelId] || 999;

      // Add to model coverage
      modelCoverage += weight;

      // Calculate prominence for this model
      const prominence = calculateProminence(mentions, appearanceOrder);
      totalProminence += prominence;
    }
  }

  // STEP 2: Calculate Quality Score (0-1)
  // Normalize prominence against the max in dataset
  const qualityScore = maxProminenceInDataset > 0
    ? totalProminence / maxProminenceInDataset
    : 0;

  // STEP 3: Calculate Share of Voice
  // Model Coverage × Quality Score
  const shareOfVoice = modelCoverage * qualityScore;

  return Number(shareOfVoice.toFixed(5));
}

/**
 * Calculate weighted influence for an item based on mentions by different models
 * DEPRECATED: Use calculateShareOfVoice() instead for new code
 * This is kept for backward compatibility during migration
 *
 * @param mentionsByModel - Object mapping model IDs to mention counts
 * @param appearanceOrderByModel - Object mapping model IDs to appearanceOrder (order of appearance)
 * @param normalizedWeights - Pre-normalized model weights
 * @param maxProminenceInDataset - Optional: max prominence for proper scaling
 * @returns Total weighted influence
 */
export function calculateWeightedInfluence(
  mentionsByModel: { [modelId: string]: number },
  appearanceOrderByModel: { [modelId: string]: number },
  normalizedWeights: Map<string, number>,
  maxProminenceInDataset?: number
): number {
  // If maxProminence provided, use new Share of Voice calculation
  if (maxProminenceInDataset !== undefined) {
    return calculateShareOfVoice(
      mentionsByModel,
      appearanceOrderByModel,
      normalizedWeights,
      maxProminenceInDataset
    );
  }

  // Legacy calculation (will be removed after migration)
  let totalProminence = 0;

  for (const [modelId, mentions] of Object.entries(mentionsByModel)) {
    if (mentions > 0) {
      const weight = normalizedWeights.get(modelId) || 0;
      const appearanceOrder = appearanceOrderByModel[modelId] || 999;

      const prominence = calculateProminence(mentions, appearanceOrder);
      totalProminence += prominence * weight;
    }
  }

  return Number(totalProminence.toFixed(5));
}

/**
 * Calculate per-model share of voice values
 * Shows the contribution from each model to an item's overall share of voice
 *
 * @param mentionsByModel - Object mapping model IDs to mention counts
 * @param appearanceOrderByModel - Object mapping model IDs to appearanceOrder
 * @param normalizedWeights - Pre-normalized model weights
 * @param maxProminenceInDataset - Optional: max prominence for proper scaling
 * @returns Object mapping model IDs to their share of voice contribution
 */
export function calculateInfluenceByModel(
  mentionsByModel: { [modelId: string]: number },
  appearanceOrderByModel: { [modelId: string]: number },
  normalizedWeights: Map<string, number>,
  maxProminenceInDataset?: number
): { [modelId: string]: number } {
  const influenceByModel: { [modelId: string]: number } = {};

  for (const [modelId, mentions] of Object.entries(mentionsByModel)) {
    const weight = normalizedWeights.get(modelId) || 0;
    const appearanceOrder = appearanceOrderByModel[modelId] || 999;

    if (maxProminenceInDataset !== undefined && maxProminenceInDataset > 0) {
      // New calculation: Model's contribution to Share of Voice
      // = model_weight × (prominence / max_prominence)
      const prominence = calculateProminence(mentions, appearanceOrder);
      const qualityScore = prominence / maxProminenceInDataset;
      influenceByModel[modelId] = Number((weight * qualityScore).toFixed(5));
    } else {
      // Legacy calculation
      const prominence = calculateProminence(mentions, appearanceOrder);
      influenceByModel[modelId] = Number((prominence * weight).toFixed(5));
    }
  }

  return influenceByModel;
}

/**
 * Normalize influence values so the maximum is 1.0 (100%)
 * Ensures the best-performing item has exactly 100% influence
 */
export function normalizeInfluences(items: any[]): void {
  if (!items || items.length === 0) return;

  // Find max influence across all items
  const maxInfluence = Math.max(...items.map(item => item.influence || 0));
  if (maxInfluence === 0) return;

  // Normalize all influence values
  items.forEach(item => {
    if (item.influence) {
      item.influence = Number((item.influence / maxInfluence).toFixed(5));
      item.weightedInfluence = item.influence; // Keep backward compatibility
    }

    // Normalize per-model influences too
    if (item.influenceByModel) {
      const maxModelInfluence = Math.max(...Object.values(item.influenceByModel).map(v => Number(v) || 0));
      if (maxModelInfluence > 0) {
        for (const modelId in item.influenceByModel) {
          item.influenceByModel[modelId] = Number(
            (item.influenceByModel[modelId] / maxModelInfluence).toFixed(5)
          );
        }
      }
    }
  });
}

/**
 * Calculate influence for all items in a batch
 * Uses Share of Voice calculation with proper maxProminence normalization.
 *
 * @param items - Array of items to calculate influence for
 * @param models - Array of model configurations
 * @returns The items with influence values added
 */
export function calculateInfluenceForItems(
  items: any[],
  models: ModelConfig[]
): any[] {
  if (!items || items.length === 0) {
    return items;
  }

  // Get normalized weights once
  const normalizedWeights = normalizeModelWeights(models);

  // STEP 1: Calculate maxProminence across all items (same as report-aggregation.ts)
  // This is needed for proper Share of Voice calculation
  let maxProminence = 0;
  for (const item of items) {
    if (!item.mentions || item.mentions === 0) continue;

    let totalProminence = 0;
    for (const [modelId, mentions] of Object.entries(item.mentionsByModel || {})) {
      const appearanceOrder = (item.appearanceOrderByModel || {})[modelId] || 999;
      totalProminence += calculateProminence(mentions as number, appearanceOrder);
    }
    maxProminence = Math.max(maxProminence, totalProminence);
  }

  // STEP 2: Calculate Share of Voice for each item using maxProminence
  for (const item of items) {
    // Skip if no mentions
    if (!item.mentions || item.mentions === 0) {
      item.influence = 0;
      item.influenceByModel = {};
      item.weightedInfluence = 0;
      continue;
    }

    // Ensure we have appearanceOrder data (use high number if missing)
    if (!item.appearanceOrderByModel) {
      item.appearanceOrderByModel = {};
      for (const model of models) {
        if (item.mentionsByModel && item.mentionsByModel[model.id]) {
          item.appearanceOrderByModel[model.id] = 999; // Unknown appearanceOrder
        }
      }
    }

    // Calculate Share of Voice (not legacy calculateWeightedInfluence)
    item.influence = calculateShareOfVoice(
      item.mentionsByModel || {},
      item.appearanceOrderByModel || {},
      normalizedWeights,
      maxProminence
    );

    // Calculate per-model influence with maxProminence
    item.influenceByModel = calculateInfluenceByModel(
      item.mentionsByModel || {},
      item.appearanceOrderByModel || {},
      normalizedWeights,
      maxProminence
    );

    // Keep weightedInfluence for backward compatibility
    item.weightedInfluence = item.influence;
  }

  // NOTE: Do NOT call normalizeInfluences() - Share of Voice already returns 0-1 normalized values
  // Calling it would cause double normalization

  return items;
}