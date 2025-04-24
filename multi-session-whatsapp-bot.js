import dotenv from 'dotenv';
import { makeWASocket, fetchLatestBaileysVersion, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Handler, Callupdate, GroupUpdate } from './data/index.js';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import config from './config.cjs';
import autoreact from './lib/autoreact.cjs';
import bodyParser from 'body-parser';

dotenv.config();

const { emojis, doReact } = autoreact;

const prefix = process.env.PREFIX || config.PREFIX;
const app = express();
const PORT = process.env.PORT || 3000;
const MAIN_LOGGER = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` });
const logger = MAIN_LOGGER.child({});
logger.level = "trace";

// Middleware setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);
const sessionsBaseDir = path.join(__dirname, "sessions");

// Create sessions directory if it doesn't exist
if (!fs.existsSync(sessionsBaseDir)) {
    fs.mkdirSync(sessionsBaseDir, { recursive: true });
}

// Store active bot instances
const activeBots = new Map();

// Session management functions
async function downloadSessionData(sessionId, sessionDirectory) {
    try {
        console.log(`🤖 Processing session ID for ${sessionDirectory}...`);
        let sessionData;
        
        if (sessionId.startsWith('http')) {
            const response = await axios.get(sessionId);
            sessionData = response.data;
        } else {
            sessionData = sessionId;
        }
        
        if (!sessionData.startsWith('EF-PRIME;;;')) {
            console.error(`❌ Invalid session data format for ${sessionDirectory}! Session data must start with 'EF-PRIME;;;'`);
            return false;
        }
        
        const base64Data = sessionData.split('EF-PRIME;;;')[1].trim();
        const decodedData = Buffer.from(base64Data, 'base64');
        const credsPath = path.join(sessionDirectory, "creds.json");
        await fs.promises.writeFile(credsPath, decodedData);
        console.log(`✅ Session data successfully processed and saved for ${sessionDirectory}!`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to process session data for ${sessionDirectory}:`, error.message);
        return false;
    }
}

async function startBot(sessionName, sessionId = null, useQR = false) {
    try {
        const sessionDir = path.join(sessionsBaseDir, sessionName);
        
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        // If a session ID is provided, try to download it
        if (sessionId) {
            const downloaded = await downloadSessionData(sessionId, sessionDir);
            if (!downloaded && !useQR) {
                console.error(`Failed to download session data for ${sessionName}`);
                return false;
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`EF-PRIME MD ${sessionName} using WA v${version.join('.')}, isLatest: ${isLatest}`);

        let initialConnection = true;
        
        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            printQRInTerminal: useQR,
            browser: ["PRIME-MD", "safari", "3.3"],
            auth: state,
            getMessage: async (key) => {
                return { conversation: "EF-PRIME-MD CONNECTED SUCCESSFULLY" };
            }
        });

        sock.ev.on("connection.update", update => {
            const { connection, lastDisconnect, qr } = update;
            
            if (connection === "close") {
                if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    startBot(sessionName);
                } else {
                    console.log(chalk.red(`🔴 Bot ${sessionName} logged out`));
                    activeBots.delete(sessionName);
                }
            } else if (connection === "open") {
                if (initialConnection) {
                    console.log(chalk.green(`Connection established for ${sessionName} 🤖🟢`));
                    sock.sendMessage(sock.user.id, {
                        image: { url: "https://files.catbox.moe/2k0b1s.jpg" },
                        caption: `*Thanks for using EF-PRIME-MD*\n\nSession Name: ${sessionName}\n\nStay update with new cool features and kindly follow our channel \n\nYour configured prime prefix = ${prefix} \n\nhttps://whatsapp.com/channel/0029Vb5xaN6Chq6HbdmixE44\n\nThank you for your support 🫶\n\nMade with love by \n\n> Frankdevtechinc🇲🇼`
                    });
                    initialConnection = false;
                    
                    // Save the active session
                    activeBots.set(sessionName, {
                        sock,
                        jid: sock.user.id,
                        status: 'connected'
                    });
                } else {
                    console.log(chalk.blue(`♻️ Connection reestablished for ${sessionName} after restart.`));
                }
            }
            
            // If there's a QR code and we're using QR authentication
            if (qr && useQR) {
                // We update the bot status with QR code
                if (activeBots.has(sessionName)) {
                    const botInfo = activeBots.get(sessionName);
                    botInfo.qrCode = qr;
                    botInfo.status = 'waiting_for_scan';
                    activeBots.set(sessionName, botInfo);
                } else {
                    activeBots.set(sessionName, {
                        sock,
                        qrCode: qr,
                        status: 'waiting_for_scan'
                    });
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("messages.upsert", async m => await Handler(m, sock, logger));
        sock.ev.on("call", async m => await Callupdate(m, sock));
        sock.ev.on("group-participants.update", async m => await GroupUpdate(sock, m));

        if (config.MODE === "public") {
            sock.public = true;
        } else if (config.MODE === "private") {
            sock.public = false;
        }

        sock.ev.on("messages.upsert", async messages => {
            try {
                const msg = messages.messages[0];
                if (!msg.key.fromMe && config.AUTO_REACT) {
                    if (msg.message) {
                        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await doReact(emoji, msg, sock);
                    }
                }
            } catch (error) {
                console.error(`Error during auto reaction for ${sessionName}:`, error);
            }
        });

        sock.ev.on("messages.upsert", async messages => {
            try {
                const msg = messages.messages[0];
                const jid = msg.key.participant || msg.key.remoteJid;

                if (!msg || !msg.message) return;
                if (msg.key.fromMe) return;
                if (
                    msg.message?.protocolMessage ||
                    msg.message?.ephemeralMessage ||
                    msg.message?.reactionMessage
                ) return;

                if (
                    msg.key &&
                    msg.key.remoteJid === "status@broadcast" &&
                    config.AUTO_STATUS_SEEN
                ) {
                    await sock.readMessages([msg.key]);
                    if (config.AUTO_STATUS_REPLY) {
                        const statusReplyMsg = config.STATUS_READ_MSG || "STATUS VIEWED BY PRIME MD ";
                        await sock.sendMessage(jid, { text: statusReplyMsg }, { quoted: msg });
                    }
                }
            } catch (error) {
                console.error(`Error handling messages.upsert event for ${sessionName}:`, error);
            }
        });

        return true;
    } catch (error) {
        console.error(`Critical Error in ${sessionName}:`, error);
        return false;
    }
}

// Initialize existing sessions
async function initExistingSessions() {
    try {
        if (fs.existsSync(sessionsBaseDir)) {
            const sessions = fs.readdirSync(sessionsBaseDir);
            console.log(chalk.blue(`🔍 Found ${sessions.length} existing sessions`));
            
            for (const sessionName of sessions) {
                const sessionDir = path.join(sessionsBaseDir, sessionName);
                const credsPath = path.join(sessionDir, "creds.json");
                
                if (fs.existsSync(credsPath)) {
                    console.log(chalk.yellow(`🔄 Initializing existing session: ${sessionName}`));
                    const success = await startBot(sessionName);
                    if (success) {
                        console.log(chalk.green(`✅ Successfully initialized session: ${sessionName}`));
                    } else {
                        console.error(chalk.red(`❌ Failed to initialize session: ${sessionName}`));
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error initializing existing sessions:", error);
    }
}

// Create HTML pages for the web interface
const indexHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EF-PRIME MD - Session Manager</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body {
            background-color: #f5f5f5;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        .navbar {
            background-color: #1a1a2e;
        }
        .card {
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            margin-bottom: 20px;
            border: none;
            border-radius: 10px;
        }
        .card-header {
            background-color: #0f3460;
            color: white;
            border-radius: 10px 10px 0 0 !important;
        }
        .btn-primary {
            background-color: #16213e;
            border-color: #16213e;
        }
        .btn-primary:hover {
            background-color: #0f3460;
            border-color: #0f3460;
        }
        .btn-danger {
            background-color: #e94560;
            border-color: #e94560;
        }
        .btn-danger:hover {
            background-color: #c73e56;
            border-color: #c73e56;
        }
        .session-title {
            font-weight: bold;
            color: #16213e;
        }
        .status-connected {
            color: #28a745;
        }
        .status-disconnected {
            color: #dc3545;
        }
        .status-waiting {
            color: #ffc107;
        }
        #qrCodeModal img {
            width: 100%;
        }
    </style>
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark">
        <div class="container">
            <a class="navbar-brand" href="#">
                <img src="https://files.catbox.moe/2k0b1s.jpg" alt="Logo" width="30" height="30" class="d-inline-block align-text-top rounded-circle me-2">
                EF-PRIME MD Session Manager
            </a>
        </div>
    </nav>

    <div class="container mt-4">
        <div class="row">
            <div class="col-md-12">
                <div class="card">
                    <div class="card-header">
                        <h5>Add New Session</h5>
                    </div>
                    <div class="card-body">
                        <form id="addSessionForm">
                            <div class="mb-3">
                                <label for="sessionName" class="form-label">Session Name</label>
                                <input type="text" class="form-control" id="sessionName" required placeholder="Enter a unique session name">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Authentication Method</label>
                                <div class="form-check">
                                    <input class="form-check-input" type="radio" name="authMethod" id="useSessionId" value="sessionId" checked>
                                    <label class="form-check-label" for="useSessionId">
                                        Session ID
                                    </label>
                                </div>
                                <div class="form-check">
                                    <input class="form-check-input" type="radio" name="authMethod" id="useQR" value="qr">
                                    <label class="form-check-label" for="useQR">
                                        QR Code
                                    </label>
                                </div>
                            </div>
                            <div class="mb-3" id="sessionIdField">
                                <label for="sessionId" class="form-label">Session ID</label>
                                <textarea class="form-control" id="sessionId" rows="3" placeholder="Enter session ID or URL"></textarea>
                                <div class="form-text">Session ID should start with 'EF-PRIME;;;'</div>
                            </div>
                            <button type="submit" class="btn btn-primary">Add Session</button>
                        </form>
                    </div>
                </div>
            </div>
        </div>

        <div class="row mt-4">
            <div class="col-md-12">
                <div class="card">
                    <div class="card-header">
                        <h5>Active Sessions</h5>
                    </div>
                    <div class="card-body">
                        <div id="activeSessions" class="row">
                            <!-- Sessions will be loaded here -->
                            <div class="text-center py-4" id="noSessionsMessage">
                                <p class="text-muted">No active sessions found.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- QR Code Modal -->
    <div class="modal fade" id="qrCodeModal" tabindex="-1" aria-labelledby="qrCodeModalLabel" aria-hidden="true">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="qrCodeModalLabel">Scan QR Code</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                    <div class="text-center">
                        <img id="qrCodeImage" src="" alt="QR Code">
                        <p class="mt-3">Scan this QR code with your WhatsApp to connect the session.</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        // Toggle session ID field based on authentication method
        document.querySelectorAll('input[name="authMethod"]').forEach(radio => {
            radio.addEventListener('change', function() {
                const sessionIdField = document.getElementById('sessionIdField');
                if (this.value === 'sessionId') {
                    sessionIdField.style.display = 'block';
                } else {
                    sessionIdField.style.display = 'none';
                }
            });
        });

        // Form submission
        document.getElementById('addSessionForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const sessionName = document.getElementById('sessionName').value;
            const authMethod = document.querySelector('input[name="authMethod"]:checked').value;
            const sessionId = document.getElementById('sessionId').value;
            
            const data = {
                sessionName: sessionName,
                authMethod: authMethod
            };
            
            if (authMethod === 'sessionId') {
                data.sessionId = sessionId;
            }
            
            try {
                const response = await fetch('/api/sessions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    if (result.qrCode) {
                        // Show QR code modal
                        const qrCodeImage = document.getElementById('qrCodeImage');
                        qrCodeImage.src = result.qrCode;
                        
                        const qrModal = new bootstrap.Modal(document.getElementById('qrCodeModal'));
                        qrModal.show();
                    }
                    
                    alert('Session added successfully!');
                    document.getElementById('sessionName').value = '';
                    document.getElementById('sessionId').value = '';
                    loadSessions();
                } else {
                    alert(result.message || 'Failed to add session');
                }
            } catch (error) {
                console.error('Error:', error);
                alert('An error occurred. Please try again.');
            }
        });

        // Load active sessions
        async function loadSessions() {
            try {
                const response = await fetch('/api/sessions');
                const sessions = await response.json();
                
                const sessionsContainer = document.getElementById('activeSessions');
                const noSessionsMessage = document.getElementById('noSessionsMessage');
                
                if (sessions.length === 0) {
                    noSessionsMessage.style.display = 'block';
                    sessionsContainer.innerHTML = '';
                    sessionsContainer.appendChild(noSessionsMessage);
                } else {
                    noSessionsMessage.style.display = 'none';
                    
                    let sessionsHTML = '';
                    sessions.forEach(session => {
                        let statusClass = 'status-waiting';
                        let statusText = 'Waiting for connection';
                        
                        if (session.status === 'connected') {
                            statusClass = 'status-connected';
                            statusText = 'Connected';
                        } else if (session.status === 'disconnected') {
                            statusClass = 'status-disconnected';
                            statusText = 'Disconnected';
                        } else if (session.status === 'waiting_for_scan') {
                            statusClass = 'status-waiting';
                            statusText = 'Waiting for QR scan';
                        }
                        
                        sessionsHTML += `
                        <div class="col-md-4">
                            <div class="card">
                                <div class="card-body">
                                    <h5 class="session-title">${session.name}</h5>
                                    <p class="mb-2">Status: <span class="${statusClass}">${statusText}</span></p>
                                    ${session.jid ? `<p class="mb-2 small">JID: ${session.jid}</p>` : ''}
                                    <div class="d-flex justify-content-between mt-3">
                                        ${session.status === 'waiting_for_scan' ? 
                                        `<button class="btn btn-sm btn-warning show-qr" data-session="${session.name}">Show QR</button>` : 
                                        ''}
                                        <button class="btn btn-sm btn-danger delete-session" data-session="${session.name}">Delete</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        `;
                    });
                    
                    sessionsContainer.innerHTML = sessionsHTML;
                    
                    // Add event listeners to buttons
                    document.querySelectorAll('.show-qr').forEach(button => {
                        button.addEventListener('click', function() {
                            const sessionName = this.getAttribute('data-session');
                            showQRCode(sessionName);
                        });
                    });
                    
                    document.querySelectorAll('.delete-session').forEach(button => {
                        button.addEventListener('click', function() {
                            const sessionName = this.getAttribute('data-session');
                            deleteSession(sessionName);
                        });
                    });
                }
            } catch (error) {
                console.error('Error loading sessions:', error);
            }
        }

        // Show QR code for a session
        async function showQRCode(sessionName) {
            try {
                const response = await fetch(`/api/sessions/${sessionName}/qr`);
                const result = await response.json();
                
                if (result.success && result.qrCode) {
                    const qrCodeImage = document.getElementById('qrCodeImage');
                    qrCodeImage.src = result.qrCode;
                    
                    const qrModal = new bootstrap.Modal(document.getElementById('qrCodeModal'));
                    qrModal.show();
                } else {
                    alert(result.message || 'QR code not available');
                }
            } catch (error) {
                console.error('Error showing QR code:', error);
                alert('An error occurred. Please try again.');
            }
        }

        // Delete a session
        async function deleteSession(sessionName) {
            if (confirm(`Are you sure you want to delete the session '${sessionName}'?`)) {
                try {
                    const response = await fetch(`/api/sessions/${sessionName}`, {
                        method: 'DELETE'
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('Session deleted successfully!');
                        loadSessions();
                    } else {
                        alert(result.message || 'Failed to delete session');
                    }
                } catch (error) {
                    console.error('Error deleting session:', error);
                    alert('An error occurred. Please try again.');
                }
            }
        }

        // Load sessions on page load
        document.addEventListener('DOMContentLoaded', function() {
            loadSessions();
            
            // Refresh sessions every 10 seconds
            setInterval(loadSessions, 10000);
        });
    </script>
</body>
</html>
`;

// Create public directory for static files
if (!fs.existsSync('./public')) {
    fs.mkdirSync('./public', { recursive: true });
}

// Write the HTML file
fs.writeFileSync('./public/index.html', indexHTML);

// API routes for web interface
app.get('/api/sessions', (req, res) => {
    try {
        const sessions = [];
        
        activeBots.forEach((bot, name) => {
            sessions.push({
                name,
                status: bot.status || 'unknown',
                jid: bot.jid || null,
                qrAvailable: !!bot.qrCode
            });
        });
        
        res.json(sessions);
    } catch (error) {
        console.error('Error getting sessions:', error);
        res.status(500).json({ success: false, message: 'Failed to get sessions' });
    }
});

app.post('/api/sessions', async (req, res) => {
    try {
        const { sessionName, authMethod, sessionId } = req.body;
        
        if (!sessionName) {
            return res.status(400).json({ success: false, message: 'Session name is required' });
        }
        
        if (activeBots.has(sessionName)) {
            return res.status(400).json({ success: false, message: 'Session name already exists' });
        }
        
        let useQR = authMethod === 'qr';
        let success;
        
        if (useQR) {
            // Create a temporary entry for this session
            activeBots.set(sessionName, {
                status: 'initializing',
                qrCode: null
            });
            
            success = await startBot(sessionName, null, true);
            
            // Wait a bit for QR code generation
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const botInfo = activeBots.get(sessionName);
            if (botInfo && botInfo.qrCode) {
                return res.json({ 
                    success: true, 
                    message: 'Session created with QR code', 
                    qrCode: botInfo.qrCode 
                });
            }
        } else {
            // Use session ID
            if (!sessionId) {
                return res.status(400).json({ success: false, message: 'Session ID is required' });
            }
            
            success = await startBot(sessionName, sessionId, false);
        }
        
        if (success) {
            res.json({ success: true, message: 'Session created successfully' });
        } else {
            // If we failed, clean up any partial session data
            if (activeBots.has(sessionName)) {
                activeBots.delete(sessionName);
            }
            
            const sessionDir = path.join(sessionsBaseDir, sessionName);
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            
            res.status(500).json({ success: false, message: 'Failed to create session' });
        }
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/sessions/:name/qr', (req, res) => {
    try {
        const sessionName = req.params.name;
        
        if (!activeBots.has(sessionName)) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        
        const botInfo = activeBots.get(sessionName);
        
        if (!botInfo.qrCode) {
            return res.status(404).json({ success: false, message: 'QR code not available for this session' });
        }
        
        res.json({ success: true, qrCode: botInfo.qrCode });
    } catch (error) {
        console.error('Error getting QR code:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/sessions/:name', (req, res) => {
    try {
        const sessionName = req.params.name;
        
        if (!activeBots.has(sessionName)) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        
        // Get the bot instance
        const botInfo = activeBots.get(sessionName);
        
        // If the bot has a socket, disconnect it
        if (botInfo.sock) {
            botInfo.sock.logout();
            botInfo.sock.end();
        }
        
        // Remove from active bots
        activeBots.delete(sessionName);
        
        // Delete session directory
        const sessionDir = path.join(sessionsBaseDir, sessionName);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        
        res.json({ success: true, message: 'Session deleted successfully' });
    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Main route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server and initialize existing sessions
app.listen(PORT, () => {
    console.log(chalk.green("🌐 Server is running on port " + PORT));
    console.log(chalk.blue("🌐 Web interface available at http://localhost:" + PORT));
    initExistingSessions();
});
