import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(config.logLevel as Level) in order ? (config.logLevel as Level) : 'info'];

type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields): void {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  child(bindings: Fields) {
    return {
      debug: (msg: string, fields?: Fields) => emit('debug', msg, { ...bindings, ...fields }),
      info: (msg: string, fields?: Fields) => emit('info', msg, { ...bindings, ...fields }),
      warn: (msg: string, fields?: Fields) => emit('warn', msg, { ...bindings, ...fields }),
      error: (msg: string, fields?: Fields) => emit('error', msg, { ...bindings, ...fields }),
    };
  },
};
