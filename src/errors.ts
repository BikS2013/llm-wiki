/** Base class for every error the tool raises deliberately. */
export class LlmWikiError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = new.target.name;
  }
}

/** A required configuration setting is missing or invalid. Never substituted with a default. */
export class ConfigError extends LlmWikiError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** The wiki on disk is not in the expected shape. */
export class WikiLayoutError extends LlmWikiError {}

/** A request to an LLM provider failed or returned an unusable response. */
export class LlmError extends LlmWikiError {
  constructor(message: string) {
    super(message, 3);
  }
}
