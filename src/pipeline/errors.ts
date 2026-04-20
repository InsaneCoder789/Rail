export class PipelineError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof PipelineError) return err.retryable;
  return false;
}
