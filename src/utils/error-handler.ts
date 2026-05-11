/**
 * User-friendly error handling system
 */

import { colorize } from './misc-utils.js';
import { AICW_GITHUB_URL } from '../config/constants.js';

export enum ErrorCode {
  // Setup errors
  NO_API_KEY = 'E001',
  INVALID_API_KEY = 'E002',
  API_CONNECTION_FAILED = 'E003',

  // Project errors
  PROJECT_NOT_FOUND = 'E101',
  INVALID_PROJECT_NAME = 'E102',
  PROJECT_ALREADY_EXISTS = 'E103',

  // File system errors
  PERMISSION_DENIED = 'E201',
  DISK_FULL = 'E202',
  FILE_NOT_FOUND = 'E203',

  // Network errors
  RATE_LIMIT_EXCEEDED = 'E301',
  NETWORK_TIMEOUT = 'E302',
  SERVICE_UNAVAILABLE = 'E303',

  // Data errors
  INVALID_INPUT = 'E401',
  CORRUPTED_DATA = 'E402',

  // Unknown
  UNKNOWN_ERROR = 'E999'
}

interface ErrorSolution {
  description: string;
  steps: string[];
  helpUrl?: string;
}

const ERROR_SOLUTIONS: Record<ErrorCode, ErrorSolution> = {
  [ErrorCode.NO_API_KEY]: {
    description: 'No API key found',
    steps: [
      'Run "aicw-ai-mentions setup-api-key" to configure your API key',
      'Or set the OPENROUTER_API_KEY environment variable',
      'Get a free API key at https://openrouter.ai/keys'
    ]
  },
  [ErrorCode.INVALID_API_KEY]: {
    description: 'The API key appears to be invalid',
    steps: [
      'Check that your API key is entered correctly',
      'Run "aicw-ai-mentions setup-api-key" to re-enter your API key',
      'Verify your key at https://openrouter.ai/keys'
    ]
  },
  [ErrorCode.API_CONNECTION_FAILED]: {
    description: 'Could not connect to the AI service',
    steps: [
      'Check your internet connection',
      'Try again in a few moments',
      'Check service status at https://status.openrouter.ai'
    ]
  },
  [ErrorCode.PROJECT_NOT_FOUND]: {
    description: 'The specified project does not exist',
    steps: [
      'Check the project name spelling',
      'Run "aicw-ai-mentions" to see available projects',
      'Create a new project with "aicw-ai-mentions new <ProjectName>"'
    ]
  },
  [ErrorCode.INVALID_PROJECT_NAME]: {
    description: 'The project name contains invalid characters',
    steps: [
      'Use only letters, numbers, spaces, hyphens, and underscores',
      'Avoid special characters like /, \\, @, #, etc.',
      'Keep the name under 100 characters'
    ]
  },
  [ErrorCode.PROJECT_ALREADY_EXISTS]: {
    description: 'A project with this name already exists',
    steps: [
      'Choose a different project name',
      'Or delete the existing project first',
      'Run "aicw-ai-mentions" to see all projects'
    ]
  },
  [ErrorCode.PERMISSION_DENIED]: {
    description: 'Permission denied accessing files',
    steps: [
      'Check that you have write permissions in the current directory',
      'On Windows, try running as Administrator',
      'On Mac/Linux, check folder permissions with "ls -la"'
    ]
  },
  [ErrorCode.DISK_FULL]: {
    description: 'Not enough disk space available',
    steps: [
      'Free up some disk space',
      'Reports can be large - ensure at least 100MB free',
      'Consider cleaning old reports with "aicw-ai-mentions clean"'
    ]
  },
  [ErrorCode.FILE_NOT_FOUND]: {
    description: 'Required file not found',
    steps: [
      'Check that the file path is correct',
      'Ensure the file hasn\'t been moved or deleted',
      'Try running the previous step again'
    ]
  },
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    description: 'Too many requests - rate limit hit',
    steps: [
      'Wait a few minutes before trying again',
      'Consider using fewer AI models to reduce requests',
      'Upgrade to a paid API plan for higher limits'
    ],
    helpUrl: 'https://openrouter.ai/docs/limits'
  },
  [ErrorCode.NETWORK_TIMEOUT]: {
    description: 'The request took too long to complete',
    steps: [
      'Check your internet connection',
      'Try again with fewer questions or models',
      'The service might be experiencing high load'
    ]
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    description: 'The AI service is temporarily unavailable',
    steps: [
      'Wait a few minutes and try again',
      'Check service status at https://status.openrouter.ai',
      'Consider using alternate models if some are down'
    ]
  },
  [ErrorCode.INVALID_INPUT]: {
    description: 'The input data is invalid',
    steps: [
      'Check your input for special characters',
      'Ensure questions are properly formatted',
      'Try simplifying your input'
    ]
  },
  [ErrorCode.CORRUPTED_DATA]: {
    description: 'Project data appears to be corrupted',
    steps: [
      'Try running the previous step again',
      'If the issue persists, create a new project',
      'Contact support if you need to recover data'
    ]
  },
  [ErrorCode.UNKNOWN_ERROR]: {
    description: 'An unexpected error occurred',
    steps: [
      'Try the operation again',
      'Check the error log for more details',
      `Report the issue at ${AICW_GITHUB_URL}/issues`
    ]
  }
};

export class UserFriendlyError extends Error {
  constructor(
    public code: ErrorCode,
    public technicalMessage?: string,
    public context?: Record<string, any>
  ) {
    const solution = ERROR_SOLUTIONS[code];
    super(solution.description);
    this.name = 'UserFriendlyError';
  }

  public display(): void {
    const solution = ERROR_SOLUTIONS[this.code];

    // Error header
    console.error('\n' + colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'red'));
    console.error(colorize(`❌ ${solution.description}`, 'red'));
    console.error(colorize(`   Error Code: ${this.code}`, 'dim'));
    console.error(colorize('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'red'));

    // Solution steps
    console.error('\n' + colorize('💡 How to fix this:', 'yellow'));
    solution.steps.forEach((step, index) => {
      console.error(colorize(`   ${index + 1}. ${step}`, 'cyan'));
    });

    // Help URL if available
    if (solution.helpUrl) {
      console.error('\n' + colorize(`📚 Learn more: ${solution.helpUrl}`, 'dim'));
    }

    // Technical details for debugging (if in debug mode)
    if (process.env.AICW_DEBUG === 'true' && this.technicalMessage) {
      console.error('\n' + colorize('Technical details:', 'dim'));
      console.error(colorize(this.technicalMessage, 'dim'));
    }

    console.error('');
  }
}

/**
 * Convert common errors to user-friendly errors
 */
export function handleError(error: any): UserFriendlyError {
  // API key errors
  if (error.message?.includes('API key') || error.message?.includes('401')) {
    return new UserFriendlyError(ErrorCode.INVALID_API_KEY, error.message);
  }

  // Rate limiting
  if (error.status === 429 || error.message?.includes('rate limit')) {
    return new UserFriendlyError(ErrorCode.RATE_LIMIT_EXCEEDED, error.message);
  }

  // Network errors
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return new UserFriendlyError(ErrorCode.API_CONNECTION_FAILED, error.message);
  }

  if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
    return new UserFriendlyError(ErrorCode.NETWORK_TIMEOUT, error.message);
  }

  // File system errors
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return new UserFriendlyError(ErrorCode.PERMISSION_DENIED, error.message);
  }

  if (error.code === 'ENOSPC') {
    return new UserFriendlyError(ErrorCode.DISK_FULL, error.message);
  }

  if (error.code === 'ENOENT') {
    return new UserFriendlyError(ErrorCode.FILE_NOT_FOUND, error.message);
  }

  // Service errors
  if (error.status >= 500 && error.status < 600) {
    return new UserFriendlyError(ErrorCode.SERVICE_UNAVAILABLE, error.message);
  }

  // Default
  return new UserFriendlyError(ErrorCode.UNKNOWN_ERROR, error.message || error.toString());
}

/**
 * Global error handler wrapper
 */
export function withErrorHandler<T extends (...args: any[]) => any>(
  fn: T,
  context?: string
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error: any) {
      if (error instanceof UserFriendlyError) {
        error.display();
      } else {
        const userError = handleError(error);
        userError.display();
      }

      // Log to error file for debugging
      if (process.env.AICW_DEBUG === 'true') {
        console.error('Stack trace:', error.stack);
      }

      process.exit(1);
    }
  }) as T;
}