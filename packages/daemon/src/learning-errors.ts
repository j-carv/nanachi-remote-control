/** Only explicitly classified failures may surface in learning notices or catalogs. */
export class LearningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningError';
  }
}

export function learningErrorMessage(error: unknown): string {
  return error instanceof LearningError
    ? error.message.slice(0, 500)
    : 'Automatic learning failed. Check reviewer capability, model, credentials, and connection settings.';
}
