import { render } from 'solid-js/web';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('AICurator: #root not found');
render(() => <App />, root);
