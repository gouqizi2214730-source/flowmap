import type { Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';

const MAX_ERRORS = 4;
const MAX_FIELD_CHARS = 6_000;

function bounded(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_FIELD_CHARS)}\n[diagnostic field truncated; see JSON artifact]`;
}

function printError(error: TestError, index: number): void {
  console.error('FLOWMAP_TEST_ERROR', JSON.stringify({
    index,
    message: bounded(error.message),
    stack: bounded(error.stack),
    value: bounded(error.value),
    location: error.location,
  }));
}

/** Diagnostic CLI only: report each failed attempt before the suite ends. */
export default class CiFailureReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' || result.status === 'skipped') return;
    console.error('FLOWMAP_TEST_FAILURE', JSON.stringify({
      title: test.titlePath().join(' > ').slice(0, 512),
      status: result.status,
      retry: result.retry,
      durationMs: result.duration,
      errorCount: result.errors.length,
    }));
    result.errors.slice(0, MAX_ERRORS).forEach(printError);
  }

  onError(error: TestError): void {
    printError(error, 0);
  }
}
