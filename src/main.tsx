import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { SpriteLab } from './components/SpriteLab';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

// `?lab=1` opens the sprite lab instead of the world. Judging a model from a
// screenshot of a village is guesswork; the lab shows every model at one scale.
const isLab = new URLSearchParams(window.location.search).has('lab');

// The lab is not wrapped in StrictMode: its double-invoke mounts the Pixi
// application twice and the first instance is destroyed mid-init, which throws
// inside Pixi's own resize handler.
createRoot(container).render(
  isLab ? (
    <SpriteLab />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);
