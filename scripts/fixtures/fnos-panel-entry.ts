import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BindPanelBody } from '../../src/client/bind-page.ts';
import { ConfigPanel } from '../../src/client/config-panel.ts';
import { ZetaPanel } from '../../src/client/zeta-panel.ts';

createRoot(document.getElementById('root')!).render(createElement('main', null,
  createElement(BindPanelBody), createElement(ConfigPanel), createElement(ZetaPanel)));
