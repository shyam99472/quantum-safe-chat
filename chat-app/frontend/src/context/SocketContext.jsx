import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { io } from 'socket.io-client';
import { AuthContext } from './AuthContext';

export const SocketContext = createContext();

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

export const SocketProvider = ({ children }) => {
    const { user } = useContext(AuthContext);

    const socket = useMemo(() => {
        if (!user) {
            return null;
        }

        const token = localStorage.getItem('chatToken');
        return io(SOCKET_URL, {
            auth: { token }
        });
    }, [user]);

    useEffect(() => {
        if (!socket || !user) {
            return undefined;
        }

        const handleConnect = () => {
            socket.emit('user_connected', user._id);
        };

        socket.on('connect', handleConnect);

        return () => {
            socket.off('connect', handleConnect);
            socket.close();
        };
    }, [socket, user]);

    return (
        <SocketContext.Provider value={{ socket }}>
            {children}
        </SocketContext.Provider>
    );
};
