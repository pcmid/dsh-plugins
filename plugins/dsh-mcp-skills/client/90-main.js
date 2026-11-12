// Registration: dictionaries, the two settings pages, and their nav icons.
// Contracts of the parts:
//   createMcpController(ctx)    → { face, refresh(), dispose() }; component McpSection, icon McpSectionIcon
//   createSkillsController(ctx) → { face, refresh(), dispose() }; component SkillsSection, icon SkillsSectionIcon
// `face.hooks.<name>` stores reach components as `props.use<Name>(selector)`.

const MCP_NAMESPACE = 'mcp-manager';

return {
  inject: ['slots', 'locale', 'connection', 'configForms', 'remote'],
  apply(ctx) {
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'mcp-skills: dictionaries');

    // MCP page: needs the manager and credential Remotes, and appears only while
    // the Host serves the manager's settings namespace.
    ctx.inject(['remote.mcpManager', 'remote.credentials'], (child) => {
      const mcp = createMcpController(child, t);
      child.effect(() => () => { mcp.dispose(); }, 'mcp-skills: MCP controller');
      child.effect(() => {
        const off = [
          child.on('connection/reset', () => { mcp.refresh(); }),
          child.remote.$on('settings/document-updated', (ns) => { if (ns === MCP_NAMESPACE) mcp.refresh('config'); }),
        ];
        return () => { for (const dispose of off) dispose(); };
      }, 'mcp-skills: MCP invalidations');
      child.effect(() => ctx.configForms.whileServed([MCP_NAMESPACE], () => {
        const offSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-servers',
          order: 12,
          label: () => t('mcp_nav'),
          locale: NS,
          inject: () => mcp.face,
        }, McpSection));
        const offIcon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'mcp-servers',
        }, McpSectionIcon));
        return () => { offSection(); offIcon(); };
      }), 'mcp-skills: MCP section');
    });

    // Skills page: served by this bundle's own Host half.
    const skills = createSkillsController(ctx, t);
    ctx.effect(() => () => { skills.dispose(); }, 'mcp-skills: skills controller');
    ctx.effect(() => {
      const off = ctx.on('connection/reset', () => { skills.refresh(); });
      return () => { off(); };
    }, 'mcp-skills: skills invalidations');
    ctx.effect(() => {
      const offSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'skills',
        order: 13,
        label: () => t('sk_nav'),
        locale: NS,
        inject: () => skills.face,
      }, SkillsSection));
      const offIcon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: 'skills',
      }, SkillsSectionIcon));
      return () => { offSection(); offIcon(); };
    }, 'mcp-skills: skills section');
  },
};
