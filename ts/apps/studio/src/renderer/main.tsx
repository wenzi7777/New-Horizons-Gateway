import '@nhgw/ui-tokens/tokens.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { getApi, platformOf } from './api';
import { App } from './App';
import { StudioProvider } from './state/studio';

const { api, source } = getApi();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StudioProvider api={api} source={source} platform={platformOf(navigator.userAgent)}>
        <App />
      </StudioProvider>
    </StrictMode>,
  );
}
