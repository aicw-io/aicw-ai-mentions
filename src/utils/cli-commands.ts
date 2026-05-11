export const COMMAND_ALIASES: Record<string, string> = {
  u: 'update',
  '-v': 'version',
  '--version': 'version',
  scan: 'new',
  serve: 'report-serve'
};

export function resolveCommandAlias(command: string): string {
  return COMMAND_ALIASES[command] || command;
}

export function getTargetDateArg(args: string[]): string | undefined {
  const dateIndex = args.indexOf('--date');
  return dateIndex !== -1 && args[dateIndex + 1] ? args[dateIndex + 1] : undefined;
}
