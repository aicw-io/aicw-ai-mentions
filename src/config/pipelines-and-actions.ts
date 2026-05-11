import { USER_PIPELINES_JSON_FILE } from './user-paths.js';
import fs from 'fs';

/**
 * AppAction - Universal action that can be both a pipeline step and CLI command.
 */
export interface AppAction {
  /** Unique identifier */
  id: string;

  /** Script path relative to dist/ (without .js). Example: 'actions/project-new' */
  cmd: string;

  /** Human-readable name */
  name: string;

  /** Description shown during execution */
  desc: string;

  /**
   * Pipeline tags - which pipelines include this action.
   * Tags: 'project-build', 'project-rebuild', 'project-report-only'
   */
  pipelines: string[];

  /** REQUIRED: Category for help display */
  category: 'utility' | 'project' | 'project-advanced';

  /** Optional: CLI command name (if this action can be run standalone) */
  cliCommand?: string;

  /** Optional: Whether CLI command requires a project argument */
  requiresProject?: boolean;

  /* optional: whether the action requires a pipe to return the project name or another string to the pipeline */
  requiresConsolePipeReturn?: boolean;

  /** Optional: Run action directly in same process instead of spawning child (for long-running services) */
  runDirectly?: boolean;
}

/** Complete pipeline definition */
export interface PipelineDefinition {
  /** Unique pipeline identifier */
  id: string;
  /** Display name for menu */
  name: string;
  /** Description shown in menu */
  description: string;
  /** Pipeline category used to filter actions */
  category: string;
  /** Actions to execute in order */
  actions: AppAction[];
  /** Optional: CLI command that triggers this pipeline */
  cliCommand?: string;
  /* optional: next step pipeline to run after this action */
  nextPipeline?: string;
  /** Optional: whether the pipeline requires full configuration */
  requiresApiKeys?: boolean;
  /** Optional: pipeline type (e.g., "advanced") - advanced pipelines shown only with --advanced flag */
  type?: string;
  /** Optional: stable menu ID (prevents renumbering when items added) */
  menuItemId?: number;
}

/** Category definition for organizing pipelines in menu */
export interface CategoryDefinition {
  /** Unique category identifier */
  id: string;
  /** Display name for menu */
  name: string;
  /** Icon/emoji for visual identification */
  icon: string;
}

export function loadPipelinesConfigJson(): any {
  return JSON.parse(fs.readFileSync(USER_PIPELINES_JSON_FILE, 'utf8'));
}

/**
 * All possible actions in the system.
 * Each action declares which pipelines it belongs to via pipelines.
 */
export const APP_ACTIONS: AppAction[] = loadPipelinesConfigJson().actions as AppAction[];

/**
 * Category definitions for organizing pipelines
 */
export const CATEGORIES: CategoryDefinition[] = loadPipelinesConfigJson().categories as CategoryDefinition[] || [];

// Build pipeline definitions with actions populated via filter
const rawPipelines = loadPipelinesConfigJson().pipelines as PipelineDefinition[];

// Convert raw pipeline configs to PipelineDefinition with actions
const builtPipelines: PipelineDefinition[] = rawPipelines.map(pipeline => ({
  ...pipeline,
  actions: APP_ACTIONS.filter(action => action.pipelines.includes(pipeline.id))
}));

// PIPELINE DEFINITIONS
// All pipelines from JSON - includes all categories dynamically
export const ALL_PIPELINES: PipelineDefinition[] = builtPipelines;

// Category-specific exports for backwards compatibility (derived dynamically)
export const PROJECT_PIPELINES: PipelineDefinition[] = ALL_PIPELINES.filter(p => p.category === 'project' && p.type !== 'advanced');

export const UTILITY_PIPELINES: PipelineDefinition[] = ALL_PIPELINES.filter(p => p.category === 'utility');

export const ADVANCED_PIPELINES: PipelineDefinition[] = ALL_PIPELINES.filter(p => p.type === 'advanced');



// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

/**
 * Get action by ID
 */
export function getAction(id: string): AppAction | undefined {
  return APP_ACTIONS.find(a => a.id === id);
}

/**
 * Get action by CLI command name or alias
 */
export function getActionByCommand(command: string): AppAction | undefined {
  return APP_ACTIONS.find(a =>
    a.id === command
  );
}

/**
 * Get all actions with a specific pipeline tag
 */
export function getActionsByTag(tag: string): AppAction[] {
  return APP_ACTIONS.filter(a => a.pipelines.includes(tag));
}

/**
 * Get pipeline by ID
 */
export function getPipeline(id: string): PipelineDefinition | undefined {
  return ALL_PIPELINES.find(p => p.id === id);
}

/**
 * Build alias map for fast CLI lookup
 */
export function getAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const action of APP_ACTIONS) {
    if (action.id) {
      map[action.id] = action.id;
    }
  }
  return map;
}

/**
 * Get all unique script paths
 */
export function getAllScriptPaths(): string[] {
  return Array.from(new Set(APP_ACTIONS.map(a => a.cmd))).sort();
}

/**
 * Get all script paths as filenames (with .js extension)
 */
export function getAllScriptFilenames(): string[] {
  return getAllScriptPaths().map(path => `${path}.js`);
}

/**
 * Get count of all unique scripts
 */
export function getScriptCount(): number {
  const paths = getAllScriptPaths();
  return paths.length;
}

/**
 * Get all CLI commands (actions that have cliCommand defined)
 */
export function getCliCommands(): AppAction[] {
  return APP_ACTIONS.filter(a => a.id);
}

/**
 * Get all CLI-invokable items (pipelines + actions with cliCommand)
 */
export interface CliMenuItem {
  id: string;
  name: string;
  description: string;
  cliCommand: string;
  category: string;
  requiresProject?: boolean;
  nextPipeline?: string;
  type?: string;
  menuItemId?: number;  // Optional stable menu ID (prevents renumbering when items added)
}


/**
 * Get all CLI menu items (pipelines + standalone actions) organized by category
 * @param showAdvanced - Include advanced pipelines (default: false)
 */
export function getCliMenuItems(showAdvanced: boolean = false): CliMenuItem[] {
  const items: CliMenuItem[] = [];

  // Add invokable pipelines
  const pipelines = ALL_PIPELINES.filter(p => {
    // Filter out advanced pipelines unless showAdvanced is true
    if (p.type === 'advanced' && !showAdvanced) {
      return false;
    }
    return true;
  });

  for (const pipeline of pipelines) {
    items.push({
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      cliCommand: pipeline.id!,
      category: pipeline.category,
      requiresProject: pipeline.category === 'project',
      nextPipeline: pipeline.nextPipeline,
      type: pipeline.type,
      menuItemId: pipeline.menuItemId,
    });
  }

  return items;
}

/**
 * Get category by ID
 */
export function getCategory(id: string): CategoryDefinition | undefined {
  return CATEGORIES.find(c => c.id === id);
}

/**
 * Get categories in defined order
 */
export function getCategoriesInOrder(): CategoryDefinition[] {
  return CATEGORIES;
}
