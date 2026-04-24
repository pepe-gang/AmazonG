import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Order matters: Tailwind v4 + design tokens load first, then any legacy
// vanilla CSS rules in `styles.css` come after so existing App.tsx layout
// keeps working until the screen-level rewrites land in later phases.
import './index.css';
import './styles.css';

// Bestie's design tokens live under `.dark { ... }`. Pin the class
// unconditionally — AmazonG is dark-only. Doing this before React mounts
// avoids a flash of light-theme defaults.
document.documentElement.classList.add('dark');

const el = document.getElementById('root');
if (!el) throw new Error('root element missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
