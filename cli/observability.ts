type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

export type StructuredLogLevel = 'error' | 'info' | 'warn';
export type StructuredLogFields = Record<string, JsonValue | undefined>;

export interface StructuredLogger {
  info(event: string, fields?: StructuredLogFields): void;
  warn(event: string, fields?: StructuredLogFields): void;
  error(event: string, fields?: StructuredLogFields): void;
  child(fields: StructuredLogFields): StructuredLogger;
}

export interface ConcurrencyLimiter {
  limit: number;
  run<T>(task: () => Promise<T> | T): Promise<T>;
}

type WriteLine = (line: string) => void;

interface StructuredLogRecord extends StructuredLogFields {
  event: string;
  level: StructuredLogLevel;
  timestamp: string;
}

class QueueingConcurrencyLimiter implements ConcurrencyLimiter {
  readonly #queue: Array<() => void> = [];
  #activeCount = 0;

  constructor(readonly limit: number) {}

  async run<T>(task: () => Promise<T> | T): Promise<T> {
    await this.#acquire();

    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#activeCount < this.limit) {
      this.#activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
    this.#activeCount += 1;
  }

  #release(): void {
    this.#activeCount -= 1;
    this.#queue.shift()?.();
  }
}

class JsonStructuredLogger implements StructuredLogger {
  constructor(
    private readonly writeLine: WriteLine,
    private readonly baseFields: StructuredLogFields = {},
  ) {}

  info(event: string, fields: StructuredLogFields = {}): void {
    this.#write('info', event, fields);
  }

  warn(event: string, fields: StructuredLogFields = {}): void {
    this.#write('warn', event, fields);
  }

  error(event: string, fields: StructuredLogFields = {}): void {
    this.#write('error', event, fields);
  }

  child(fields: StructuredLogFields): StructuredLogger {
    return new JsonStructuredLogger(this.writeLine, {
      ...this.baseFields,
      ...fields,
    });
  }

  #write(level: StructuredLogLevel, event: string, fields: StructuredLogFields): void {
    const payload: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...this.baseFields,
      ...fields,
    };
    this.writeLine(JSON.stringify(payload));
  }
}

export function createStructuredLogger(
  writeLine: WriteLine = (line) => {
    console.log(line);
  },
): StructuredLogger {
  return new JsonStructuredLogger(writeLine);
}

export function createNoopLogger(): StructuredLogger {
  return createStructuredLogger(() => {});
}

export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Expected concurrency limit to be a positive integer. Received: ${limit}`);
  }

  return new QueueingConcurrencyLimiter(limit);
}

export function resolveConcurrencySetting(
  explicitValue: number | undefined,
  envName: string,
  fallback: number,
): number {
  if (explicitValue !== undefined) {
    return validateConcurrencyValue(explicitValue, 'explicit concurrency value');
  }

  const envValue = process.env[envName];
  if (!envValue) {
    return validateConcurrencyValue(fallback, 'default concurrency value');
  }

  return validateConcurrencyValue(Number.parseInt(envValue, 10), `environment variable ${envName}`);
}

export function serializeError(error: unknown): StructuredLogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
    };
  }

  if (typeof error === 'string') {
    return { errorMessage: error };
  }

  return { errorMessage: 'Unknown error' };
}

function validateConcurrencyValue(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Expected ${source} to be a positive integer. Received: ${value}`);
  }

  return value;
}
