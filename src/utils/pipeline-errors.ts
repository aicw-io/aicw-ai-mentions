/**
 * Pipeline Errors - Custom error classes for pipeline execution control
 *
 * This module defines custom error types that control pipeline execution flow.
 * Critical errors stop the pipeline, while other errors allow graceful degradation.
 */

/**
 * Custom error class for critical pipeline errors that should stop execution.
 * When thrown, these errors should bubble up to the pipeline executor to halt the pipeline.
 *
 * Use instanceof PipelineCriticalError to detect these errors in catch blocks.
 */
export class PipelineCriticalError extends Error {
  public name = 'PipelineCriticalError';

  constructor(
    message: string,
    public readonly stepName: string,
    public readonly questionFolder?: string
  ) {
    super(message);

    // Maintains proper stack trace in V8 engines (Chrome, Node)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PipelineCriticalError);
    }
  }
}

export class MissingConfigError extends PipelineCriticalError {

  constructor(message: string, stepName: string) {
    super(message, stepName);
    this.name = 'MissingConfigError';
  }
}

/**
 * Helper function to create a critical error for missing input files.
 *
 * @param questionFolder - The question folder being processed
 * @param filePath - The expected file path that doesn't exist
 * @param stepName - The pipeline step name that encountered the error
 */
export function createMissingFileError(
  questionFolder: string,
  filePath: string,
  stepName: string
): PipelineCriticalError {
  return new PipelineCriticalError(
    `Required data file not found for ${questionFolder} at ${filePath}. Previous pipeline step may have failed.`,
    stepName,
    questionFolder
  );
}

/**
 * Helper function to create a critical error for missing required data fields.
 *
 * @param questionFolder - The question folder being processed
 * @param dataType - The type of data that's missing (e.g., "Links", "SourceDomains")
 * @param previousStep - The step that should have created this data
 * @param stepName - The pipeline step name that encountered the error
 */
export function createMissingDataError(
  questionFolder: string,
  dataType: string,
  previousStep: string,
  stepName: string
): PipelineCriticalError {
  return new PipelineCriticalError(
    `${dataType} not found for ${questionFolder}. ${previousStep} step may have failed.`,
    stepName,
    questionFolder
  );
}
