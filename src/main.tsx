import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from './components/AuthProvider'
import { SessionContextProvider } from './core/sessionContext'
import App from './App'
import './index.css'
// Import for side effect: i18n/strings.ts sets document.documentElement.dir
// + lang from the stored or detected locale at module load. Importing here
// guarantees that runs before the first React render, so RTL layout is
// applied without a flash of LTR for Arabic-locale users.
import './i18n/strings'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <AuthProvider>
            <SessionContextProvider>
                <App />
            </SessionContextProvider>
        </AuthProvider>
    </React.StrictMode>,
)
