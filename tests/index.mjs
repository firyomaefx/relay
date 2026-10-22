/**
 * Entry point used by `node --test tests/`.
 *
 * Node.js 24 treats an explicit directory argument for --test as a module path
 * instead of expanding it, so `tests/package.json` maps this directory to this
 * file. Importing every test module keeps `node --test tests/` working while
 * `node --test` (recursive discovery) and `npm test` also keep working.
 */
import "./unit/adapters.test.mjs";
import "./unit/validation.test.mjs";
import "./unit/store.test.mjs";
import "./unit/scheduler.test.mjs";
import "./unit/autoreply.test.mjs";
import "./unit/persistence.test.mjs";
import "./e2e/mcp.test.mjs";
import "./e2e/web.test.mjs";
import "./e2e/lock.test.mjs";
