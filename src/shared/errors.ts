export class NavigationError extends Error {
  constructor(public url: string, message: string, public override cause?: unknown) {
    super(`NavigationError(${url}): ${message}`);
    this.name = 'NavigationError';
  }
}

export class SelectorNotFoundError extends Error {
  constructor(public selector: string, public url: string) {
    super(`SelectorNotFoundError(${selector}) at ${url}`);
    this.name = 'SelectorNotFoundError';
  }
}

export class ParseError extends Error {
  constructor(public field: string, message: string) {
    super(`ParseError(${field}): ${message}`);
    this.name = 'ParseError';
  }
}

export class BGApiError extends Error {
  constructor(public status: number, public endpoint: string, message: string) {
    super(`BGApiError(${status} ${endpoint}): ${message}`);
    this.name = 'BGApiError';
  }
}
