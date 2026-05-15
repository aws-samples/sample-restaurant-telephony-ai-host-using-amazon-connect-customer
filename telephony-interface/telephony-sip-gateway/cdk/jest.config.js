module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Use a separate tsconfig that adds @types/jest to the types
        // list; the main tsconfig excludes the `test/` dir + sets
        // `types: ["node"]` so `tsc -p .` during cdk synth stays
        // free of test artifacts.
        tsconfig: 'tsconfig.jest.json',
      },
    ],
  },
};
