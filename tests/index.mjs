/**
 * Entry point used by 
ode --test tests/`.
 *
 * Node.js 24 treats an explicit directory argument for --test as a module path
 * instead of expanding it, so `tests/package.json` maps this directory to this
 * file. Importing every test module keeps 
ode --test tests/` working while
 * 
ode --test` (recursive discovery) and 
pm test` also keep working.
 */
import "./unit/adapters.test.mjs";
import "./unit/validation.test.mjs";
import "./unit/store.test.mjs";
import "./unit/scheduler.test.mjs";
import "./unit/autoreply.test.mjs";
import "./unit/persistence.test.mjs";
import "./unit/threads-reply-chain.test.mjs";
import "./unit/billing.test.mjs";
import "./unit/x-reply.test.mjs";
import "./unit/article-delete.test.mjs";
import "./unit/comments.test.mjs";
import "./unit/comments-adapters.test.mjs";
import "./unit/preview-recurrence.test.mjs";
import "./unit/link-guard.test.mjs";
import "./unit/label.test.mjs";
import "./unit/cloud-auth.test.mjs";
import "./unit/cloud-ledger.test.mjs";
import "./unit/cloud-phase8.test.mjs";
import "./e2e/cloud-mcp.test.mjs";
import "./e2e/cloud-isolation.test.mjs";
import "./e2e/cloud-credentials.test.mjs";
import "./e2e/cloud-finance.test.mjs";
import "./e2e/cloud-tools.test.mjs";
import "./e2e/cloud-admin.test.mjs";
import "./e2e/cloud-pricing.test.mjs";
import "./e2e/stripe-webhook.test.mjs";
import "./e2e/cloud-oauth.test.mjs";
import "./e2e/cloud-free-allowance.test.mjs";
import "./e2e/mcp.test.mjs";
import "./e2e/mcp-article.test.mjs";
import "./e2e/mcp-comments.test.mjs";
import "./e2e/web.test.mjs";
import "./e2e/lock.test.mjs";

