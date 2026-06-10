export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export class Logger {
  private level: LogLevel = 'silent';
  private prefix: string;

  constructor(prefix: string, level: LogLevel = 'silent') {
    this.prefix = prefix;
    this.level = level;
  }

  public setLevel(level: LogLevel) {
    this.level = level;
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public error(message: string, ...args: unknown[]) {
    if (this.shouldLog('error')) {
      console.error(`[${this.prefix}] ${message}`, ...args);
    }
  }

  public warn(message: string, ...args: unknown[]) {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.prefix}] ${message}`, ...args);
    }
  }

  public info(message: string, ...args: unknown[]) {
    if (this.shouldLog('info')) {
      console.info(`[${this.prefix}] ${message}`, ...args);
    }
  }

  public debug(message: string, ...args: unknown[]) {
    if (this.shouldLog('debug')) {
      console.log(`[${this.prefix}] ${message}`, ...args);
    }
  }

  public createChild(subPrefix: string): Logger {
    return new Logger(`${this.prefix}:${subPrefix}`, this.level);
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    if (this.level === 'silent') return false;
    if (this.level === 'error') return messageLevel === 'error';
    if (this.level === 'warn') return messageLevel === 'error' || messageLevel === 'warn';
    if (this.level === 'info') return messageLevel === 'error' || messageLevel === 'warn' || messageLevel === 'info';
    if (this.level === 'debug') return true;
    return false;
  }
}
