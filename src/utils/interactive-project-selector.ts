import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getUserProjectConfigFile, USER_PROJECTS_DIR } from '../config/user-paths.js';
import readline from 'readline';
import { PipelineCriticalError } from './pipeline-errors.js';
import { logger } from './compact-logger.js';

import { COLORS, createCleanReadline } from './misc-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProjectInfo {
  name: string;
  display_name: string;
  questions_count?: number;
  updated_at?: Date;
  created_at?: Date;
  ai_preset?: string;
  last_capture_date?: string;
  captures_total?: number;
}


function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

async function getProjects(): Promise<ProjectInfo[]> {
  try {
    // Prefer user projects; fallback to dev samples if none
    let baseDir = USER_PROJECTS_DIR;
    let entries: any[] = [];
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true }) as any[];
    } catch (err) {
      throw err
    }

    
    const projects: ProjectInfo[] = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        let display_name = entry.name;
        let questions_count = 0;
        let updated_at: Date | undefined;
        let created_at: Date | undefined;
        let ai_preset: string | undefined;
        let last_capture_date: string | undefined;
        let captures_total = 0;

        const projectConfigPath = getUserProjectConfigFile(entry.name);
        try {
          // Try to read config.json for display name and engines
          const configContent = await fs.readFile(projectConfigPath, 'utf-8');
          const config = JSON.parse(configContent);
          if (config.display_name) {
            display_name = config.display_name;
          }
          if (config.ai_preset) {
            ai_preset = config.ai_preset;
          }
        } catch (e) {
          throw new Error(`Failed to read project config file: ${projectConfigPath}. Error: ${e}`)        
        }
        
        const questionsDir = join(baseDir, entry.name, 'questions');
        try {
          // Count questions
          const questionEntries = await fs.readdir(questionsDir, { withFileTypes: true });
          questions_count = questionEntries.filter(e => e.isDirectory() && e.name.match(/^\d+-/)).length;
          
          // Get last modified date
          const stats = await fs.stat(questionsDir);
          updated_at = stats.mtime;
          
          // Get created date (birthtime)
          created_at = stats.birthtime;
        } catch (e) {
          logger.warn(`No questions directory found for project ${entry.name} in ${questionsDir}. Error: ${e}`);
          //throw new Error(`Failed to read questions directory: ${questionsDir}. Error: ${e}`)
        }
        
        try {
          // Check for latest capture date from answers
          const questionsDir = join(baseDir, entry.name, 'questions');
          const questionEntries = await fs.readdir(questionsDir, { withFileTypes: true });
          
          // Find the first question directory to check for answer dates
          const firstQuestion = questionEntries
            .filter(e => e.isDirectory() && e.name.match(/^\d+-/))
            .sort()[0];
          
          if (firstQuestion) {
            const answersDir = join(questionsDir, firstQuestion.name, 'answers');
            try {
              const answerEntries = await fs.readdir(answersDir, { withFileTypes: true });
              
              // Look for date directories (YYYY-MM-DD format)
              const dateDirs = answerEntries
                .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
                .map(e => e.name)
                .sort()
                .reverse();
              
              if (dateDirs.length > 0) {
                last_capture_date = dateDirs[0];
                captures_total = dateDirs.length;
              }
            } catch (e) {
              // Ignore if no answers directory
            }
          }
        } catch (e) {
          // Ignore if no questions directory
        }
        
        projects.push({
          name: entry.name,
          display_name,
          questions_count,
          updated_at,
          created_at,
          ai_preset,
          last_capture_date,
          captures_total
        });
      }
    }
    
    // Sort alphabetically by display name (case-insensitive)
    projects.sort((a, b) => {
      return a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase());
    });
    
    return projects;
  } catch (error) {
    console.error(colorize(`Failed to read projects directory. Error: ${error}`, 'red'));
    return [];
  }
}

function formatDate(date: Date | string | undefined): string {
  if (!date) return 'N/A';
  if (typeof date === 'string') return date;
  
  const now = new Date();
  const dateObj = new Date(date);
  const diffTime = Math.abs(now.getTime() - dateObj.getTime());
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  
  return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function displayProjects(projects: ProjectInfo[]): void {
  logger.log(colorize('\n📁 Available Projects', 'yellow'));
  logger.log(colorize('═'.repeat(100), 'dim'));
  
  // Header
  logger.log(
    colorize(' # ', 'dim') +
    colorize('Project Name', 'cyan') + ' '.repeat(23) +
    colorize('Questions', 'cyan') + ' '.repeat(3) +
    colorize('Captures', 'cyan') + ' '.repeat(3) +
    colorize('Last Capture', 'cyan') + ' '.repeat(3) +
    colorize('Created', 'cyan')
  );
  logger.log(colorize('─'.repeat(100), 'dim'));
  
  projects.forEach((project, index) => {
    const num = colorize(`[${(index + 1).toString().padStart(1)}]`, 'bright');
    
    // Handle name truncation and padding
    const display_name = project.display_name.substring(0, 30);
    const nameSuffix = project.display_name.length > 30 ? '...' : '';
    const nameWithSuffix = display_name + nameSuffix;
    const namePadding = ' '.repeat(Math.max(0, 35 - nameWithSuffix.length));
    const name = colorize(display_name, 'bright') + nameSuffix + namePadding;
    
    // Format other fields with proper padding
    const questionsStr = project.questions_count ? project.questions_count.toString() : '-';
    const questionsPadding = ' '.repeat(Math.max(0, 12 - questionsStr.length));
    const questions = project.questions_count 
      ? colorize(questionsStr, 'green') + questionsPadding
      : colorize(questionsStr, 'dim') + questionsPadding;      
      
    const capturesStr = project.captures_total ? project.captures_total.toString() : '-';
    const capturesPadding = ' '.repeat(Math.max(0, 7 - capturesStr.length));
    const captures = project.captures_total 
      ? colorize(capturesStr, 'yellow') + capturesPadding
      : colorize(capturesStr, 'dim') + capturesPadding;
      
    const lastCaptureStr = project.last_capture_date ? formatDate(project.last_capture_date) : 'Never';

    const lastCapturePadding = ' '.repeat(Math.max(0, 15 - lastCaptureStr.length));
    const lastCapture = project.last_capture_date
      ? colorize(lastCaptureStr, 'green') + lastCapturePadding
      : colorize(lastCaptureStr, 'dim') + lastCapturePadding;
      
    const created = colorize(formatDate(project.created_at), 'dim');
    
    logger.log(`${num} ${name} ${questions} ${captures} ${lastCapture} ${created}`);
    
    // Show folder name if different from display name
    if (project.name !== project.display_name) {
      logger.info(colorize(`    └─ Folder: ${project.name}`, 'dim'));
    }
    logger.info(colorize(`    └─ AI models ai_preset: ${project.ai_preset || 'N/A'}`, 'dim'));
  });
  
  logger.log(colorize('═'.repeat(100), 'dim'));
  logger.log(colorize(`\n💡 Tip: Type the number to select a project, or press Enter to cancel`, 'dim'));
}

export async function showInteractiveProjectSelector(): Promise<string | null> {
  const projects = await getProjects();
  
  if (projects.length === 0) {
    console.error(colorize('\nNo projects found!', 'red'));
    console.error(colorize('Create a project first using: aicw-ai-mentions new', 'dim'));
    return null;
  }
  
  displayProjects(projects);

  const rl = createCleanReadline();

  return new Promise((resolve) => {
    rl.question(colorize('\nSelect project by number (or press Enter to cancel): ', 'yellow'), (answer) => {
      rl.close();
      process.stdin.pause();
      
      const input = answer.trim();
      if (!input) {
        resolve(null);
        return;
      }
      
      const num = parseInt(input, 10);
      if (isNaN(num) || num < 1 || num > projects.length) {
        console.error(colorize(`\n✗ Invalid selection. Please enter a number between 1 and ${projects.length}`, 'red'));
        resolve(null);
        return;
      }
      
      const selected = projects[num - 1];
      logger.info(colorize(`\n✓ Selected: ${selected.display_name}`, 'green'));
      resolve(selected.name);
    });
  });
}

// Allow running directly for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  showInteractiveProjectSelector().then(project => {
    if (project) {
      logger.info(`\nProject folder name: ${project}`);
    }
  });
}
