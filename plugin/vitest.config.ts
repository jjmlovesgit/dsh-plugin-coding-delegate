import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The unit tests are TypeScript. tests/oracles/ holds node:test suites -- run separately by
    // `npm run test:oracles` -- and vitest's default `**/*.test.*` pattern swept those up and
    // failed with "No test suite found in file". Scoping the include to `.ts` keeps the two
    // runners out of each other's way.
    include: ['tests/**/*.test.ts'],
  },
})
