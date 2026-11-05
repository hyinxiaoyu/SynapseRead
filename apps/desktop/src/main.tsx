import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { StudyWorkspace } from '@/features/workspace/StudyWorkspace';

import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <StudyWorkspace />
  </StrictMode>,
);
