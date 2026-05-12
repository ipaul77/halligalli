const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};
const botAvatars = ['🤖', '👽', '👻', '🤡', '🎃'];

function initRoom(roomName) {
    return {
        name: roomName, players: [], deck: [], currentTurnIndex: 0,
        botCounter: 1, isGameRunning: false, tableCards: [],
        stateVersion: 0, turnId: 0,
        timeRemaining: 180, timerInterval: null,
        maxPlayers: 6,
        lastSuccessTime: 0 
    };
}

function broadcastRoomList() {
    const availableRooms = [];
    for (const roomId in rooms) {
        if (!rooms[roomId].isGameRunning) { 
            const host = rooms[roomId].players.find(p => p.isHost);
            availableRooms.push({ id: roomId, name: rooms[roomId].name, hostName: host ? host.name : '알 수 없음', playerCount: rooms[roomId].players.length });
        }
    }
    io.to('lobby').emit('roomList', availableRooms);
}

function createDeck() {
    const fruits = ['🍓', '🍌', '🍋', '🍇'];
    const counts = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5]; 
    let newDeck = [];
    for (let f of fruits) {
        for (let c of counts) newDeck.push({ fruit: f, count: c });
    }
    return newDeck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function broadcastGameState(roomId) {
    const room = rooms[roomId];
    if(!room || !room.isGameRunning || room.players.length === 0) return;
    
    room.stateVersion++; 
    
    room.players.forEach(player => {
        io.to(player.id).emit('updateGame', {
            currentTurnId: room.players[room.currentTurnIndex] ? room.players[room.currentTurnIndex].id : null,
            myHandCount: player.hand.length,
            playersInfo: room.players.map(p => ({ 
                id: p.id, name: p.name, avatar: p.avatar, 
                cardCount: p.hand.length, activeCard: p.activeCard, isHost: p.isHost 
            }))
        });
    });

    handleBotReactions(roomId, room.stateVersion);
}

function handleBotReactions(roomId, currentVersion) {
    const room = rooms[roomId];
    if (checkBellCondition(room)) {
        room.players.forEach(p => {
            const isOut = (p.hand.length === 0 && !p.activeCard);
            if (p.isBot && !isOut) {
                const minTime = 1300 - (p.difficulty * 220); 
                const maxTime = minTime + 300;
                const reactionTime = Math.random() * (maxTime - minTime) + minTime;
                
                setTimeout(() => {
                    if (rooms[roomId] && rooms[roomId].stateVersion === currentVersion) {
                        executeRingBell(roomId, p.id);
                    }
                }, reactionTime);
            }
        });
    }
}

function advanceTurn(roomId) {
    const room = rooms[roomId];
    if (!room || !room.isGameRunning) return;
    
    let nextIndex = room.currentTurnIndex;
    let attempts = 0;
    
    // 다음 턴을 찾되, 무한 루프(교착 상태)를 방지
    do {
        nextIndex = (nextIndex + 1) % room.players.length;
        attempts++;
    } while (room.players[nextIndex].hand.length === 0 && attempts < room.players.length);

    // 💡 아무도 낼 카드가 없는 무한 교착 상태 발생 시 게임 종료
    if (attempts >= room.players.length) {
        endGame(roomId);
        return;
    }

    room.currentTurnIndex = nextIndex;
    playCurrentTurn(roomId);
}

function playCurrentTurn(roomId) {
    const room = rooms[roomId];
    if (!room || !room.isGameRunning) return;

    const alivePlayers = room.players.filter(p => p.hand.length > 0 || p.activeCard);
    if (alivePlayers.length <= 1) {
        endGame(roomId);
        return;
    }

    room.turnId++; 
    broadcastGameState(roomId);

    const currentPlayer = room.players[room.currentTurnIndex];
    if (currentPlayer && currentPlayer.isBot && currentPlayer.hand.length > 0) {
        const currentTurnId = room.turnId;
        setTimeout(() => {
            if (rooms[roomId] && rooms[roomId].turnId === currentTurnId) {
                executeFlipCard(roomId, currentPlayer.id);
            }
        }, 1200); 
    }
}

function checkBellCondition(room) {
    let fruitTotals = { '🍓': 0, '🍌': 0, '🍋': 0, '🍇': 0 };
    room.players.forEach(p => {
        if (p.activeCard) fruitTotals[p.activeCard.fruit] += p.activeCard.count;
    });
    return Object.values(fruitTotals).includes(5);
}

function executeFlipCard(roomId, playerId) {
    const room = rooms[roomId];
    if (!room || !room.isGameRunning) return;
    
    const player = room.players[room.currentTurnIndex];
    if (player.id !== playerId || player.hand.length === 0) return;

    const flippedCard = player.hand.pop();
    if (player.activeCard) room.tableCards.push(player.activeCard); 
    player.activeCard = flippedCard; 
    
    io.to(roomId).emit('actionSound', 'flip');
    advanceTurn(roomId); 
}

function executeRingBell(roomId, playerId) {
    const room = rooms[roomId];
    if (!room || !room.isGameRunning) return;

    const ringer = room.players.find(p => p.id === playerId);
    if (!ringer) return;

    const isOut = (ringer.hand.length === 0 && !ringer.activeCard);
    if (isOut) return; 

    const isCorrect = checkBellCondition(room);
    const hasActiveCards = room.players.some(p => p.activeCard !== null);

    if (!hasActiveCards) return;

    if (!isCorrect && room.lastSuccessTime && (Date.now() - room.lastSuccessTime < 1500)) {
        return;
    }

    io.to(roomId).emit('actionSound', 'bell');

    if (isCorrect) {
        room.lastSuccessTime = Date.now(); 
        
        let wonCards = [...room.tableCards];
        room.tableCards = [];
        room.players.forEach(p => {
            if (p.activeCard) wonCards.push(p.activeCard);
            p.activeCard = null;
        });
        
        ringer.hand.unshift(...wonCards);
        io.to(roomId).emit('systemMessage', `🔔 딩동댕! ${ringer.name}님이 카드를 가져갑니다!`);
        io.to(roomId).emit('cardsWon', { targetId: ringer.id, count: wonCards.length });
        
        room.currentTurnIndex = room.players.indexOf(ringer);
        playCurrentTurn(roomId); 
    } else {
        let penaltyCount = 0;
        room.players.forEach(p => {
            const targetIsOut = (p.hand.length === 0 && !p.activeCard);
            if (p.id !== ringer.id && ringer.hand.length > 0 && !targetIsOut) {
                p.hand.unshift(ringer.hand.pop());
                penaltyCount++;
                io.to(roomId).emit('penaltyCardReceived', { targetId: p.id, count: 1 });
            }
        });
        io.to(roomId).emit('systemMessage', `❌ 땡! ${ringer.name}님이 페널티를 받습니다. (-${penaltyCount}장)`);
        io.to(roomId).emit('penaltyApplied', { targetId: ringer.id });

        const currentPlayer = room.players[room.currentTurnIndex];
        if (currentPlayer.hand.length === 0) {
            advanceTurn(roomId); 
        } else {
            broadcastGameState(roomId); 
        }
    }
}

function endGame(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    room.isGameRunning = false;
    
    if (room.timerInterval) {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
    }

    let winner = room.players.reduce((prev, current) => (prev.hand.length > current.hand.length) ? prev : current);
    room.players.forEach(p => { p.hand = []; p.activeCard = null; p.isReady = p.isHost || p.isBot; });

    io.to(roomId).emit('gameOver', winner.name);
    io.to(roomId).emit('updatePlayers', room.players);
    broadcastRoomList();
}

// 💡 유저 퇴장 로직을 통합하여 봇 예외 처리 및 진행 안정성 강화
function handlePlayerLeave(socket, roomId) {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    const pIdx = room.players.findIndex(p => p.id === socket.id);
    if (pIdx !== -1) {
        const leavingPlayer = room.players[pIdx];
        const wasHost = leavingPlayer.isHost;
        
        room.players.splice(pIdx, 1);
        socket.leave(roomId);
        socket.roomId = null; 

        const realPlayers = room.players.filter(p => !p.isBot);

        // 남은 인원이 없거나 봇만 남았다면 즉시 방 삭제
        if (realPlayers.length === 0) {
            if (room.timerInterval) clearInterval(room.timerInterval);
            delete rooms[roomId]; 
            broadcastRoomList();
            return;
        }

        if (wasHost && realPlayers.length > 0) {
            realPlayers[0].isHost = true;
            realPlayers[0].isReady = true;
            io.to(realPlayers[0].id).emit('hostPromoted');
        }

        if (room.isGameRunning) {
            const alivePlayers = room.players.filter(p => p.hand.length > 0 || p.activeCard);
            if (alivePlayers.length <= 1) {
                endGame(roomId);
            } else {
                // 게임 진행 중 남은 실제 플레이어가 있다면 턴 보정 후 이어나감
                if (room.currentTurnIndex === pIdx) {
                    room.currentTurnIndex = room.currentTurnIndex % room.players.length;
                    playCurrentTurn(roomId);
                } else if (room.currentTurnIndex > pIdx) {
                    room.currentTurnIndex--;
                    broadcastGameState(roomId);
                } else {
                    broadcastGameState(roomId);
                }
            }
        } else {
            io.to(roomId).emit('updatePlayers', room.players);
        }
        broadcastRoomList();
    }
}

io.on('connection', (socket) => {
    socket.join('lobby');
    broadcastRoomList();

    socket.on('createRoom', (data) => {
        const safeNickname = (data.nickname || '플레이어').trim().substring(0, 10);
        const roomId = 'room_' + Math.random().toString(36).substr(2, 6);
        rooms[roomId] = initRoom(data.roomName || `${safeNickname}의 테이블`);
        socket.leave('lobby'); socket.join(roomId); socket.roomId = roomId;
        rooms[roomId].players.push({ id: socket.id, name: safeNickname, avatar: data.avatar, hand: [], activeCard: null, isBot: false, isHost: true, isReady: true });
        socket.emit('joinSuccess', { isHost: true, roomName: rooms[roomId].name });
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        broadcastRoomList(); 
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (!room || room.isGameRunning) return socket.emit('joinError', '입장할 수 없습니다.');
        
        if (room.players.length >= room.maxPlayers) {
            const botIndex = room.players.findIndex(p => p.isBot);
            if (botIndex !== -1 && !room.isGameRunning) {
                room.players.splice(botIndex, 1); 
            } else {
                return socket.emit('joinError', `방이 최대 인원(${room.maxPlayers}명)으로 꽉 찼습니다.`);
            }
        }

        const safeNickname = (data.nickname || '플레이어').trim().substring(0, 10);
        socket.leave('lobby'); socket.join(data.roomId); socket.roomId = data.roomId;
        room.players.push({ id: socket.id, name: safeNickname, avatar: data.avatar, hand: [], activeCard: null, isBot: false, isHost: false, isReady: false });
        socket.emit('joinSuccess', { isHost: false, roomName: room.name });
        io.to(data.roomId).emit('updatePlayers', room.players);
        broadcastRoomList(); 
    });

    socket.on('toggleReady', () => {
        const room = rooms[socket.roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (player && !player.isHost && !room.isGameRunning) {
            player.isReady = !player.isReady;
            io.to(socket.roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('addBots', (data) => {
        const { count, difficulty } = data;
        const room = rooms[socket.roomId];
        if (!room) return;
        
        const availableSlots = room.maxPlayers - room.players.length;
        const botsToAdd = Math.min(count, availableSlots);
        
        for (let i = 0; i < botsToAdd; i++) {
            room.players.push({ 
                id: `bot_${Math.random()}`, 
                name: `할리 봇 Lv.${difficulty} (${room.botCounter++})`, 
                avatar: botAvatars[Math.floor(Math.random() * botAvatars.length)], 
                hand: [], activeCard: null, isBot: true, isHost: false, isReady: true,
                difficulty: difficulty 
            });
        }
        io.to(socket.roomId).emit('updatePlayers', room.players);
        broadcastRoomList();
    });

    socket.on('kickPlayer', (targetId) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const host = room.players.find(p => p.id === socket.id);
        if (!host || !host.isHost) return;

        const targetIndex = room.players.findIndex(p => p.id === targetId);
        if (targetIndex !== -1) {
            const targetPlayer = room.players[targetIndex];
            
            if (!targetPlayer.isBot) {
                io.to(targetPlayer.id).emit('kickedOut');
                const targetSocket = io.sockets.sockets.get(targetPlayer.id);
                if (targetSocket) {
                    targetSocket.leave(roomId);
                    targetSocket.roomId = null;
                }
            }
            
            room.players.splice(targetIndex, 1);
            
            const realPlayers = room.players.filter(p => !p.isBot);
            if (realPlayers.length === 0) {
                if (room.timerInterval) clearInterval(room.timerInterval);
                delete rooms[roomId]; 
                broadcastRoomList();
                return;
            }
            
            if (room.isGameRunning) {
                const alivePlayers = room.players.filter(p => p.hand.length > 0 || p.activeCard);
                if (alivePlayers.length <= 1) {
                    endGame(roomId);
                } else {
                    if (room.currentTurnIndex >= targetIndex) {
                        room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
                        advanceTurn(roomId);
                    } else {
                        broadcastGameState(roomId);
                    }
                }
            } else {
                io.to(roomId).emit('updatePlayers', room.players);
            }
            broadcastRoomList();
        }
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        
        room.deck = shuffle(createDeck());
        room.players.forEach(p => { p.hand = []; p.activeCard = null; });
        let dealIndex = 0;
        while(room.deck.length > 0) {
            room.players[dealIndex].hand.push(room.deck.pop());
            dealIndex = (dealIndex + 1) % room.players.length;
        }
        
        room.tableCards = []; room.currentTurnIndex = 0; room.isGameRunning = true; 
        room.stateVersion = 0; room.turnId = 0; room.lastSuccessTime = 0;
        
        room.timeRemaining = 180;
        if (room.timerInterval) clearInterval(room.timerInterval);
        room.timerInterval = setInterval(() => {
            room.timeRemaining--;
            io.to(socket.roomId).emit('updateTimer', room.timeRemaining);
            if (room.timeRemaining <= 0) endGame(socket.roomId);
        }, 1000);
        
        io.to(socket.roomId).emit('gameStarted');
        playCurrentTurn(socket.roomId); 
        broadcastRoomList(); 
    });

    socket.on('leaveRoom', () => {
        handlePlayerLeave(socket, socket.roomId);
    });

    socket.on('flipCard', () => executeFlipCard(socket.roomId, socket.id));
    socket.on('ringBell', () => executeRingBell(socket.roomId, socket.id));
    
    socket.on('disconnect', () => {
        let targetRoomId = null;
        for (const roomId in rooms) {
            if (rooms[roomId].players.some(p => p.id === socket.id)) {
                targetRoomId = roomId;
                break;
            }
        }
        if (targetRoomId) handlePlayerLeave(socket, targetRoomId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`할리갈리 서버 실행 중. 포트: ${PORT}`));