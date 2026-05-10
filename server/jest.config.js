/**
 * Jest Configuration for Mailora Server
 */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  verbose: true,
  // Set a reasonable timeout for async operations
  testTimeout: 10000,
  // Setup environment variables for tests
  setupFiles: ["./tests/setup.js"],
};
