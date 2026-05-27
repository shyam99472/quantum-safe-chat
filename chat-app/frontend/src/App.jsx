import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { AIProvider } from './context/AIContext';
import Login from './pages/Login';
import Chat from './pages/Chat';

function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <AIProvider>
          <Router>
            <Routes>
              <Route path="/" element={<Login />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </Router>
        </AIProvider>
      </SocketProvider>
    </AuthProvider>
  );
}

export default App;
