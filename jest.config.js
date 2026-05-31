module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  rootDir: '.',
  roots: ['<rootDir>/tests', '<rootDir>/app'],
  collectCoverageFrom: [
    'app/**/*.js',
    '!app/node_modules/**',
  ],
  coverageThreshold: {
    global: { statements: 70 },
  },
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: false,
}
