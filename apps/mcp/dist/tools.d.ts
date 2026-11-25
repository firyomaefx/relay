import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlatformId, PostDraft, RelayService } from "@relay/core";
export interface ToolContext {
    relay: RelayService;
    /** Absolute path of the built server entry, used to render client config snippets. */
    entryPath?: string;
    /** Cloud-only hooks. Existing owner contexts omit them. */
    beforePost?: (draft: PostDraft) => Promise<unknown>;
    afterPost?: (hold: unknown, result: Awaited<ReturnType<RelayService["createPost"]>>) => Promise<void>;
    afterPostError?: (hold: unknown) => Promise<void>;
    afterCancel?: (jobId: string) => Promise<void>;
    /** Cloud-only: price a draft without reserving or publishing. */
    quotePost?: (draft: PostDraft) => unknown;
    /** Cloud-only: check if a quote can be published with current wallet. */
    checkEligibility?: (draft: PostDraft) => {
        eligible: boolean;
        reason?: string;
        paidRequired: number;
        available: number;
        freeRemaining: number;
    } | null;
    /** Cloud-only: enforce account tier/limit before OAuth. */
    beforeConnect?: (platform: PlatformId, options: {
        accountId?: string;
        label?: string;
    }) => Promise<{
        accountId?: string;
    } | void>;
}
export declare function registerTools(server: McpServer, context: ToolContext): void;
