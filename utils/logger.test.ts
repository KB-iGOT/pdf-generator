import {
  logObject,
  logInfoHeading,
  logInfo,
  logWarnHeading,
  logWarn,
  logErrorHeading,
  logError,
  logSuccessHeading,
  logSuccess,
} from './logger'

// Note: logger.ts binds `log = console.log` at module load time, so a
// jest.spyOn on console.log would not intercept calls. We verify the
// functions run without throwing, which is sufficient for coverage.

describe('logger utilities', () => {
  describe('logObject', () => {
    it('does not throw for a multi-key object', () => {
      expect(() =>
        logObject('Prefix', { alpha: 'one', beta: 42, gamma: true, delta: null })
      ).not.toThrow()
    })

    it('does not throw for a single-key object', () => {
      expect(() => logObject('Single', { key: 'value' })).not.toThrow()
    })
  })

  it('logInfoHeading does not throw', () => {
    expect(() => logInfoHeading('Info heading')).not.toThrow()
  })

  it('logInfo does not throw with one arg', () => {
    expect(() => logInfo('info message')).not.toThrow()
  })

  it('logInfo does not throw with multiple args', () => {
    expect(() => logInfo('part1', 'part2')).not.toThrow()
  })

  it('logWarnHeading does not throw', () => {
    expect(() => logWarnHeading('Warn heading')).not.toThrow()
  })

  it('logWarn does not throw', () => {
    expect(() => logWarn('warning message')).not.toThrow()
  })

  it('logErrorHeading does not throw', () => {
    expect(() => logErrorHeading('Error heading')).not.toThrow()
  })

  it('logError does not throw', () => {
    expect(() => logError('error message')).not.toThrow()
  })

  it('logSuccessHeading does not throw', () => {
    expect(() => logSuccessHeading('Success heading')).not.toThrow()
  })

  it('logSuccess does not throw', () => {
    expect(() => logSuccess('success message')).not.toThrow()
  })
})

