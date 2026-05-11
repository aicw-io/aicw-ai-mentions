export interface ProjectNewArgs {
  topic?: string;
  questionCount?: number;
}

export function parseProjectNewArgs(args: string[]): ProjectNewArgs {
  const result: ProjectNewArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]?.trim();
    if (!arg) continue;

    if (arg === '--questions' || arg === '-q') {
      const rawCount = args[i + 1];
      if (rawCount) {
        result.questionCount = Number.parseInt(rawCount, 10);
        i++;
      }
      continue;
    }

    if (arg.startsWith('--questions=')) {
      result.questionCount = Number.parseInt(arg.slice('--questions='.length), 10);
      continue;
    }

    if (arg.startsWith('-')) {
      continue;
    }

    if (!result.topic) {
      result.topic = arg;
    }
  }

  return result;
}

export function resolveQuestionCount(
  requestedCount: number | undefined,
  defaultCount: number,
  maxQuestions: number
): number {
  if (requestedCount === undefined) {
    return defaultCount;
  }

  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > maxQuestions) {
    throw new Error(`Question count must be a number between 1 and ${maxQuestions}.`);
  }

  return requestedCount;
}
