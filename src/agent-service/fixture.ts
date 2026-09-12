/* The scenario fixture as a compile-time constant (AC-5 prerequisite).
 * The AgentCore CodeZip bundle contains only the esbuild output (main.js),
 * so a runtime read of fixtures/patch-scenario.json relative to
 * process.cwd() cannot work — the CWD inside the runtime is the bundle
 * root, not the repo (AC-4 residual risk 3). tsconfig has
 * resolveJsonModule, so the JSON is imported directly and esbuild inlines
 * it into the bundle at package time. */
import scenarioJson from '../../fixtures/patch-scenario.json'
import type { Scenario } from '../artifacts/build'

export const patchScenario = scenarioJson as Scenario
