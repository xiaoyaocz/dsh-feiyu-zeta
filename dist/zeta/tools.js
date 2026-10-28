/** Registration adapter only: dispatch, validation and cancellation remain DSH-owned. */
export function registerZetaTool(ctx, definition) {
    ctx.tools.register({ ...definition, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] } });
}
//# sourceMappingURL=tools.js.map