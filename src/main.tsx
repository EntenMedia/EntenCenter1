import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {installNasApiInterceptor} from './lib/nasClient';
import {applyDeviceDisplayCssVars} from './lib/deviceDisplay';

installNasApiInterceptor();
applyDeviceDisplayCssVars();

createRoot(document.getElementById('root')!).render(<App />);
