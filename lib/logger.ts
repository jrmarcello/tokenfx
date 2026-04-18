type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Level[] = ['debug', 'info', 'warn', 'error'];

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL;
  if (raw && (ORDER as string[]).includes(raw)) {
    return raw as Level;
  }
  return 'info';
}

function shouldLog(l: Level): boolean {
  return ORDER.indexOf(l) >= ORDER.indexOf(currentLevel());
}

export const log = {
  debug: (...a: unknown[]): void => {
    if (shouldLog('debug')) console.debug(...a);
  },
  info: (...a: unknown[]): void => {
    if (shouldLog('info')) console.info(...a);
  },
  warn: (...a: unknown[]): void => {
    if (shouldLog('warn')) console.warn(...a);
  },
  error: (...a: unknown[]): void => {
    if (shouldLog('error')) console.error(...a);
  },
};
