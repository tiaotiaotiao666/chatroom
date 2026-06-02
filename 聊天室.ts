import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ==================== 数据存储 ====================
// 用户数据文件路径
const USERS_FILE = path.join(__dirname, 'users.json');

// 用户数据结构
interface UserData {
    username: string;
    password: string; // 加密后的密码
    createdAt: string;
}

// 房间数据结构
interface Room {
    id: string;
    name: string;
    description: string;
    creator: string;
    members: Set<net.Socket>;
    createdAt: string;
}

// 客户端会话状态
interface ClientSession {
    socket: net.Socket;
    username: string | undefined;
    currentRoom: string | undefined;
    isAuthenticated: boolean;
    state: 'LOGIN' | 'REGISTER' | 'CHAT' | 'WAITING';
}

// ==================== 全局数据存储 ====================
const users: Map<string, UserData> = new Map(); // 用户名 -> 用户数据
const clients: Map<net.Socket, ClientSession> = new Map(); // socket -> 会话
const rooms: Map<string, Room> = new Map(); // 房间ID -> 房间

// ==================== 工具函数 ====================

// 加载用户数据
function loadUsers(): void {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf-8');
            const userDataArray: UserData[] = JSON.parse(data);
            userDataArray.forEach(user => {
                users.set(user.username, user);
            });
            console.log(`已加载 ${users.size} 个用户`);
        }
    } catch (err) {
        console.error('加载用户数据失败:', err);
    }
}

// 保存用户数据
function saveUsers(): void {
    try {
        const userDataArray = Array.from(users.values());
        fs.writeFileSync(USERS_FILE, JSON.stringify(userDataArray, null, 2), 'utf-8');
    } catch (err) {
        console.error('保存用户数据失败:', err);
    }
}

// 密码加密
function hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// 获取本地IP
function getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// 生成唯一房间ID
function generateRoomId(): string {
    return `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ==================== 消息广播函数 ====================

// 向房间内所有成员广播消息
function broadcastToRoom(roomId: string, message: string, excludeSocket?: net.Socket): void {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.members.forEach(client => {
        if (client !== excludeSocket && client.writable) {
            client.write(message);
        }
    });
}

// 发送私聊消息
function sendPrivateMessage(fromUsername: string, toUsername: string, message: string): boolean {
    // 查找目标用户
    let targetSocket: net.Socket | undefined;
    let targetRoom: string | undefined;
    
    for (const [socket, session] of clients.entries()) {
        if (session.username === toUsername && session.isAuthenticated) {
            targetSocket = socket;
            targetRoom = session.currentRoom;
            break;
        }
    }
    
    if (!targetSocket || !targetRoom) {
        return false;
    }
    
    // 检查是否在同一个房间
    const fromSession = Array.from(clients.values()).find(s => s.username === fromUsername);
    if (!fromSession || fromSession.currentRoom !== targetRoom) {
        return false;
    }
    
    // 发送私聊消息
    const privateMsg = `[私聊] ${fromUsername} -> 你: ${message}\n`;
    targetSocket.write(privateMsg);
    
    // 也发送给发送者确认
    for (const [socket, session] of clients.entries()) {
        if (session.username === fromUsername && socket.writable) {
            socket.write(`[私聊] 你 -> ${toUsername}: ${message}\n`);
            break;
        }
    }
    
    return true;
}

// ==================== 命令处理函数 ====================

// 处理注册命令
function handleRegister(socket: net.Socket, args: string[]): void {
    if (args.length < 2) {
        socket.write('[系统] 用法: /register 用户名 密码\n');
        return;
    }
    
    const username = args[0]!;
    const password = args[1]!;
    
    // 验证用户名
    if (username.length < 3 || username.length > 20) {
        socket.write('[系统] 用户名长度必须在3-20个字符之间\n');
        return;
    }
    
    // 检查用户名是否已存在
    if (users.has(username)) {
        socket.write('[系统] 该用户名已被注册，请更换用户名\n');
        return;
    }
    
    // 验证密码
    if (password.length < 6) {
        socket.write('[系统] 密码长度不能少于6个字符\n');
        return;
    }
    
    // 创建新用户
    const newUser: UserData = {
        username,
        password: hashPassword(password),
        createdAt: new Date().toISOString()
    };
    
    users.set(username, newUser);
    saveUsers();
    
    socket.write(`[系统] 注册成功！请使用 /login ${username} <密码> 登录\n`);
}

// 处理登录命令
function handleLogin(socket: net.Socket, args: string[]): void {
    if (args.length < 2) {
        socket.write('[系统] 用法: /login 用户名 密码\n');
        return;
    }
    
    const username = args[0]!;
    const password = args[1]!;
    
    const user = users.get(username);
    if (!user) {
        socket.write('[系统] 用户名不存在\n');
        return;
    }
    
    if (user.password !== hashPassword(password)) {
        socket.write('[系统] 密码错误\n');
        return;
    }
    
    // 检查是否已经在线
    for (const [sock, session] of clients.entries()) {
        if (session.username === username && session.isAuthenticated) {
            socket.write('[系统] 该账号已在其他地方登录\n');
            return;
        }
    }
    
    // 更新会话状态
    const session = clients.get(socket);
    if (session) {
        session.username = username;
        session.isAuthenticated = true;
        session.state = 'CHAT';
        
        // 自动加入默认房间
        joinRoom(socket, 'general');
        
        socket.write(`[系统] 登录成功！欢迎回来，${username}\n`);
        showHelp(socket);
    }
}

// 加入房间
function joinRoom(socket: net.Socket, roomId: string): void {
    const session = clients.get(socket);
    if (!session || !session.isAuthenticated) {
        socket.write('[系统] 请先登录\n');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        socket.write('[系统] 房间不存在\n');
        return;
    }
    
    // 离开当前房间
    if (session.currentRoom) {
        const currentRoom = rooms.get(session.currentRoom);
        if (currentRoom) {
            currentRoom.members.delete(socket);
            const username = session.username || '未知用户';
            broadcastToRoom(session.currentRoom, `[系统] ${username} 离开了房间\n`, socket);
        }
    }
    
    // 加入新房间
    session.currentRoom = roomId;
    room.members.add(socket);
    
    const username = session.username || '未知用户';
    socket.write(`[系统] 已加入房间: ${room.name}\n`);
    socket.write(`[系统] ${room.description}\n`);
    
    // 通知房间内其他成员
    broadcastToRoom(roomId, `[系统] ${username} 加入了房间\n`, socket);
    
    // 显示房间内在线用户
    const onlineUsers = Array.from(room.members)
        .map(s => {
            const s_session = clients.get(s);
            return s_session?.username;
        })
        .filter(Boolean);
    
    socket.write(`[系统] 房间内在线用户 (${onlineUsers.length}人): ${onlineUsers.join(', ')}\n`);
}

// 创建房间
function createRoom(socket: net.Socket, args: string[]): void {
    const session = clients.get(socket);
    if (!session || !session.isAuthenticated) {
        socket.write('[系统] 请先登录\n');
        return;
    }
    
    if (args.length < 1) {
        socket.write('[系统] 用法: /createroom 房间名称 [房间描述]\n');
        return;
    }
    
    const roomName = args[0]!;
    const description = args.slice(1).join(' ') || '暂无描述';
    const roomId = generateRoomId();
    const creator = session.username || 'system';
    
    const newRoom: Room = {
        id: roomId,
        name: roomName,
        description,
        creator,
        members: new Set(),
        createdAt: new Date().toISOString()
    };
    
    rooms.set(roomId, newRoom);
    
    socket.write(`[系统] 房间创建成功！房间ID: ${roomId}\n`);
    
    // 自动加入新创建的房间
    joinRoom(socket, roomId);
}

// 列出所有房间
function listRooms(socket: net.Socket): void {
    socket.write('[系统] === 房间列表 ===\n');
    rooms.forEach((room, roomId) => {
        const memberCount = room.members.size;
        const isCurrent = clients.get(socket)?.currentRoom === roomId ? ' [当前]' : '';
        socket.write(`  ${room.name} (${memberCount}人) - ${room.description}${isCurrent}\n`);
    });
    socket.write('[系统] ================\n');
}

// 显示帮助信息
function showHelp(socket: net.Socket): void {
    socket.write('[系统] === 可用命令 ===\n');
    socket.write('  账户管理:\n');
    socket.write('    /register <用户名> <密码> - 注册新账号\n');
    socket.write('    /login <用户名> <密码>    - 登录账号\n');
    socket.write('    /logout                   - 退出登录\n');
    socket.write('  \n');
    socket.write('  聊天功能:\n');
    socket.write('    /msg <用户名> <消息>      - 私聊\n');
    socket.write('    /users                    - 查看当前房间在线用户\n');
    socket.write('    /allusers                 - 查看所有在线用户\n');
    socket.write('  \n');
    socket.write('  房间管理:\n');
    socket.write('    /rooms                    - 列出所有房间\n');
    socket.write('    /createroom <名称> [描述] - 创建新房间\n');
    socket.write('    /join <房间ID>            - 加入房间\n');
    socket.write('  \n');
    socket.write('  其他:\n');
    socket.write('    /help                     - 显示帮助信息\n');
    socket.write('    /quit 或 /exit            - 退出聊天室\n');
    socket.write('[系统] ================\n');
}

// ==================== TCP 消息缓冲处理 ====================
// TCP 是流式协议，需要处理消息边界
interface ClientBuffer {
    buffer: string;
}

const clientBuffers: Map<net.Socket, ClientBuffer> = new Map();

/**
 * 处理 TCP 数据流
 * TCP 不保证消息边界，可能分包或粘包
 * 我们使用 \n 作为消息分隔符
 */
function processData(socket: net.Socket, data: Buffer | string): void {
    let clientBuffer = clientBuffers.get(socket);
    if (!clientBuffer) {
        clientBuffer = { buffer: '' };
        clientBuffers.set(socket, clientBuffer);
    }
    
    clientBuffer.buffer += data.toString();
    
    // 按换行符分割消息
    let newlineIndex: number;
    while ((newlineIndex = clientBuffer.buffer.indexOf('\n')) !== -1) {
        // 提取完整消息
        const message = clientBuffer.buffer.substring(0, newlineIndex);
        clientBuffer.buffer = clientBuffer.buffer.substring(newlineIndex + 1);
        
        if (message.trim()) {
            handleMessage(socket, message.trim());
        }
    }
}

/**
 * 处理单条消息
 */
function handleMessage(socket: net.Socket, msg: string): void {
    const session = clients.get(socket);
    if (!session) return;
    
    // ==================== 心跳处理 ====================
    if (msg === 'PING') {
        socket.write('PONG\n');
        return;
    }
    
    // 解析命令和参数
    const parts = msg.split(/\s+/);
    const command = parts[0]?.toLowerCase() || '';
    const args = parts.slice(1);
    
    // ==================== 认证相关命令 ====================
    
    if (command === '/register') {
        handleRegister(socket, args);
        return;
    }
    
    if (command === '/login') {
        handleLogin(socket, args);
        return;
    }
    
    if (command === '/logout') {
        if (session.isAuthenticated) {
            if (session.currentRoom) {
                const room = rooms.get(session.currentRoom);
                if (room) {
                    room.members.delete(socket);
                    const username = session.username || '未知用户';
                    broadcastToRoom(session.currentRoom, `[系统] ${username} 离开了房间\n`, socket);
                }
            }
            
            session.username = undefined;
            session.currentRoom = undefined;
            session.isAuthenticated = false;
            session.state = 'LOGIN';
            
            socket.write('[系统] 已退出登录\n');
            socket.write('请使用 /login 或 /register 继续\n');
        } else {
            socket.write('[系统] 您尚未登录\n');
        }
        return;
    }
    
    // ==================== 需要登录才能使用的命令 ====================
    
    if (!session.isAuthenticated) {
        socket.write('[系统] 请先登录或使用 /register 注册账号\n');
        return;
    }
    
    // ==================== 聊天和房间命令 ====================
    
    if (command === '/quit' || command === '/exit') {
        const username = session.username || '未知用户';
        
        if (session.currentRoom) {
            const room = rooms.get(session.currentRoom);
            if (room) {
                room.members.delete(socket);
                broadcastToRoom(session.currentRoom, `[系统] ${username} 离开了聊天室\n`, socket);
            }
        }
        
        console.log(`${username} 退出了聊天室`);
        clients.delete(socket);
        clientBuffers.delete(socket);
        
        socket.write('[系统] 再见！\n');
        socket.end();
        return;
    }
    
    if (command === '/help') {
        showHelp(socket);
        return;
    }
    
    if (command === '/users') {
        const roomId = session.currentRoom;
        if (!roomId) {
            socket.write('[系统] 您还未加入任何房间\n');
            return;
        }
        
        const room = rooms.get(roomId);
        if (!room) {
            socket.write('[系统] 房间不存在\n');
            return;
        }
        
        const onlineUsers = Array.from(room.members)
            .map(s => {
                const s_session = clients.get(s);
                return s_session?.username;
            })
            .filter(Boolean);
        
        socket.write(`[系统] 当前房间在线用户 (${onlineUsers.length}人): ${onlineUsers.join(', ')}\n`);
        return;
    }
    
    if (command === '/allusers') {
        const onlineUsers: string[] = [];
        clients.forEach((s) => {
            if (s.isAuthenticated && s.username) {
                onlineUsers.push(s.username);
            }
        });
        socket.write(`[系统] 所有在线用户 (${onlineUsers.length}人): ${onlineUsers.join(', ')}\n`);
        return;
    }
    
    if (command === '/rooms') {
        listRooms(socket);
        return;
    }
    
    if (command === '/createroom') {
        createRoom(socket, args);
        return;
    }
    
    if (command === '/join') {
        if (args.length < 1) {
            socket.write('[系统] 用法: /join <房间ID>\n');
            return;
        }
        const roomId = args[0]!;
        joinRoom(socket, roomId);
        return;
    }
    
    if (command === '/msg') {
        if (args.length < 2) {
            socket.write('[系统] 用法: /msg <用户名> <消息内容>\n');
            return;
        }
        
        const targetUsername = args[0]!;
        const message = args.slice(1).join(' ');
        
        if (targetUsername === session.username) {
            socket.write('[系统] 不能给自己发送私聊消息\n');
            return;
        }
        
        const fromUsername = session.username || '未知用户';
        const success = sendPrivateMessage(fromUsername, targetUsername, message);
        if (!success) {
            socket.write(`[系统] 用户 ${targetUsername} 不在线或不在同一房间\n`);
        }
        return;
    }
    
    // ==================== 普通聊天消息 ====================
    
    if (!session.currentRoom) {
        socket.write('[系统] 您还未加入任何房间，请使用 /join <房间ID> 加入房间\n');
        return;
    }
    
    const username = session.username || '未知用户';
    console.log(`[${username}] ${msg}`);
    
    const broadcastMsg = `[${username}] ${msg}\n`;
    broadcastToRoom(session.currentRoom, broadcastMsg, socket);
    socket.write(broadcastMsg);
}

const server = net.createServer((socket) => {
    const session: ClientSession = {
        socket,
        username: undefined,
        currentRoom: undefined,
        isAuthenticated: false,
        state: 'LOGIN'
    };
    clients.set(socket, session);
    
    socket.on('data', (data) => {
        processData(socket, data);
    });
    
    socket.on('end', () => {
        console.log(`客户端 ${socket.remoteAddress}:${socket.remotePort} 断开连接`);
        clients.delete(socket);
        clientBuffers.delete(socket);
    });
});

server.listen(8080, () => {
    console.log(`服务器已启动，监听地址: ${getLocalIP()}:8080`);
});

server.on('error', (err) => {
    console.error(`服务器错误: ${err.message}`);
});

process.on('SIGINT', () => {
    console.log('\n服务器正在关闭...');
    
    // 保存用户数据
    saveUsers();
    
    // 通知所有客户端
    clients.forEach((session, socket) => {
        socket.write('[系统] 服务器正在关闭，请稍后重连\n');
        socket.end();
    });
    
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

