export type VckbErrorCode = 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED';

export class VckbError extends Error {
  constructor(
    public readonly code: VckbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VckbError';
  }
}
