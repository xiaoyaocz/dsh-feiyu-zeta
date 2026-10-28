import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ZetaPanel } from '../../src/client/zeta-panel.ts';

createRoot(document.getElementById('root')!).render(createElement(ZetaPanel));
