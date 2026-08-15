/** Package-owned invariant companion for the Tool Palette bundle. */
const PACKAGE_NAME = '@lizhecome/dsh-tool-palette';
export const name = 'tool-palette-invariant';
export const inject = ['invariants'];
/**
 * No durable invariant: palette state consists only of reversible Agent-scoped
 * registrations. The package's lifecycle tests cover restriction replacement,
 * delegation inheritance, Agent disposal, and plugin disposal.
 */
const install = () => { };
/** Register package ownership with the Harness invariant registry. */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
