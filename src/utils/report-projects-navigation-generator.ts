import { promises as fs } from 'fs';
import path from 'path';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { USER_REPORTS_DIR, DEFAULT_INDEX_FILE, getProjectNameFromProjectFolder, getCurrentDateTimeAsString } from '../config/user-paths.js';
import { replaceMacrosInTemplate, writeFileAtomic, loadCustomFooterCode } from './misc-utils.js';
import { logger } from './compact-logger.js';
import { NAVIGATION_TEMPLATES_DIR } from '../config/paths.js';

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Metadata file to track generation times
const NAV_META_FILE = '.navigation-meta.json';

const DEFAULT_EMPTY_STATE = `<!-- No projects, empty state not needed -->`;

// Category name to emoji mapping for visual distinction
const CATEGORY_EMOJIS: Record<string, string> = {
  'Accounting': '📊',
  'AI Mention Tracking Tools': '🔍',
  'AI Tools': '🤖',
  'AI Tools for Marketers': '📣',
  'Analytics and BI': '📈',
  'Cloud Storage': '☁️',
  'CRM Software': '👥',
  'Customer Support': '🎧',
  'Cybersecurity': '🔒',
  'Design Tools': '🎨',
  'Developer Tools': '🛠️',
  'E-commerce': '🛒',
  'Email Marketing': '📧',
  'HR Software': '👔',
  'Marketing Automation': '⚡',
  'Open Sources Projects': '💻',
  'Project Management': '📋',
  'Video Conferencing': '📹',
};
const DEFAULT_EMOJI = '📊';

interface NavigationMetadata {
  lastGenerated: string;
  projectTimestamps: Record<string, number>;
}

/**
 * Load HTML template and replace placeholders
 */
async function loadNavigationTemplate(templateName: string): Promise<string> {
  const templatePath = path.join(NAVIGATION_TEMPLATES_DIR, `${templateName}.html`);
  const content = await fs.readFile(templatePath, 'utf-8');

  const now = new Date();
  const generationTime = now.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true  
  });

  // Replace placeholders

  const filled = await replaceMacrosInTemplate(content, {
    '{{YEAR}}': now.getFullYear().toString(),
    '{{GENERATION_TIME}}': generationTime
  },
  false);

  return filled;
}

/**
 * Get modification time of a directory
 */
async function getDirectoryMTime(dirPath: string): Promise<number> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Check if navigation needs regeneration
 */
async function needsRegeneration(outputDir: string, projects?: string[]): Promise<boolean> {
  const metaPath = path.join(outputDir, NAV_META_FILE);

  if (!existsSync(metaPath)) {
    return true; // No metadata, need to generate
  }

  try {
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const metadata: NavigationMetadata = JSON.parse(metaContent);

    // Check specific projects if provided
    if (projects && projects.length > 0) {
      for (const project of projects) {
        const projectDir = path.join(outputDir, project);
        const currentMTime = await getDirectoryMTime(projectDir);
        const lastMTime = metadata.projectTimestamps[project] || 0;

        if (currentMTime > lastMTime) {
          return true; // Project has changed
        }
      }
      return false; // No changes in specified projects
    }

    // Check all projects (directories directly under outputDir)
    const dirs = await fs.readdir(outputDir, { withFileTypes: true });
    const projectDirs = dirs.filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const dir of projectDirs) {
      const projectDir = path.join(outputDir, dir.name);
      const currentMTime = await getDirectoryMTime(projectDir);
      const lastMTime = metadata.projectTimestamps[dir.name] || 0;

      if (currentMTime > lastMTime) {
        return true; // Project has changed
      }
    }

    return false; // No changes detected
  } catch {
    return true; // Error reading metadata, regenerate
  }
}

/**
 * Update navigation metadata
 */
async function updateMetadata(outputDir: string): Promise<void> {
  const metaPath = path.join(outputDir, NAV_META_FILE);

  const metadata: NavigationMetadata = {
    lastGenerated: new Date().toISOString(),
    projectTimestamps: {}
  };

  // Projects are directly under outputDir
  const dirs = await fs.readdir(outputDir, { withFileTypes: true });
  const projectDirs = dirs.filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const dir of projectDirs) {
    const projectDir = path.join(outputDir, dir.name);
    metadata.projectTimestamps[dir.name] = await getDirectoryMTime(projectDir);
  }

  await writeFileAtomic(metaPath, JSON.stringify(metadata, null, 2));
}

/**
 * Get report stats from the report metadata or data file
 */
async function getReportStats(projectPath: string): Promise<{brands: number, domains: number}> {
  try {
    // Try report-meta.json first (new format)
    const metaPath = path.join(projectPath, 'report-meta.json');
    if (existsSync(metaPath)) {
      const content = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(content);
      return { brands: meta.brands || 0, domains: meta.domains || meta.sources || 0 };
    }

    // Fallback: try old data.js format for backwards compatibility
    const files = await fs.readdir(projectPath);
    const dataFile = files.find(f => f.match(/^\d{4}-\d{2}-\d{2}-data\.js$/));
    if (!dataFile) return { brands: 0, domains: 0 };

    const dataFilePath = path.join(projectPath, dataFile);
    const content = await fs.readFile(dataFilePath, 'utf-8');
    // Match both window.AppData and window.AppDataAggregate formats
    const match = content.match(/window\.AppData[A-Za-z0-9]*\s*=\s*(\{[\s\S]*\});?\s*$/m);
    if (match) {
      const data = new Function(`return ${match[1]}`)();
      // Try totalCounts first (older format), then count brands/links arrays
      const brands = data.totalCounts?.products || data.brands?.length || 0;
      const domains = data.linkDomains?.length || data.totalCounts?.linkDomains || data.totalCounts?.links || data.links?.length || 0;
      return { brands, domains };
    }
  } catch {
    // Report data not available
  }
  return { brands: 0, domains: 0 };
}

/**
 * Generate home page with projects directly
 */
async function generateHomePageWithProjects(outputDir: string): Promise<void> {
  // Projects are now directly under outputDir (no /projects/ subfolder)
  const template = await loadNavigationTemplate('home');
  const customFooterCode = await loadCustomFooterCode('index-projects');
  let projectRows = '';
  let projectCount = 0;
  const projectListItems: string[] = [];

  try {
    const dirs = await fs.readdir(outputDir, { withFileTypes: true });
    // Filter to project directories (exclude index.html, .navigation-meta.json, etc.)
    const projects = dirs
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    projectCount = projects.length;

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const projectPath = path.join(outputDir, project.name);

      // Check if project has a report
      const hasReport = existsSync(path.join(projectPath, DEFAULT_INDEX_FILE));
      if (!hasReport) continue; // Skip projects without reports

      const projectName = getProjectNameFromProjectFolder(project.name);

      // Get report stats
      const reportStats = await getReportStats(projectPath);

      // Generate compact card - link directly to project folder
      const reportLink = `./${project.name}/index.html`;
      const emoji = CATEGORY_EMOJIS[projectName] || DEFAULT_EMOJI;
      projectRows += `
<a href="${reportLink}" class="group block bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600 hover:shadow-lg transition-all duration-200 p-4">
  <div class="flex items-center gap-3">
    <div class="flex-shrink-0 w-10 h-10 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 rounded-lg flex items-center justify-center text-2xl group-hover:scale-110 transition-transform duration-200">
      ${emoji}
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold text-gray-900 dark:text-white text-sm truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">${projectName}</h3>
      <div class="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        <span class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 bg-indigo-400 rounded-full"></span>
          ${reportStats.brands} brands
        </span>
        <span class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 bg-purple-400 rounded-full"></span>
          ${reportStats.domains} link domains
        </span>
      </div>
    </div>
    <svg class="w-4 h-4 text-gray-300 dark:text-gray-600 group-hover:text-indigo-500 group-hover:translate-x-1 transition-all flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
    </svg>
  </div>
</a>`;

      // Build JSON-LD ItemList item with stats
      const hasStats = reportStats.brands > 0 || reportStats.domains > 0;
      projectListItems.push(`{"@type":"ListItem","position":${i + 1},"name":"${projectName.replace(/"/g, '\\"')}","url":"https://aicw.io/ranking/${encodeURIComponent(project.name)}/"${hasStats ? `,"description":"${reportStats.brands} brands tracked, ${reportStats.domains} link domains found"` : ''}}`);
    }
  } catch (err) {
    throw err
  }

  // Handle empty state
  let emptyState = DEFAULT_EMPTY_STATE;
  if (!projectRows) {
    emptyState = await loadNavigationTemplate('empty-state');
  }

  let html = await replaceMacrosInTemplate(template, {
    "{{PROJECT_ROWS}}": projectRows,
    "{{PROJECT_COUNT}}": projectCount.toString(),
    "{{PROJECT_LIST_ITEMS}}": projectListItems.join(','),
    "{{EMPTY_STATE}}": emptyState,
    "{{FOOTER_CUSTOM_CODE}}": customFooterCode
  }, false);

  const outputPath = path.join(outputDir, 'index.html');
  await writeFileAtomic(outputPath, html);
}

/**
 * Generate static navigation for all projects or specific ones
 * @param specificProjects - Optional array of project names to regenerate
 */
export async function generateStaticNavigation(specificProjects?: string[]): Promise<void> {
  const outputDir = path.join(USER_REPORTS_DIR);

  // Create output directory if it doesn't exist
  await fs.mkdir(outputDir, { recursive: true });

  // Check if regeneration is needed (but always regenerate if no index.html exists)
  const indexExists = existsSync(path.join(outputDir, 'index.html'));
  const shouldRegenerate = !indexExists || await needsRegeneration(outputDir, specificProjects);

  if (!shouldRegenerate && !specificProjects) {
    logger.info('Navigation is up to date, skipping regeneration');
    return;
  }

  logger.info('Generating static navigation pages...');

  // Generate home page with projects (projects are directly under outputDir)
  await generateHomePageWithProjects(outputDir);

  // Update metadata
  await updateMetadata(outputDir);

  logger.info('Navigation generation complete');
}

/**
 * Regenerate navigation for a specific project (called after report generation)
 */
export async function generateProjectNavigation(projectName: string): Promise<void> {
  const outputDir = USER_REPORTS_DIR;
  const projectDir = path.join(outputDir, projectName);

  // Regenerate home page (to update project list)
  await generateHomePageWithProjects(outputDir);

  // Update metadata for this project
  const metaPath = path.join(outputDir, NAV_META_FILE);
  if (existsSync(metaPath)) {
    try {
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const metadata: NavigationMetadata = JSON.parse(metaContent);

      metadata.projectTimestamps[projectName] = await getDirectoryMTime(projectDir);
      metadata.lastGenerated = new Date().toISOString();

      await writeFileAtomic(metaPath, JSON.stringify(metadata, null, 2));
    } catch {
      // If error, regenerate full metadata
      await updateMetadata(outputDir);
    }
  } else {
    await updateMetadata(outputDir);
  }
}

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateStaticNavigation().catch(logger.error);
}
