require('dotenv').config({ path: require('path').join(__dirname, '.env.multiplayer') });

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { registerMultiplayer } = require('./multiplayer-service');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

const PORT = process.env.MULTIPLAYER_PORT || process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'lexy-secret-key-2024';

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

function authenticateSocket(socket, next) {
    try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
        if (!token) {
            return next(new Error('Authentication required'));
        }

        const payload = jwt.verify(token, JWT_SECRET);
        socket.data.userId = Number(payload.id);
        socket.data.username = payload.username;
        return next();
    } catch (error) {
        return next(new Error('Invalid token'));
    }
}

io.use(authenticateSocket);
registerMultiplayer({ app, io }).catch((error) => {
    console.error('Failed to register multiplayer routes:', error);
});

server.listen(PORT, () => {
    console.log(`Multiplayer service running on http://localhost:${PORT}`);
});

