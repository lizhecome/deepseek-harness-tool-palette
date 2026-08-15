/** Progressive tool discovery and per-agent unlocking for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-palette";
export declare const inject: string[];
/** The discovery tool remains visible inside every palette. */
export declare const TOOL_SEARCH_NAME = "tool_search";
/** Deployment defaults and output bounds for progressive tool discovery. */
export interface Config {
    /** Exact global tool names that stay visible before any search. */
    alwaysVisible?: string[];
    /** Maximum matches returned and unlocked by one search. */
    maxResults?: number;
    /** Maximum accepted search-query length after trimming. */
    maxQueryChars?: number;
    /** Maximum characters returned from each matched tool description. */
    descriptionMaxChars?: number;
}
export declare const Config: z<Config>;
/** Install progressive discovery and its per-Agent restriction lifecycle. */
export declare function apply(ctx: Context, config: Config): void;
