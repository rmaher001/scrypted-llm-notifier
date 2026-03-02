module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  verbose: true,
  moduleNameMapper: {
    '^@scrypted/sdk$': '<rootDir>/tests/__mocks__/@scrypted/sdk.ts',
    '^@scrypted/sdk/storage-settings$': '<rootDir>/tests/__mocks__/@scrypted/sdk.ts',
  },
};
