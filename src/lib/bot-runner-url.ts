/**
 * Shared constant for the bot-runner service URL.
 * Configurable via BOT_RUNNER_URL env var for containerized deployments.
 * Defaults to http://localhost:3001 for same-host deployments.
 */
export const BOT_RUNNER_URL = process.env.BOT_RUNNER_URL || 'http://localhost:3001'
