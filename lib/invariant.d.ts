/** Package-owned invariant companion for the Tool Palette bundle. */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-palette-invariant";
export declare const inject: string[];
/** Register package ownership with the Harness invariant registry. */
export declare const apply: (ctx: Context) => Promise<() => void>;
