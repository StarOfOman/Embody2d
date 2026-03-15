/**
 * Starts both adapter services in a single process:
 *   - Script Runner on :9877
 *   - Health Monitor on :9090
 */
import './script-runner.js'
import './health.js'

console.log('[Adapters] Script runner (:9877) + Health monitor (:9090) started')
