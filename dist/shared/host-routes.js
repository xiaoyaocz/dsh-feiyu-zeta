/** Custom Web routes must explicitly use the Host's admission and owner policy. */
export function ownerRoutes(ctx, server) {
    return { register: route => server.register({ ...route, handler: async (req, res) => {
                const admission = ctx.connection.admit(req);
                const status = 'rejection' in admission ? admission.rejection : admission.peer.principal.kind === 'owner' ? undefined : 403;
                if (status) {
                    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: status === 401 ? '请从已登录的DSH界面操作' : '当前身份无权管理dsh-feiyu-zeta' }));
                    return;
                }
                await route.handler(req, res);
            } }) };
}
//# sourceMappingURL=host-routes.js.map