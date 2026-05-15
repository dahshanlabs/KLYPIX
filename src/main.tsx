import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from './components/AuthProvider'
import { SessionContextProvider } from './core/sessionContext'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <AuthProvider>
            <SessionContextProvider>
                <App />
            </SessionContextProvider>
        </AuthProvider>
    </React.StrictMode>,
)
